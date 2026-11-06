/** Local Studio adapter for the pinned PocketJS companion's Codex transport.
 * Authentication belongs to Codex itself: never read/copy auth.json or expose
 * tokens to the HTTP client. Unlike companion's isolated console, Studio needs
 * the user's existing provider and managed credential configuration.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePrebuiltTools } from "../scripts/prebuilt_tools.mjs";

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamRoot = process.env.POCKET_UPSTREAM_ROOT || (process.env.POCKET_SOURCE_BUILD === "1"
  ? join(sdkRoot, ".cache", "pocketjs")
  : resolvePrebuiltTools(sdkRoot).compiler);
const { CodexClient, findCodex, userCodexHome } = await import(pathToFileURL(join(upstreamRoot, "tools", "companion", "codex.ts")).href);
type CodexClient = InstanceType<typeof CodexClient>;

type Json = Record<string, any>;
type Rpc = Pick<CodexClient, "request" | "onNotification" | "onExit" | "handleRequests" | "stop">;
export type StudioScope = "project" | "sdk";
export type StudioReasoningEffort = { reasoningEffort: string; description: string };
export type StudioModel = {
  id: string;
  displayName: string;
  inputModalities: string[];
  isDefault: boolean;
  supportedReasoningEfforts: StudioReasoningEffort[];
  defaultReasoningEffort?: string;
};
export type StudioTurn = {
  id: string; projectId: string; scope: StudioScope; threadId?: string;
  status: "starting" | "running" | "completed" | "failed" | "cancelled";
  text: string; error?: string; events: Array<{ type: string; text: string }>;
  startedAt: string; finishedAt?: string;
};
type TurnState = StudioTurn & {
  remoteTurnId?: string;
  timer?: ReturnType<typeof setTimeout>;
  cancelFallbackTimer?: ReturnType<typeof setTimeout>;
  temporaryDirectory?: string;
  cancelRequested?: boolean;
  finishing?: boolean;
  finishPromise?: Promise<void>;
  finishWaiters: Array<() => void>;
  agentItems: Map<string, string>;
};
export type StudioExecutionContext = {
  scope: StudioScope;
  cwd: string;
  writableRoots: string[];
  developerInstructions: string;
};
export type StudioCodexOptions = {
  projectDirectory: (id: string) => string;
  /** Resolve a server-owned scope; the browser supplies only the scope name. */
  resolveContext?: (id: string, scope: StudioScope) => StudioExecutionContext;
  /** Only injected by transport tests; production uses the pinned client. */
  client?: Rpc;
  onChanged?: (projectId: string) => Promise<void>;
  turnTimeoutMs?: number;
  cancelFallbackMs?: number;
};

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 32 * 1024;
const MAX_OUTPUT = 512 * 1024;
const MAX_TURNS = 50;
const active = (turn: StudioTurn) => turn.status === "starting" || turn.status === "running";
const busy = (turn: TurnState) => active(turn) || turn.finishing === true;

export function validateStudioInput(value: Json): { text: string; model?: string; effort?: string; scope: StudioScope; threadId?: string; images: Array<{ data: Buffer; extension: string }>; annotation?: Json } {
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT) throw new Error("message exceeds 32 KiB");
  if (value.model !== undefined && (typeof value.model !== "string" || value.model.length > 160)) throw new Error("invalid model");
  if (value.effort !== undefined && value.effort !== null && (typeof value.effort !== "string" || value.effort.length === 0 || value.effort.length > 160)) throw new Error("invalid reasoning effort");
  const scope = value.scope === undefined ? "project" : value.scope;
  if (scope !== "project" && scope !== "sdk") throw new Error("invalid editor scope");
  if (value.threadId !== undefined && (typeof value.threadId !== "string" || value.threadId.length > 160)) throw new Error("invalid thread id");
  const rawImages = value.images ?? [];
  if (!Array.isArray(rawImages) || rawImages.length > MAX_IMAGES) throw new Error("at most four images are allowed");
  let total = 0;
  const images = rawImages.map((image) => {
    const url = image?.dataUrl;
    if (typeof url !== "string" || url.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 80) throw new Error("invalid or oversized image");
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
    if (!match || match[2].length % 4 !== 0) throw new Error("images must be PNG, JPEG or WebP base64 data URLs");
    const data = Buffer.from(match[2], "base64");
    total += data.length;
    if (!data.length || total > MAX_IMAGE_BYTES) throw new Error("image attachments exceed 8 MiB");
    const kind = match[1];
    const valid = kind === "png" ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : kind === "jpeg" ? data[0] === 255 && data[1] === 216 && data[2] === 255
      : data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP";
    if (!valid) throw new Error("image contents do not match MIME type");
    return { data, extension: kind === "jpeg" ? "jpg" : kind };
  });
  let annotation: Json | undefined;
  if (value.annotation !== undefined) {
    const raw = value.annotation;
    const rect = raw?.rect;
    const viewport = raw?.viewport;
    if (!rect || !viewport || ![rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height].every((n) => typeof n === "number" && Number.isFinite(n))
      || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || viewport.width <= 0 || viewport.height <= 0
      || viewport.width > 16384 || viewport.height > 16384 || rect.x + rect.width > viewport.width + 1 || rect.y + rect.height > viewport.height + 1) {
      throw new Error("invalid annotation rectangle or viewport");
    }
    if (!images.length) throw new Error("a region annotation requires its screenshot attachment");
    annotation = { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport: { width: viewport.width, height: viewport.height }, text: String(raw.text ?? "").slice(0, 2000) };
  }
  if (!text && !images.length) throw new Error("message or image is required");
  return { text, model: value.model, effort: value.effort == null ? undefined : value.effort, scope, threadId: value.threadId, images, annotation };
}

