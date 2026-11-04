import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultScriptPath = join(sdkRoot, "scripts/preview_wechat.ts");
const projectIdPattern = /^[a-z][a-z0-9-]{0,47}$/;
const maxLogLines = 1000;
const maxLogLineBytes = 8 * 1024;
const previewUrlPrefix = "POCKET_WECHAT_PREVIEW_URL=";
const stopGraceMs = 1_500;

export type WechatPreviewTarget = { id: string; label: string; appId: string };
export type WechatPreviewLifecycle = "idle" | "building" | "running" | "error" | "stopped";
export type WechatPreviewState = {
  state: WechatPreviewLifecycle;
  targetId?: string;
  url?: string;
  error?: string;
  logs: string[];
};
export type WechatPreviewSnapshot = { targets: WechatPreviewTarget[]; state: WechatPreviewState };

export type WechatPreviewProcess = {
  pid?: number;
  stdout?: unknown;
  stderr?: unknown;
  exited: Promise<number>;
  kill: (signal?: string | number) => void;
};
export type WechatPreviewSpawnOptions = {
  cwd: string;
  stdout: "pipe";
  stderr: "pipe";
  detached: boolean;
};
export type WechatPreviewSpawn = (
  argv: readonly string[],
  options: WechatPreviewSpawnOptions,
) => WechatPreviewProcess;
export type WechatPreviewManagerOptions = {
  projectDirectory: (id: string) => string;
  workspaceRoot: string;
  scriptPath?: string;
  /** Test/embedding seam. Production uses Bun.spawn with a detached group. */
  spawn?: WechatPreviewSpawn;
  /** Test seam for deterministic unique workspace names. */
  idFactory?: () => string;
};

export interface WechatPreviewManager {
  status(id: string): Promise<WechatPreviewSnapshot>;
  isBuilding(id: string): boolean;
  start(id: string, targetId?: string): Promise<WechatPreviewSnapshot>;
  stop(id: string): Promise<WechatPreviewSnapshot>;
  dispose(): void;
}

export type WechatPreviewErrorCode =
  | "manager_disposed"
  | "invalid_project_id"
  | "invalid_workspace_root"
  | "invalid_project_root"
  | "invalid_target_manifest"
  | "target_not_found"
  | "preview_busy";

export class WechatPreviewError extends Error {
  readonly code: WechatPreviewErrorCode;
  constructor(code: WechatPreviewErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "WechatPreviewError";
    this.code = code;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

type Target = WechatPreviewTarget & { projectRoot: string };
type PreviewJob = {
  targetId: string;
  state: WechatPreviewLifecycle;
  url?: string;
  error?: string;
  logs: string[];
  process?: WechatPreviewProcess;
  stopRequested: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readJson(path: string, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value)) throw new Error("expected an object");
    return value;
  } catch (error) {
    throw new WechatPreviewError("invalid_target_manifest", `invalid ${label}: ${path}`, error);
  }
}

function ensureDirectory(path: string, code: "invalid_workspace_root" | "invalid_project_root", label: string): string {
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(path); } catch (error) {
    throw new WechatPreviewError(code, `${label} does not exist: ${path}`, error);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new WechatPreviewError(code, `${label} must be a real directory: ${path}`);
  }
  try { return realpathSync(path); } catch (error) {
    throw new WechatPreviewError(code, `${label} cannot be resolved: ${path}`, error);
  }
}

function ensureFile(path: string, label: string): void {
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(path); } catch (error) {
    throw new WechatPreviewError("invalid_target_manifest", `${label} is missing: ${path}`, error);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new WechatPreviewError("invalid_target_manifest", `${label} must be a regular file: ${path}`);
  }
}

/** Resolve a project-relative file while refusing symlinks in every segment. */
function safeProjectFile(root: string, relativePath: string, label: string): string {
  const parts = relativePath.split(sep);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let info: ReturnType<typeof lstatSync>;
    try { info = lstatSync(current); } catch (error) {
      throw new WechatPreviewError("invalid_target_manifest", `${label} is missing: ${current}`, error);
    }
    if (info.isSymbolicLink()) {
      throw new WechatPreviewError("invalid_target_manifest", `${label} contains a symlink: ${current}`);
    }
  }
  const resolved = resolve(current);
  const rootRelative = relative(root, resolved);
  if (rootRelative === ".." || rootRelative.startsWith(`..${sep}`) || isAbsolute(rootRelative)) {
    throw new WechatPreviewError("invalid_target_manifest", `${label} escapes the project root`);
  }
  return resolved;
}