export function createStudioCodex(options: StudioCodexOptions) {
  const bin = options.client ? "test-transport" : findCodex();
  const client: Rpc | undefined = options.client ?? (bin ? new CodexClient({
    bin, home: userCodexHome(), clientName: "pocket_studio", version: "0.1.0",
    args: ["--disable", "multi_agent", "--disable", "hooks", "--disable", "apps", "--disable", "plugins"],
  }) : undefined);
  const turns = new Map<string, TurnState>();
  const threads = new Map<string, { projectId: string; scope: StudioScope }>();
  const projectsStarting = new Set<string>();
  let modelCache: { at: number; models: StudioModel[] } | undefined;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  async function stopClient(): Promise<void> {
    try {
      await client?.stop();
    } catch {
      // The child may already have exited. The caller still treats the
      // transport as unusable and keeps the turn busy until finalization.
    }
  }

  async function rpc(method: string, params: Json, timeoutMs = 30_000): Promise<Json> {
    if (disposed || !client) throw new Error(disposed ? "Codex adapter is closed" : "Codex CLI is not installed");
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([client.request(method, params), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void stopClient();
          reject(new Error(`Codex ${method} timed out`));
        }, timeoutMs);
      })]);
    } finally { clearTimeout(timer!); }
  }
  function snapshot(turn: TurnState): StudioTurn {
    return { id: turn.id, projectId: turn.projectId, scope: turn.scope, threadId: turn.threadId, status: turn.status, text: turn.text, error: turn.error, events: turn.events.map((e) => ({ ...e })), startedAt: turn.startedAt, finishedAt: turn.finishedAt };
  }
  function log(turn: TurnState, type: string, text: string) {
    turn.events.push({ type, text: text.slice(0, 1200) });
    if (turn.events.length > 100) turn.events.shift();
  }
  function waitForFinish(turn: TurnState): Promise<void> {
    if (!busy(turn)) return Promise.resolve();
    return new Promise((resolve) => turn.finishWaiters.push(resolve));
  }
  function finish(turn: TurnState, status: StudioTurn["status"], error?: string): Promise<void> {
    if (turn.finishing) return turn.finishPromise ?? Promise.resolve();
    if (!active(turn)) return Promise.resolve();
    turn.finishing = true;
    clearTimeout(turn.timer);
    clearTimeout(turn.cancelFallbackTimer);
    const temporaryDirectory = turn.temporaryDirectory;
    turn.temporaryDirectory = undefined;
    const promise = (async () => {
      try {
        // Keep the turn visibly busy until the server has persisted its
        // revision invalidation. This prevents a terminal response from
        // racing an immediate save/build request.
        try {
          await options.onChanged?.(turn.projectId);
        } catch {
          // A failed state write must not leave the Codex turn permanently
          // active; the server will report its normal terminal status.
        }
        turn.status = status;
        turn.error = error?.slice(0, 2000);
        turn.finishedAt = new Date().toISOString();
        // Completion normally proves the model stopped reading attachments.
        // Cancellation fallback/dispose request transport stop before
        // reaching here; the pinned client exposes best-effort stop only, so
        // this ordering is a cleanup boundary rather than an OS-level proof.
        if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
      } finally {
        turn.finishing = false;
        const waiters = turn.finishWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    })();
    turn.finishPromise = promise;
    return promise;
  }
  function scheduleCancelFallback(turn: TurnState): void {
    if (turn.cancelFallbackTimer || turn.finishing || !active(turn)) return;
    const delay = Math.max(0, options.cancelFallbackMs ?? 3_000);
    turn.cancelFallbackTimer = setTimeout(() => {
      turn.cancelFallbackTimer = undefined;
      void (async () => {
        if (turn.finishing || !active(turn)) return;
        // A successful interrupt should produce turn/completed. If that proof
        // is absent after the bounded grace period, stop the owned transport
        // before releasing this project lock; otherwise tools could still
        // write files after the UI sees cancellation. Stopping the shared
        // transport can affect every active turn, so report failure rather
        // than claiming an unproved cancellation.
        await stopClient();
        if (turn.finishing) {
          await turn.finishPromise;
        } else if (active(turn)) {
          await finish(turn, "failed", "Codex app-server stopped before cancellation completed; start a new conversation");
        }
      })().catch(() => {});
    }, delay);
    turn.cancelFallbackTimer.unref?.();
  }
  client?.handleRequests(async (request) => {
    // Never auto-approve a sandbox escape or expose local auth refresh tokens.
    if (request.method.endsWith("requestApproval")) return { decision: "decline" };
    throw new Error("This local editor does not support interactive elevation; keep changes in the selected project.");
  });
  const removeExit = client?.onExit(() => {
    threads.clear();
    for (const turn of turns.values()) {
      if (turn.finishing || !active(turn)) continue;
      void finish(turn, "failed", turn.cancelRequested ? "Codex app-server stopped before cancellation completed; start a new conversation" : "Codex app-server exited; start a new conversation");
    }
  });
  const removeNotification = client?.onNotification(({ method, params }) => {
    // Only forward conversation output, never raw account/auth notifications.
    const turn = [...turns.values()].find((candidate) => active(candidate) && !candidate.finishing && candidate.threadId === params.threadId);
    const eventTurnId = params.turnId ?? params.turn?.id;
    if (!turn || (turn.remoteTurnId && eventTurnId && turn.remoteTurnId !== eventTurnId)) return;
    if (method === "turn/started") {
      turn.remoteTurnId = params.turn?.id ?? turn.remoteTurnId;
      turn.status = "running";
    } else if (method === "item/agentMessage/delta") {
      const key = String(params.itemId ?? "message");
      const previous = turn.agentItems.get(key) ?? "";
      turn.agentItems.set(key, (previous + String(params.delta ?? "")).slice(0, MAX_OUTPUT));
      if (turn.agentItems.size > 64) turn.agentItems.delete(turn.agentItems.keys().next().value!);
      turn.text = [...turn.agentItems.values()].join("\n\n").slice(0, MAX_OUTPUT);
    } else if (method === "item/completed" && params.item?.type === "agentMessage") {
      turn.agentItems.set(String(params.item.id), String(params.item.text ?? "").slice(0, MAX_OUTPUT));
      if (turn.agentItems.size > 64) turn.agentItems.delete(turn.agentItems.keys().next().value!);
      turn.text = [...turn.agentItems.values()].join("\n\n").slice(0, MAX_OUTPUT);
    } else if (method === "item/started" || method === "item/completed") {
      if (params.item?.type === "fileChange" || params.item?.type === "commandExecution") log(turn, params.item.type, `${method.endsWith("started") ? "Started" : "Finished"}: ${String(params.item.command ?? params.item.type)}`);
    } else if (method === "turn/completed") {
      const status = params.turn?.status;
      void finish(turn, status === "completed" ? "completed" : status === "interrupted" ? "cancelled" : "failed", params.turn?.error?.message);
    } else if (method === "error" && params.willRetry !== true) {
      void finish(turn, "failed", String(params.error?.message ?? "Codex turn failed"));
    }
  });

  async function models(): Promise<{ models: StudioModel[] }> {
    if (modelCache && Date.now() - modelCache.at < 5 * 60_000) return { models: modelCache.models };
    const result: StudioModel[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = await rpc("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const value of response.data ?? []) {
        if (typeof value.model !== "string" || value.hidden === true) continue;
        const supportedReasoningEfforts = Array.isArray(value.supportedReasoningEfforts)
          ? value.supportedReasoningEfforts
            .filter((entry: any) => typeof entry?.reasoningEffort === "string" && entry.reasoningEffort.length > 0)
            .map((entry: any) => ({ reasoningEffort: entry.reasoningEffort, description: String(entry.description ?? "") }))
          : [];
        const defaultReasoningEffort = typeof value.defaultReasoningEffort === "string" && supportedReasoningEfforts.some((entry) => entry.reasoningEffort === value.defaultReasoningEffort)
          ? value.defaultReasoningEffort
          : undefined;
        result.push({ id: value.model, displayName: String(value.displayName ?? value.model), inputModalities: Array.isArray(value.inputModalities) ? value.inputModalities : ["text"], isDefault: value.isDefault === true, supportedReasoningEfforts, ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}) });
      }
      cursor = response.nextCursor;
      if (!cursor) break;
    }
    modelCache = { at: Date.now(), models: result };
    return { models: result };
  }
  async function status() {
    if (!client) return { available: false, authenticated: false, error: "Install Codex CLI and sign in locally" };
    try {
      const result = await rpc("account/read", { refreshToken: false });
      return { available: true, authenticated: !!result.account || result.requiresOpenaiAuth === false, authMode: result.account?.type ?? "configured-provider", requiresOpenaiAuth: result.requiresOpenaiAuth === true };
    } catch (error) { return { available: true, authenticated: false, error: error instanceof Error ? error.message : "Codex is unavailable" }; }
  }
  function get(projectId: string, id: string): StudioTurn {
    const turn = turns.get(id);
    if (!turn || turn.projectId !== projectId) throw new Error("conversation turn not found");
    return snapshot(turn);
  }
  async function cancel(projectId: string, id: string): Promise<StudioTurn> {
    const turn = turns.get(id);
    if (!turn || turn.projectId !== projectId) throw new Error("conversation turn not found");
    if (turn.finishing) {
      await waitForFinish(turn);
      return snapshot(turn);
    }
    if (active(turn)) {
      turn.cancelRequested = true;
      // Always install the bounded fallback, including a turn that is still
      // waiting for thread/start. There is no completion proof in that case.
      scheduleCancelFallback(turn);
      if (turn.threadId && turn.remoteTurnId) {
        // Do not make the HTTP cancellation wait on an RPC response that may
        // be lost with the completion event. The completion/fallback promise
        // below is the bounded lifecycle; an interrupt error is not proof
        // that the model stopped writing.
        void rpc("turn/interrupt", { threadId: turn.threadId, turnId: turn.remoteTurnId }).catch(() => {});
      }
      await waitForFinish(turn);
    }
    return snapshot(turn);
  }
  async function start(projectId: string, raw: Json): Promise<StudioTurn> {
    const input = validateStudioInput(raw);
    const context = options.resolveContext?.(projectId, input.scope) ?? (() => {
      const projectDirectory = options.projectDirectory(projectId);
      return {
        scope: "project" as const,
        cwd: projectDirectory,
        writableRoots: [projectDirectory],
        developerInstructions: "You are editing the currently selected Pocket Studio JS project. Modify only this project; preserve user changes. Do not create subagents, read credentials, run deployment, publish, or change files outside this project. Explain changes and test results.",
      };
    })();
    if (context.scope !== input.scope || !context.cwd || !context.writableRoots.length || context.writableRoots.some((path) => typeof path !== "string" || !path)) throw new Error("editor scope is not available");
    const lockKey = input.scope === "sdk" ? "sdk" : `project:${projectId}`;
    const sdkBusy = projectsStarting.has("sdk") || [...turns.values()].some((turn) => turn.scope === "sdk" && busy(turn));
    const projectBusy = projectsStarting.has(lockKey) || [...turns.values()].some((t) => t.projectId === projectId && busy(t));
    if ((input.scope === "sdk" && (projectsStarting.size > 0 || [...turns.values()].some(busy))) || (input.scope === "project" && (sdkBusy || projectBusy))) throw new Error(input.scope === "sdk" ? "a Codex turn is already running; wait for it to finish before editing the SDK" : "a Codex turn is already running for this project");
    if ([...turns.values()].filter(busy).length + projectsStarting.size >= 3) throw new Error("too many active Codex turns");
    projectsStarting.add(lockKey);
    try {
      const account = await status();
      if (!account.authenticated) throw new Error(account.error ?? "Sign in using the local Codex CLI first");
      const catalog = (await models()).models;
      const selected = input.model ? catalog.find((model) => model.id === input.model) : catalog.find((model) => model.isDefault) ?? catalog[0];
      if (!selected) throw new Error("selected model is not available in the local Codex catalog");
      if (input.images.length && !selected.inputModalities.includes("image")) throw new Error("selected model does not support images");
      if (input.effort && !selected.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === input.effort)) throw new Error(`reasoning effort "${input.effort}" is not supported by selected model`);
      const threadOwner = input.threadId ? threads.get(input.threadId) : undefined;
      if (input.threadId && (!threadOwner || threadOwner.projectId !== projectId || threadOwner.scope !== input.scope)) throw new Error("conversation does not belong to this project and scope or the server restarted; start a new conversation");
      while (turns.size >= MAX_TURNS) {
        const oldest = [...turns.values()].find((t) => !busy(t));
        if (!oldest) throw new Error("conversation history is full");
        turns.delete(oldest.id);
        if (oldest.threadId && ![...turns.values()].some((t) => t.threadId === oldest.threadId)) threads.delete(oldest.threadId);
      }
      const turn: TurnState = { id: randomUUID(), projectId, scope: input.scope, threadId: input.threadId, status: "starting", text: "", events: [], finishWaiters: [], agentItems: new Map(), startedAt: new Date().toISOString() };
      turns.set(turn.id, turn);
      turn.timer = setTimeout(() => { void cancel(projectId, turn.id).catch(() => {}); setTimeout(() => { if (active(turn)) { void stopClient(); void finish(turn, "failed", "Codex turn exceeded its time limit"); } }, 10_000).unref(); }, options.turnTimeoutMs ?? 10 * 60_000);
      turn.timer.unref();
      void (async () => {
        try {
          if (!turn.threadId) {
            const response = await rpc("thread/start", {
              cwd: context.cwd, model: selected.id, sandbox: "workspace-write", approvalPolicy: "never",
              developerInstructions: context.developerInstructions,
            }, 90_000);
            turn.threadId = response.thread.id;
            threads.set(turn.threadId!, { projectId, scope: input.scope });
          }
          if (turn.cancelRequested) { void finish(turn, "cancelled"); return; }
          const content: Json[] = [{ type: "text", text: input.text + (input.annotation ? `\n\nPreview region (pixels in the attached screenshot; top-left origin): ${JSON.stringify(input.annotation)}` : "") }];
          if (input.images.length) {
            turn.temporaryDirectory = await mkdtemp(join(tmpdir(), "pocket-studio-images-"));
            for (let index = 0; index < input.images.length; index++) {
              const image = input.images[index];
              const path = join(turn.temporaryDirectory, `${index}.${image.extension}`);
              await writeFile(path, image.data, { mode: 0o600 });
              content.push({ type: "localImage", path });
            }
          }
          const response = await rpc("turn/start", { threadId: turn.threadId, model: selected.id, ...(input.effort ? { effort: input.effort } : {}), cwd: context.cwd, approvalPolicy: "never", sandboxPolicy: { type: "workspaceWrite", writableRoots: context.writableRoots, networkAccess: false }, input: content }, 90_000);
          turn.remoteTurnId = response.turn.id;
          if (active(turn)) turn.status = "running";
          if (turn.cancelRequested && active(turn)) await cancel(projectId, turn.id);
        } catch (error) { void finish(turn, "failed", error instanceof Error ? error.message : "Codex request failed"); }
      })();
      return snapshot(turn);
    } finally { projectsStarting.delete(lockKey); }
  }
  async function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    disposed = true;
    removeNotification?.(); removeExit?.();
    disposePromise = (async () => {
      // Request app-server stop before deleting localImage attachments. The
      // pinned client exposes best-effort stop only; keep this ordering
      // explicit without claiming an OS-level process-exit proof.
      await stopClient();
      await Promise.all([...turns.values()].filter(active).map((turn) => finish(turn, "cancelled")));
    })();
    return disposePromise;
  }
  return { status, models, start, get, cancel, dispose, isBusy: (projectId: string) => projectsStarting.has("sdk") || projectsStarting.has(`project:${projectId}`) || [...turns.values()].some((turn) => busy(turn) && (turn.scope === "sdk" || turn.projectId === projectId)) };
}