/**
 * The Editor launches one verification target: the selected project's root.
 * A System project is intentionally not decomposed into catalog children here;
 * build_wechat owns the complete catalog validation and emits the whole App.
 */
function readProjectTarget(projectRoot: string): Target[] {
  const pocketPath = safeProjectFile(projectRoot, "pocket.json", "project pocket.json");
  const manifestPath = safeProjectFile(projectRoot, "manifest.json", "project manifest.json");
  ensureFile(pocketPath, "project pocket.json");
  ensureFile(manifestPath, "project manifest.json");
  const pocket = readJson(pocketPath, "project pocket.json");
  let appId = typeof pocket.id === "string" && pocket.id ? pocket.id : "main";
  let label = typeof pocket.title === "string" && pocket.title ? pocket.title
    : typeof pocket.name === "string" && pocket.name ? pocket.name : appId;
  const systemPath = join(projectRoot, "pocket.system.json");
  if (existsSync(systemPath)) {
    ensureFile(systemPath, "pocket.system.json");
    const system = readJson(systemPath, "pocket.system.json");
    const roles = system.roles;
    const applications = system.applications;
    if (!isRecord(roles) || typeof roles.systemUI !== "string" ||
        !isRecord(applications) || !Array.isArray(applications.catalog) || applications.catalog.length === 0) {
      throw new WechatPreviewError("invalid_target_manifest", `invalid applications catalog: ${systemPath}`);
    }
    if (typeof system.id === "string" && system.id) appId = system.id;
    if (typeof system.title === "string" && system.title) label = system.title;
    else if (typeof system.name === "string" && system.name) label = system.name;
  }
  return [{ id: "main", label, appId, projectRoot }];
}

async function* textChunks(stream: unknown): AsyncGenerator<string> {
  if (!stream) return;
  if (typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    for await (const chunk of stream as AsyncIterable<unknown>) {
      if (typeof chunk === "string") yield chunk;
      else if (chunk instanceof Uint8Array) yield new TextDecoder().decode(chunk);
      else if (chunk instanceof ArrayBuffer) yield new TextDecoder().decode(new Uint8Array(chunk));
      else yield String(chunk);
    }
    return;
  }
  const candidate = stream as { getReader?: () => { read: () => Promise<{ done: boolean; value?: unknown }>; releaseLock?: () => void } };
  if (typeof candidate.getReader !== "function") return;
  const reader = candidate.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value;
      if (typeof value === "string") yield value;
      else if (value instanceof Uint8Array) yield new TextDecoder().decode(value);
      else if (value instanceof ArrayBuffer) yield new TextDecoder().decode(new Uint8Array(value));
      else if (value !== undefined) yield String(value);
    }
  } finally {
    reader.releaseLock?.();
  }
}

async function consumeLines(stream: unknown, onLine: (line: string) => void): Promise<void> {
  let buffer = "";
  for await (const chunk of textChunks(stream)) {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > maxLogLineBytes * 2) {
      onLine(buffer.slice(0, maxLogLineBytes) + "…");
      buffer = buffer.slice(maxLogLineBytes);
    }
    let newline = buffer.search(/\r?\n/);
    while (newline >= 0) {
      const separator = buffer.slice(newline).match(/^\r?\n/)?.[0].length ?? 1;
      const line = buffer.slice(0, newline);
      onLine(line.slice(0, maxLogLineBytes) + (line.length > maxLogLineBytes ? "…" : ""));
      buffer = buffer.slice(newline + separator);
      newline = buffer.search(/\r?\n/);
    }
  }
  if (buffer) onLine(buffer.slice(0, maxLogLineBytes) + (buffer.length > maxLogLineBytes ? "…" : ""));
}

function defaultSpawn(argv: readonly string[], options: WechatPreviewSpawnOptions): WechatPreviewProcess {
  return Bun.spawn(argv, options) as unknown as WechatPreviewProcess;
}

function signalOwned(child: WechatPreviewProcess, signal: "SIGTERM" | "SIGKILL"): void {
  const pid = child.pid;
  if (process.platform !== "win32" && typeof pid === "number" && Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the exact child object if process-group signalling is unavailable.
    }
  }
  try { child.kill(signal); } catch { /* Child may have exited between reads. */ }
}

function allowedPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function boundedError(error: unknown, fallback: string): string {
  const value = error instanceof Error ? error.message : String(error);
  return (value || fallback).slice(0, maxLogLineBytes);
}

class WechatPreviewManagerImpl implements WechatPreviewManager {
  private readonly projectDirectory: (id: string) => string;
  private readonly workspaceRoot: string;
  private readonly scriptPath: string;
  private readonly spawnProcess: WechatPreviewSpawn;
  private readonly idFactory: () => string;
  private readonly jobs = new Map<string, PreviewJob>();
  private disposed = false;

  constructor(options: WechatPreviewManagerOptions) {
    this.projectDirectory = options.projectDirectory;
    if (typeof this.projectDirectory !== "function") throw new TypeError("projectDirectory is required");
    const workspace = resolve(options.workspaceRoot);
    this.workspaceRoot = ensureDirectory(workspace, "invalid_workspace_root", "workspaceRoot");
    this.scriptPath = resolve(options.scriptPath ?? defaultScriptPath);
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async status(id: string): Promise<WechatPreviewSnapshot> {
    this.assertLive();
    const projectId = this.normalizeId(id);
    const targets = this.targets(projectId);
    return this.snapshot(targets, this.jobs.get(projectId));
  }

  isBuilding(id: string): boolean {
    this.assertLive();
    const projectId = this.normalizeId(id);
    return this.jobs.get(projectId)?.state === "building";
  }

  async start(id: string, targetId = "main"): Promise<WechatPreviewSnapshot> {
    this.assertLive();
    const projectId = this.normalizeId(id);
    const targets = this.targets(projectId);
    const target = targets.find((entry) => entry.id === targetId);
    if (!target) throw new WechatPreviewError("target_not_found", `unknown WeChat target ${targetId}`);
    const current = this.jobs.get(projectId);
    if (current?.state === "building" || current?.state === "running") {
      throw new WechatPreviewError("preview_busy", `project ${projectId} already has a WeChat preview`);
    }
    const job: PreviewJob = {
      targetId: target.id,
      state: "building",
      logs: [],
      stopRequested: false,
    };
    this.jobs.set(projectId, job);
    try {
      const output = this.newOutputDirectory(projectId);
      const argv = [
        process.execPath,
        this.scriptPath,
        `--project-root=${target.projectRoot}`,
        `--outdir=${output}`,
      ];
      const child = this.spawnProcess(argv, {
        cwd: this.workspaceRoot,
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      job.process = child;
      this.attach(projectId, job, child);
    } catch (error) {
      this.fail(projectId, job, `failed to start WeChat preview: ${boundedError(error, "spawn failed")}`);
    }
    return this.snapshot(targets, job);
  }

  async stop(id: string): Promise<WechatPreviewSnapshot> {
    this.assertLive();
    const projectId = this.normalizeId(id);
    const job = this.jobs.get(projectId);
    if (job && (job.process || job.state === "building" || job.state === "running" || job.state === "error")) {
      await this.stopJob(job);
    }
    try {
      return this.snapshot(this.targets(projectId), job);
    } catch (error) {
      // A source tree can disappear while its owned process is stopping. The
      // process has already been made safe above; expose the stopped state
      // with no stale target list rather than making cleanup impossible.
      if (job) return this.snapshot([], job);
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [projectId, job] of this.jobs) {
      if (!job.process) continue;
      job.stopRequested = true;
      job.state = "stopped";
      const child = job.process;
      signalOwned(child, "SIGTERM");
      setTimeout(() => {
        if (job.process === child) signalOwned(child, "SIGKILL");
      }, stopGraceMs).unref?.();
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new WechatPreviewError("manager_disposed", "WeChat preview manager is disposed");
  }

  private normalizeId(id: string): string {
    if (typeof id !== "string" || !projectIdPattern.test(id)) {
      throw new WechatPreviewError("invalid_project_id", "project id is not valid");
    }
    return id;
  }

  private targets(projectId: string): Target[] {
    let raw: string;
    try { raw = this.projectDirectory(projectId); } catch (error) {
      throw new WechatPreviewError("invalid_project_root", `cannot resolve project ${projectId}`, error);
    }
    if (typeof raw !== "string" || !isAbsolute(raw)) {
      throw new WechatPreviewError("invalid_project_root", `project ${projectId} must resolve to an absolute directory`);
    }
    const root = ensureDirectory(resolve(raw), "invalid_project_root", `project ${projectId}`);
    return readProjectTarget(root);
  }

  private newOutputDirectory(projectId: string): string {
    const parent = join(this.workspaceRoot, projectId);
    mkdirSync(parent, { recursive: true });
    const parentInfo = lstatSync(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new WechatPreviewError("invalid_workspace_root", `preview workspace is not a real directory: ${parent}`);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const output = join(parent, this.idFactory());
      if (existsSync(output)) continue;
      mkdirSync(output);
      return output;
    }
    throw new Error(`could not allocate a unique WeChat preview workspace for ${projectId}`);
  }

  private attach(projectId: string, job: PreviewJob, child: WechatPreviewProcess): void {
    void consumeLines(child.stdout, (line) => this.stdoutLine(projectId, job, line)).catch((error) => {
      this.fail(projectId, job, `stdout failed: ${boundedError(error, "stdout failed")}`);
      if (job.process) signalOwned(job.process, "SIGTERM");
    });
    void consumeLines(child.stderr, (line) => this.log(job, line)).catch((error) => {
      this.fail(projectId, job, `stderr failed: ${boundedError(error, "stderr failed")}`);
      if (job.process) signalOwned(job.process, "SIGTERM");
    });
    void child.exited.then((code) => this.exited(projectId, job, code)).catch((error) => {
      this.fail(projectId, job, `preview process failed: ${boundedError(error, "process failed")}`);
    });
  }

  private stdoutLine(projectId: string, job: PreviewJob, line: string): void {
    if (job.stopRequested || job.state === "stopped" || job.state === "error") return;
    if (!line.startsWith(previewUrlPrefix)) {
      this.log(job, line);
      return;
    }
    const url = line.slice(previewUrlPrefix.length).trim();
    if (!allowedPreviewUrl(url)) {
      this.fail(projectId, job, "preview URL must use http://127.0.0.1");
      if (job.process) signalOwned(job.process, "SIGTERM");
      return;
    }
    job.url = url;
    job.error = undefined;
    job.state = "running";
  }

  private exited(projectId: string, job: PreviewJob, code: number): void {
    job.process = undefined;
    if (job.stopRequested) {
      job.state = "stopped";
      return;
    }
    if (code === 0 && job.state === "running") {
      job.state = "stopped";
      return;
    }
    this.fail(projectId, job, `preview process exited with status ${code}`);
  }

  private fail(projectId: string, job: PreviewJob, message: string): void {
    if (job.state === "stopped" || job.state === "error") return;
    job.state = "error";
    job.error = message.slice(0, maxLogLineBytes);
  }

  private log(job: PreviewJob, line: string): void {
    job.logs.push(line.slice(0, maxLogLineBytes));
    if (job.logs.length > maxLogLines) job.logs.splice(0, job.logs.length - maxLogLines);
  }

  private async stopJob(job: PreviewJob): Promise<void> {
    const child = job.process;
    if (!child) {
      job.state = "stopped";
      return;
    }
    job.stopRequested = true;
    job.state = "stopped";
    signalOwned(child, "SIGTERM");
    await Promise.race([
      child.exited.then(() => undefined),
      new Promise<void>((resolveWait) => setTimeout(resolveWait, stopGraceMs)),
    ]);
    if (job.process === child) {
      signalOwned(child, "SIGKILL");
      await Promise.race([
        child.exited.then(() => undefined),
        new Promise<void>((resolveWait) => setTimeout(resolveWait, stopGraceMs)),
      ]);
    }
  }

  private snapshot(targets: Target[], job: PreviewJob | undefined): WechatPreviewSnapshot {
    return {
      targets: targets.map(({ id, label, appId }) => ({ id, label, appId })),
      state: job ? {
        state: job.state,
        targetId: job.targetId,
        ...(job.url ? { url: job.url } : {}),
        ...(job.error ? { error: job.error } : {}),
        logs: [...job.logs],
      } : { state: "idle", logs: [] },
    };
  }
}

export function createWechatPreviewManager(options: WechatPreviewManagerOptions): WechatPreviewManager {
  return new WechatPreviewManagerImpl(options);
}
