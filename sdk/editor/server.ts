/**
 * Pocket Studio, the local editor service shipped with the Pocket SDK.
 *
 * This is intentionally a thin adapter around the checked-in PocketJS
 * compiler and the repository's signed-update packager.  It never turns a
 * source entry into a "bytecode" file by renaming/compressing it: every
 * publish goes through pocketjs_bytecode and package_update.ts with
 * entryFormat=quickjs-bytecode.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateDevKey,
  packageArtifacts,
  sha256Hex,
  type PackageResult,
  type PublicKeyConfig,
} from "../scripts/package_update.ts";
import { buildGuest } from "../scripts/build_guest.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectIdPattern = /^[a-z][a-z0-9-]{0,47}$/;
const appIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const maxSourceBytes = 16 * 1024 * 1024;
const maxJsonBytes = 256 * 1024;
const maxAssetBytes = 32 * 1024 * 1024;

export type EditorConfig = {
  id: string;
  appId: string;
  name: string;
  title: string;
  version: string;
  build: number;
  tickHz: number;
  entry: "app.tsx";
  framework: "solid";
};

export type ArtifactInfo = {
  revision: number;
  appJs: string;
  bytecode: string;
  metadata: string;
  pak: string;
  manifest: string;
  build: string;
};

export type EditorStatus = {
  id: string;
  revision: number;
  builtRevision: number | null;
  busy: boolean;
  error?: string;
  logs: string[];
  startedAt?: string;
  finishedAt?: string;
  artifacts?: ArtifactInfo;
  publish?: {
    revision: number;
    updateUrl: string;
    manifestUrl: string;
    hostConfigUrl: string;
    archiveUrl: string;
    keyId: string;
    runtimeAbi: string;
    payloadSha256: string;
  };
};

type BuildOutput = {
  appJs: string;
  pak: string;
  bytecode: string;
  metadata: string;
  runtimeAbi: string;
  bytecodeMetadata: Record<string, unknown>;
};

type BuildRunner = (input: {
  id: string;
  projectDir: string;
  outDir: string;
  config: EditorConfig;
  log: (line: string) => void;
}) => Promise<BuildOutput>;

export type StartEditorOptions = {
  host?: string;
  port?: number;
  workspace?: string;
  /** Edit/build one explicit external SDK project instead of copying guest/. */
  projectRoot?: string;
  /** Used by service tests; production always uses the real runner below. */
  buildRunner?: BuildRunner;
};

type EditorState = {
  revision: number;
  builtRevision: number | null;
  busy: boolean;
  error?: string;
  logs: string[];
  startedAt?: string;
  finishedAt?: string;
  artifacts?: ArtifactInfo;
  publish?: EditorStatus["publish"];
};

type Workspace = {
  root: string;
  projects: string;
  builds: string;
  updates: string;
  keys: string;
  states: string;
  projectRoot?: string;
  projectId?: string;
};

type EditorServer = ReturnType<typeof Bun.serve>;

function now(): string {
  return new Date().toISOString();
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function failure(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`${label} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function asProjectId(value: unknown): string {
  const id = asString(value, "id", 48);
  if (!projectIdPattern.test(id)) throw new Error("id must match [a-z][a-z0-9-]{0,47}");
  return id;
}

function safeChild(parent: string, child: string): string {
  const resolved = resolve(parent, child);
  const rel = relative(resolve(parent), resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("path escapes workspace");
  return resolved;
}

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}

const editableFilePattern = /\.(?:ts|tsx|js|jsx|json|svg|css|md)$/i;
const protectedFilePattern = /^(?:editor(?:-state)?|pocket|host|payload|latest|signed-manifest|build|app\.bytecode|private|secret)\.json$|\.(?:pem|key|qjbc|pak|tar|gz)$/i;
const protectedDirectoryNames = new Set(["assets", "builds", "updates", "keys", "node_modules", ".git", ".pocket-build"]);

type SafeProjectFileOptions = {
  allowAssets?: boolean;
  isDirectory?: boolean;
  allowProtected?: boolean;
};

/**
 * Resolve a guest text file without following a symlink out of the project.
 * Build outputs, editor state, package keys and update artifacts are never
 * exposed through this API, even if a caller guesses their path.
 */
function safeProjectFile(projectDir: string, relativePath: string, options: SafeProjectFileOptions = {}): string {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const leaf = segments.at(-1) ?? "";
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || segments.some((part) => !part || part === "." || part === "..")) {
    const err = new Error("file path must stay inside the project");
    (err as unknown as { status: number }).status = 400;
    throw err;
  }
  if (!options.allowAssets && segments.some((part) => protectedDirectoryNames.has(part.toLowerCase()))) {
    const err = new Error("file is not an editable guest source file");
    (err as unknown as { status: number }).status = 400;
    throw err;
  }
  if (!options.allowProtected && protectedFilePattern.test(leaf)) {
    const err = new Error("file is not an editable guest source file");
    (err as unknown as { status: number }).status = 400;
    throw err;
  }
  if (!options.isDirectory && !options.allowAssets && !editableFilePattern.test(leaf)) {
    const err = new Error("file is not an editable guest source file");
    (err as unknown as { status: number }).status = 400;
    throw err;
  }

  const resolved = safeChild(projectDir, normalized);
  if (!existsSync(projectDir)) {
    const err = new Error("project directory does not exist");
    (err as unknown as { status: number }).status = 404;
    throw err;
  }
  if (lstatSync(projectDir).isSymbolicLink()) {
    const err = new Error("project directory must not be a symlink");
    (err as unknown as { status: number }).status = 400;
    throw err;
  }
  const projectReal = realpathSync(projectDir);

  let currentPath = resolve(projectDir);
  let deepestExistingAncestor = projectReal;

  for (const segment of segments) {
    const nextPath = join(currentPath, segment);
    if (existsSync(nextPath)) {
      const entry = lstatSync(nextPath);
      if (entry.isSymbolicLink()) {
        const err = new Error(`symbolic links are not allowed: ${segment}`);
        (err as unknown as { status: number }).status = 400;
        throw err;
      }
      const realNext = realpathSync(nextPath);
      if (!isInside(projectReal, realNext)) {
        const err = new Error("file path escapes project through a symlink");
        (err as unknown as { status: number }).status = 400;
        throw err;
      }
      currentPath = nextPath;
      deepestExistingAncestor = realNext;
    } else {
      if (!isInside(projectReal, deepestExistingAncestor)) {
        const err = new Error("file path escapes project through a symlink");
        (err as unknown as { status: number }).status = 400;
        throw err;
      }
      currentPath = nextPath;
    }
  }

  if (existsSync(resolved)) {
    const entry = lstatSync(resolved);
    if (entry.isSymbolicLink()) {
      const err = new Error("symbolic links are not allowed");
      (err as unknown as { status: number }).status = 400;
      throw err;
    }
    if (!isInside(projectReal, realpathSync(resolved))) {
      const err = new Error("file path escapes project through a symlink");
      (err as unknown as { status: number }).status = 400;
      throw err;
    }
    if (options.isDirectory) {
      if (!entry.isDirectory()) {
        const err = new Error("path is not a directory");
        (err as unknown as { status: number }).status = 400;
        throw err;
      }
    } else {
      if (!entry.isFile()) {
        const err = new Error("project file is not a regular file");
        (err as unknown as { status: number }).status = 400;
        throw err;
      }
    }
  }

  return resolved;
}

function safeArtifactFile(rootDir: string, relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || segments.some((part) => !part || part === "." || part === "..")) {
    const err = new Error("invalid artifact path");
    (err as unknown as { status: number }).status = 400;
    throw err;
  }
  let resolved: string;
  try {
    resolved = safeChild(rootDir, normalized);
  } catch {
    const err = new Error("artifact path escapes workspace");
    (err as unknown as { status: number }).status = 400;
    throw err;
  }
  if (!existsSync(rootDir)) {
    const err = new Error("artifact directory does not exist");
    (err as unknown as { status: number }).status = 404;
    throw err;
  }
  if (lstatSync(rootDir).isSymbolicLink()) {
    const err = new Error("symbolic links are not allowed");
    (err as unknown as { status: number }).status = 400;
    throw err;
  }
  const rootReal = realpathSync(rootDir);

  let currentPath = resolve(rootDir);
  for (const segment of segments) {
    const nextPath = join(currentPath, segment);
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(nextPath);
    } catch {
      const err = new Error("artifact not found");
      (err as unknown as { status: number }).status = 404;
      throw err;
    }
    if (entry.isSymbolicLink()) {
      const err = new Error(`symbolic links are not allowed: ${segment}`);
      (err as unknown as { status: number }).status = 400;
      throw err;
    }
    if (!existsSync(nextPath)) {
      const err = new Error("artifact not found");
      (err as unknown as { status: number }).status = 404;
      throw err;
    }
    const realNext = realpathSync(nextPath);
    if (!isInside(rootReal, realNext)) {
      const err = new Error("artifact path escapes workspace through a symlink");
      (err as unknown as { status: number }).status = 400;
      throw err;
    }
    currentPath = nextPath;
  }

  const finalEntry = lstatSync(resolved);
  if (!finalEntry.isFile()) {
    const err = new Error("artifact is not a regular file");
    (err as unknown as { status: number }).status = 400;
    throw err;
  }

  return resolved;
}

async function listEditableFiles(projectDir: string): Promise<Array<{ path: string; bytes: number }>> {
  const result: Array<{ path: string; bytes: number }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "assets" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
      } else if (entry.isFile() && editableFilePattern.test(entry.name) && !protectedFilePattern.test(entry.name)) {
        const relativePath = relative(projectDir, filePath).replaceAll("\\", "/");
        // Reuse the same symlink/path policy used for reads and writes.
        safeProjectFile(projectDir, relativePath);
        result.push({ path: relativePath, bytes: (await stat(filePath)).size });
      } else if (entry.isSymbolicLink()) {
        throw new Error(`project contains unsupported source symlink: ${entry.name}`);
      }
    }
  };
  await walk(projectDir);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function readJsonFile<T>(path: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (fallback !== undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function parseJsonBody(request: Request, maxBytes = maxJsonBytes): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const err = new Error("unsupported media type: expected application/json");
    (err as unknown as { status: number }).status = 415;
    throw err;
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) throw new Error("request body is too large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error("request body is too large");
  const value: unknown = JSON.parse(raw || "{}");
  if (!isObject(value)) throw new Error("request body must be a JSON object");
  return value;
}

const readBody = parseJsonBody;

async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name === "node_modules") continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await cp(from, to);
    else throw new Error(`template contains unsupported entry: ${entry.name}`);
  }
}

function defaultConfig(id: string, input: Record<string, unknown>): EditorConfig {
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : id;
  // The current Flutter HostSession is intentionally a single app host. A
  // project can still opt into another app id explicitly, but a fresh
  // scaffold is immediately consumable by that host without extra edits.
  const appId = typeof input.appId === "string" && appIdPattern.test(input.appId) ? input.appId : "pocket.host.demo";
  const version = typeof input.version === "string" && versionPattern.test(input.version) ? input.version : "0.1.0";
  const build = Number.isSafeInteger(input.build) && Number(input.build) >= 0 ? Number(input.build) : 1;
  const tickHz = Number.isSafeInteger(input.tickHz) && Number(input.tickHz) >= 1 && Number(input.tickHz) <= 120 ? Number(input.tickHz) : 60;
  return { id, appId, name, title: name, version, build, tickHz, entry: "app.tsx", framework: "solid" };
}

function validateConfig(id: string, input: Record<string, unknown>): EditorConfig {
  const config = defaultConfig(id, input);
  if (typeof input.appId !== "undefined" && !appIdPattern.test(config.appId)) throw new Error("appId contains unsafe characters");
  if (typeof input.version !== "undefined" && !versionPattern.test(config.version)) throw new Error("version contains unsafe characters");
  if (typeof input.name !== "undefined") config.name = asString(input.name, "name", 160).trim();
  if (!config.name) throw new Error("name must not be empty");
  if (typeof input.appId === "string" && !appIdPattern.test(input.appId)) throw new Error("appId contains unsafe characters");
  if (typeof input.version === "string" && !versionPattern.test(input.version)) throw new Error("version contains unsafe characters");
  if (input.build !== undefined && (!Number.isSafeInteger(input.build) || Number(input.build) < 0)) throw new Error("build must be a non-negative integer");
  if (input.tickHz !== undefined && (!Number.isSafeInteger(input.tickHz) || Number(input.tickHz) < 1 || Number(input.tickHz) > 120)) throw new Error("tickHz must be an integer from 1 through 120");
  config.appId = typeof input.appId === "string" ? input.appId : config.appId;
  config.version = typeof input.version === "string" ? input.version : config.version;
  config.build = input.build === undefined ? config.build : Number(input.build);
  config.tickHz = input.tickHz === undefined ? config.tickHz : Number(input.tickHz);
  config.title = config.name;
  return config;
}

async function loadConfig(projectDir: string, id: string): Promise<EditorConfig> {
  const editorPath = join(projectDir, "editor.json");
  const editor = await readJsonFile<Record<string, unknown>>(editorPath, {});
  if (Object.keys(editor).length > 0) return validateConfig(id, editor);
  const pocket = await readJsonFile<Record<string, unknown>>(join(projectDir, "pocket.json"), {});
  const app = isObject(pocket.app) ? pocket.app : {};
  return validateConfig(id, {
    id,
    appId: pocket.id,
    name: pocket.title ?? pocket.name,
    version: pocket.version,
    tickHz: 60,
    entry: app.entry,
  });
}

async function writeConfig(projectDir: string, config: EditorConfig): Promise<void> {
  await writeFile(join(projectDir, "editor.json"), JSON.stringify(config, null, 2) + "\n");
  const pocketPath = join(projectDir, "pocket.json");
  const pocket = await readJsonFile<Record<string, unknown>>(pocketPath, {
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    app: { entry: "app.tsx", output: "app", framework: "solid" },
  });
  pocket.id = config.appId;
  pocket.name = config.name;
  pocket.title = config.title;
  pocket.version = config.version;
  const app = isObject(pocket.app) ? pocket.app : {};
  pocket.app = { ...app, entry: "app.tsx", output: "app", framework: "solid" };
  await writeFile(pocketPath, JSON.stringify(pocket, null, 2) + "\n");
}

async function createProject(workspace: Workspace, id: string, input: Record<string, unknown>): Promise<EditorConfig> {
  const projectDir = safeChild(workspace.projects, id);
  if (existsSync(projectDir)) throw new Error(`project already exists: ${id}`);
  await mkdir(workspace.projects, { recursive: true });
  // New projects start from the one SDK-owned starter shared with `pocket
  // init`. The Showcase lives in the sibling demo entry and is deliberately
  // not copied into editor projects.
  await copyTree(join(root, "templates/starter"), projectDir);
  const config = validateConfig(id, input);
  await writeConfig(projectDir, config);
  await mkdir(join(projectDir, "assets"), { recursive: true });
  return config;
}

function projectDirectory(workspace: Workspace, id: string): string {
  if (workspace.projectRoot && id === workspace.projectId) return workspace.projectRoot;
  return safeChild(workspace.projects, id);
}

async function listProjects(workspace: Workspace): Promise<Array<EditorConfig & { status: EditorStatus }>> {
  await mkdir(workspace.projects, { recursive: true });
  const entries = await readdir(workspace.projects, { withFileTypes: true });
  const projects: Array<EditorConfig & { status: EditorStatus }> = [];
  const ids = workspace.projectRoot
    ? [workspace.projectId!]
    : entries.filter((entry) => entry.isDirectory() && projectIdPattern.test(entry.name)).map((entry) => entry.name);
  for (const id of ids) {
    try {
      const config = await loadConfig(projectDirectory(workspace, id), id);
      const state = await loadState(workspace, id);
      projects.push({ ...config, status: publicStatus(id, state) });
    } catch {
      // A partially copied project is not allowed to take down the editor.
    }
  }
  return projects.sort((a, b) => a.id.localeCompare(b.id));
}

async function loadState(workspace: Workspace, id: string): Promise<EditorState> {
  const statePath = join(workspace.states, `${id}.json`);
  let state: EditorState;
  try {
    state = await readJsonFile<EditorState>(statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Preserve a pre-existing editor state once, but keep new state outside
    // the external guest project so build inputs never see it.
    state = await readJsonFile<EditorState>(join(projectDirectory(workspace, id), "editor-state.json"), {
      revision: 1,
      builtRevision: null,
      busy: false,
      logs: [],
    });
  }
  // A process restart cannot resume an in-flight compiler process.  Treat a
  // persisted busy bit as an interrupted build so the UI can start a fresh
  // one and retain the previous completed snapshot, if any.
  return { ...state, busy: false };
}

async function saveState(workspace: Workspace, id: string, state: EditorState): Promise<void> {
  await mkdir(workspace.states, { recursive: true });
  await writeFile(join(workspace.states, `${id}.json`), JSON.stringify(state, null, 2) + "\n");
}

function publicStatus(id: string, state: EditorState): EditorStatus {
  return {
    id,
    revision: state.revision,
    builtRevision: state.builtRevision,
    busy: state.busy,
    ...(state.error ? { error: state.error } : {}),
    logs: state.logs.slice(-200),
    ...(state.startedAt ? { startedAt: state.startedAt } : {}),
    ...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
    ...(state.artifacts ? { artifacts: state.artifacts } : {}),
    ...(state.publish ? { publish: state.publish } : {}),
  };
}

function pushLog(state: EditorState, line: string): void {
  state.logs.push(line.slice(0, 4096));
  if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
}

async function runProcess(command: string[], cwd: string, log: (line: string) => void): Promise<void> {
  log(`$ ${command.map((part) => JSON.stringify(part)).join(" ")}`);
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdoutPromise = new Response(process.stdout).text();
  const stderrPromise = new Response(process.stderr).text();
  const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, process.exited]);
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/).filter(Boolean)) log(line);
  if (exitCode !== 0) throw new Error(`${command[0]} exited with status ${exitCode}`);
}

async function realBuild(input: Parameters<BuildRunner>[0]): Promise<BuildOutput> {
  await mkdir(input.outDir, { recursive: true });
  const built = await buildGuest({
    projectRoot: input.projectDir,
    outDir: input.outDir,
    tickHz: input.config.tickHz,
    log: input.log,
  });
  const bytecodeMetadata = await readJsonFile<Record<string, unknown>>(built.metadata);
  if (bytecodeMetadata.entryFormat !== "quickjs-bytecode" || typeof bytecodeMetadata.runtimeAbi !== "string" || !bytecodeMetadata.runtimeAbi) {
    throw new Error("bytecode metadata is not a real quickjs-bytecode artifact");
  }
  const bytecodeStat = await stat(built.bytecode);
  if (bytecodeMetadata.bytecodeBytes !== bytecodeStat.size) throw new Error("bytecode metadata size does not match qjbc");
  return {
    appJs: built.source,
    pak: built.pak,
    bytecode: built.bytecode,
    metadata: built.metadata,
    runtimeAbi: bytecodeMetadata.runtimeAbi,
    bytecodeMetadata,
  };
}

async function buildProject(workspace: Workspace, id: string, state: EditorState, config: EditorConfig, runner: BuildRunner): Promise<void> {
  const revision = state.revision;
  const projectDir = projectDirectory(workspace, id);
  safeProjectFile(projectDir, "app.tsx");
  const projectManifest = safeProjectFile(projectDir, "manifest.json");
  const assetsDir = join(projectDir, "assets");
  if (existsSync(assetsDir)) {
    safeProjectFile(projectDir, "assets", { allowAssets: true, isDirectory: true });
    for (const entry of await readdir(assetsDir, { withFileTypes: true })) {
      safeProjectFile(projectDir, `assets/${entry.name}`, { allowAssets: true, isDirectory: entry.isDirectory() });
    }
  }
  const buildDir = safeChild(workspace.builds, `${id}/${revision}`);
  await mkdir(buildDir, { recursive: true });
  const temp = await mkdtemp(join(tmpdir(), "pocket-editor-build-"));
  try {
    const output = await runner({ id, projectDir, outDir: temp, config, log: (line) => pushLog(state, line) });
    const copy = async (name: string, source: string) => { await cp(source, join(buildDir, name)); };
    await copy("app.js", output.appJs);
    await copy("app.pak", output.pak);
    await copy("app.qjbc", output.bytecode);
    await copy("app.bytecode.json", output.metadata);
    await copy("guest-manifest.json", projectManifest);
    const buildInfo = {
      id,
      revision,
      appId: config.appId,
      version: config.version,
      build: config.build,
      tickHz: config.tickHz,
      entryFormat: "quickjs-bytecode",
      runtimeAbi: output.runtimeAbi,
      bytecode: output.bytecodeMetadata,
      generatedAt: now(),
    };
    await writeFile(join(buildDir, "build.json"), JSON.stringify(buildInfo, null, 2) + "\n");
    await writeFile(join(workspace.builds, id, "current.json"), JSON.stringify({ revision }, null, 2) + "\n");
    state.builtRevision = revision;
    state.artifacts = {
      revision,
      appJs: `/api/projects/${id}/artifacts/app.js`,
      bytecode: `/api/projects/${id}/artifacts/app.qjbc`,
      metadata: `/api/projects/${id}/artifacts/app.bytecode.json`,
      pak: `/api/projects/${id}/artifacts/app.pak`,
      manifest: `/api/projects/${id}/artifacts/guest-manifest.json`,
      build: `/api/projects/${id}/artifacts/build.json`,
    };
    state.error = undefined;
    pushLog(state, `build ready: revision ${revision}, runtimeAbi=${output.runtimeAbi}`);
  } finally {
    // This directory is a private, disposable staging area.  A failed build
    // leaves the previous snapshot intact and its diagnostics in state.logs.
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function queueBuild(
  workspace: Workspace,
  id: string,
  states: Map<string, EditorState>,
  runner: BuildRunner,
): void {
  const state = states.get(id)!;
  if (state.busy) return;
  state.busy = true;
  state.error = undefined;
  state.startedAt = now();
  void (async () => {
    try {
      do {
        const revision = state.revision;
        const config = await loadConfig(projectDirectory(workspace, id), id);
        pushLog(state, `build started: revision ${revision}`);
        await saveState(workspace, id, state);
        try {
          await buildProject(workspace, id, state, config, runner);
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error);
          pushLog(state, `ERROR: ${state.error}`);
        }
      } while (state.revision !== state.builtRevision && !state.error);
    } finally {
      state.busy = false;
      state.finishedAt = now();
      await saveState(workspace, id, state);
    }
  })();
}

async function readArtifact(workspace: Workspace, id: string, file: string, state: EditorState): Promise<Uint8Array | undefined> {
  if (!state.artifacts || state.builtRevision === null) return undefined;
  const name = basename(file);
  const allowed = new Set(["app.js", "app.qjbc", "app.bytecode.json", "app.pak", "guest-manifest.json", "build.json"]);
  if (!allowed.has(name)) return undefined;
  let path: string;
  try {
    path = safeArtifactFile(workspace.builds, `${id}/${state.builtRevision}/${name}`);
  } catch (error) {
    const status = (error as unknown as { status?: number })?.status;
    if (status === 404) return undefined;
    throw error;
  }
  try { return new Uint8Array(await readFile(path)); } catch { return undefined; }
}

async function publishProject(
  workspace: Workspace,
  id: string,
  config: EditorConfig,
  state: EditorState,
  origin: string,
): Promise<PackageResult> {
  if (state.builtRevision !== state.revision || !state.artifacts) throw new Error("build the current source before publishing");
  const buildDir = join(workspace.builds, id, String(state.builtRevision));
  const releaseDir = join(workspace.updates, id);
  await mkdir(releaseDir, { recursive: true });
  const keyPath = join(workspace.keys, "editor-dev-key.json");
  await mkdir(workspace.keys, { recursive: true });
  if (!existsSync(keyPath)) generateDevKey(keyPath, `editor-${id}`);
  const metadata = await readJsonFile<Record<string, unknown>>(join(buildDir, "app.bytecode.json"));
  const result = packageArtifacts({
    appId: config.appId,
    version: config.version,
    build: config.build,
    bytecodePath: join(buildDir, "app.qjbc"),
    entryFormat: "quickjs-bytecode",
    runtimeAbi: String(metadata.runtimeAbi),
    pakPath: join(buildDir, "app.pak"),
    outDir: releaseDir,
    keyFile: keyPath,
    guestManifestPath: join(buildDir, "guest-manifest.json"),
  });
  const key = await readJsonFile<PublicKeyConfig & { publicKeyPem?: string }>(keyPath);
  let safeOrigin = origin;
  try {
    const parsed = new URL(origin);
    safeOrigin = `http://127.0.0.1:${parsed.port || 80}`;
  } catch {
    safeOrigin = "http://127.0.0.1:8790";
  }
  const manifestUrl = `${safeOrigin}/updates/${id}/latest.json`;
  const hostConfigUrl = `${safeOrigin}/updates/${id}/host.json`;
  await writeFile(join(releaseDir, "host.json"), JSON.stringify({
    POCKET_UPDATE_URL: manifestUrl,
    POCKET_UPDATE_KEY_ID: key.keyId,
    POCKET_UPDATE_PUBLIC_KEY: key.publicKeyBase64,
  }, null, 2) + "\n");
  const archive = join(workspace.updates, `${id}.tar.gz`);
  await runProcess(["tar", "-czf", archive, "-C", releaseDir, "."], root, (line) => pushLog(state, line));
  state.publish = {
    revision: state.revision,
    updateUrl: `/updates/${id}/latest.json`,
    manifestUrl,
    hostConfigUrl,
    archiveUrl: `/releases/${id}.tar.gz`,
    keyId: result.envelope.keyId,
    runtimeAbi: String(metadata.runtimeAbi),
    payloadSha256: sha256Hex(result.payloadBytes),
  };
  await saveState(workspace, id, state);
  return result;
}

async function listAssets(projectDir: string): Promise<string[]> {
  const directory = join(projectDir, "assets");
  await mkdir(directory, { recursive: true });
  return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".qjbc": return "application/octet-stream";
    case ".pak": return "application/octet-stream";
    case ".gz": return "application/gzip";
    default: return "application/octet-stream";
  }
}

function validateRequestSecurity(req: Request, url: URL, serverPort: number, csrfToken: string): Response | null {
  const allowedHostnames = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

  const hostHeader = req.headers.get("host");
  if (!hostHeader) {
    return failure("forbidden: missing Host header", 403);
  }
  let dummyUrl: URL;
  try {
    dummyUrl = new URL(`http://${hostHeader}`);
  } catch {
    return failure("forbidden: invalid Host header", 403);
  }
  if (!allowedHostnames.has(dummyUrl.hostname)) {
    return failure("forbidden: host not allowed", 403);
  }
  if (dummyUrl.port !== "") {
    if (Number(dummyUrl.port) !== serverPort) {
      return failure("forbidden: host port mismatch", 403);
    }
  }

  const method = req.method.toUpperCase();
  const mutatingMethods = new Set(["POST", "PUT", "DELETE", "PATCH"]);
  if (mutatingMethods.has(method)) {
    const secFetchSite = req.headers.get("sec-fetch-site");
    if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
      return failure("forbidden: cross-origin fetch-site not allowed", 403);
    }

    const secFetchMode = req.headers.get("sec-fetch-mode");
    if (secFetchMode && (secFetchMode === "navigate" || secFetchMode === "no-cors")) {
      return failure("forbidden: browser navigation/no-cors write not allowed", 403);
    }

    const originHeader = req.headers.get("origin");
    if (originHeader !== null) {
      if (originHeader === "null") {
        return failure("forbidden: null Origin not allowed", 403);
      }
      let originUrl: URL;
      try {
        originUrl = new URL(originHeader);
      } catch {
        return failure("forbidden: invalid Origin header", 403);
      }
      const originPort = originUrl.port || "80";
      if (
        originUrl.protocol !== url.protocol ||
        !allowedHostnames.has(originUrl.hostname) ||
        originPort !== String(serverPort)
      ) {
        return failure("forbidden: cross-origin requests not allowed", 403);
      }
    }

    const refererHeader = req.headers.get("referer");
    if (refererHeader !== null) {
      let refererUrl: URL;
      try {
        refererUrl = new URL(refererHeader);
      } catch {
        return failure("forbidden: cross-origin referer not allowed", 403);
      }
      const refererPort = refererUrl.port || "80";
      if (
        refererUrl.protocol !== url.protocol ||
        !allowedHostnames.has(refererUrl.hostname) ||
        refererPort !== String(serverPort)
      ) {
        return failure("forbidden: cross-origin referer not allowed", 403);
      }
    }

    if (req.headers.has("x-pocket-csrf") && req.headers.get("x-pocket-csrf") !== csrfToken) {
      return failure("forbidden: invalid CSRF token", 403);
    }

    const isAssetUpload = method === "POST" && /^\/api\/projects\/[^/]+\/assets$/i.test(url.pathname);
    const hasCsrf = req.headers.get("x-pocket-csrf") === csrfToken;
    const hasEditor = req.headers.get("x-pocket-editor") === "1";
    if (!isAssetUpload && !hasCsrf && !hasEditor) {
      return failure("forbidden: missing CSRF token or editor credential", 403);
    }
  }

  return null;
}

export async function startEditor(options: StartEditorOptions = {}): Promise<EditorServer> {
  const csrfToken = randomUUID();
  const workspaceRoot = resolve(options.workspace ?? process.env.POCKET_EDITOR_WORKSPACE ?? join(root, ".pocket-build/editor-workspace"));
  const configuredProject = options.projectRoot ?? process.env.POCKET_EDITOR_PROJECT_ROOT;
  let projectRoot: string | undefined;
  let projectId: string | undefined;
  if (configuredProject) {
    projectRoot = resolve(configuredProject);
    if (!existsSync(projectRoot) || !lstatSync(projectRoot).isDirectory()) {
      throw new Error(`editor project root is not a directory: ${projectRoot}`);
    }
    if (lstatSync(projectRoot).isSymbolicLink()) throw new Error("editor project root must not be a symlink");
    const editor = await readJsonFile<Record<string, unknown>>(join(projectRoot, "editor.json"), {});
    const pocket = await readJsonFile<Record<string, unknown>>(join(projectRoot, "pocket.json"), {});
    const candidate = typeof editor.id === "string"
      ? editor.id
      : typeof pocket.name === "string"
      ? pocket.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
      : basename(projectRoot).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    projectId = asProjectId(candidate || "external-project");
  }
  const workspace: Workspace = {
    root: workspaceRoot,
    projects: join(workspaceRoot, "projects"),
    builds: join(workspaceRoot, "builds"),
    updates: join(workspaceRoot, "updates"),
    keys: join(workspaceRoot, "keys"),
    states: join(workspaceRoot, "states"),
    ...(projectRoot ? { projectRoot, projectId } : {}),
  };
  await Promise.all([mkdir(workspace.projects, { recursive: true }), mkdir(workspace.builds, { recursive: true }), mkdir(workspace.updates, { recursive: true }), mkdir(workspace.keys, { recursive: true }), mkdir(workspace.states, { recursive: true })]);
  const states = new Map<string, EditorState>();
  const runner = options.buildRunner ?? realBuild;
  const getState = async (id: string): Promise<EditorState> => {
    let state = states.get(id);
    if (!state) {
      state = await loadState(workspace, id);
      states.set(id, state);
    }
    return state;
  };
  const projectDir = (id: string) => projectDirectory(workspace, id);

  const server = Bun.serve({
    hostname: options.host ?? "127.0.0.1",
    port: options.port ?? Number(process.env.POCKET_EDITOR_PORT ?? 8790),
    idleTimeout: 120,
    maxRequestBodySize: maxAssetBytes,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const securityError = validateRequestSecurity(request, url, server.port, csrfToken);
      if (securityError) return securityError;
      const path = url.pathname;
      const method = request.method.toUpperCase();
      try {
        if (path === "/health" && method === "GET") return json({ ok: true, service: "pocket-editor", csrfToken, workspace: workspace.root, ...(workspace.projectRoot ? { projectRoot: workspace.projectRoot, projectId: workspace.projectId } : {}) });
        if (path === "/" && method === "GET") return new Response(await readFile(join(root, "editor/client/index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
        if (["/editor.css", "/editor.js"].includes(path) && method === "GET") {
          const file = join(root, "editor/client", path.slice(1));
          return new Response(await readFile(file), { headers: { "content-type": contentType(file) } });
        }
        if (path.startsWith("/updates/")) {
          const updateParts = path.split("/").filter(Boolean);
          if (updateParts.length < 3) return failure("not found", 404);
          const updateId = asProjectId(updateParts[1]);
          const relPath = updateParts.slice(2).join("/");
          const releasePath = safeArtifactFile(workspace.updates, `${updateId}/${relPath}`);
          return new Response(await readFile(releasePath), { headers: { "content-type": contentType(releasePath), "cache-control": "no-store" } });
        }
        if (path.startsWith("/releases/") && method === "GET") {
          const match = path.match(/^\/releases\/([a-z][a-z0-9-]{0,47})\.tar\.gz$/);
          if (!match) return failure("not found", 404);
          const archive = safeArtifactFile(workspace.updates, `${match[1]}.tar.gz`);
          return new Response(await readFile(archive), { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${match[1]}.tar.gz"` } });
        }
        if (path === "/api/projects" && method === "GET") return json(await listProjects(workspace));
        if (path === "/api/projects" && method === "POST") {
          const body = await parseJsonBody(request);
          const id = asProjectId(body.id);
          if (workspace.projectRoot && id === workspace.projectId) return failure("configured project already exists; edit it instead of creating it", 409);
          const config = await createProject(workspace, id, body);
        const state: EditorState = { revision: 1, builtRevision: null, busy: false, logs: [`created from SDK starter at ${now()}`] };
          states.set(id, state);
          await saveState(workspace, id, state);
          return json({ ...config, status: publicStatus(id, state) }, 201);
        }
        const parts = path.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
        if (parts[0] !== "api" || parts[1] !== "projects" || !parts[2]) {
          return failure("not found", 404);
        }
        const id = parts[2] ? asProjectId(parts[2]) : "";
        const exists = existsSync(projectDir(id));
        if (!exists) return failure("project not found", 404);
        const state = await getState(id);
        if (parts[0] === "api" && parts[1] === "projects") {
          if (parts.length === 3 && method === "GET") {
            const config = await loadConfig(projectDir(id), id);
            return json({ ...config, status: publicStatus(id, state) });
          }
          if (parts[3] === "config") {
            if (method === "GET") return json(await loadConfig(projectDir(id), id));
            if (method === "PUT") {
              const config = validateConfig(id, await parseJsonBody(request));
              await writeConfig(projectDir(id), config);
              state.revision += 1;
              state.error = undefined;
              state.publish = undefined;
              pushLog(state, `config saved: revision ${state.revision}`);
              await saveState(workspace, id, state);
              return json({ ...config, status: publicStatus(id, state) });
            }
          }
          if (parts[3] === "source") {
            const sourcePath = safeProjectFile(projectDir(id), "app.tsx");
            if (method === "GET") {
              const source = await readFile(sourcePath, "utf8");
              return json({ path: "app.tsx", source, bytes: Buffer.byteLength(source), revision: state.revision });
            }
            if (method === "PUT") {
              const body = await parseJsonBody(request, maxSourceBytes);
              const source = asString(body.source, "source", maxSourceBytes);
              if (source.includes("\0")) throw new Error("source contains a NUL byte");
              await writeFile(sourcePath, source);
              state.revision += 1;
              state.error = undefined;
              state.publish = undefined;
              pushLog(state, `source saved: revision ${state.revision}`);
              await saveState(workspace, id, state);
              return json({ path: "app.tsx", bytes: Buffer.byteLength(source), revision: state.revision });
            }
          }
          if (parts[3] === "files") {
            if (parts.length === 4 && method === "GET") {
              return json({ files: await listEditableFiles(projectDir(id)), revision: state.revision });
            }
            const relativePath = parts.slice(4).join("/");
            const filePath = safeProjectFile(projectDir(id), relativePath);
            if (method === "GET") {
              if (!existsSync(filePath)) return failure("file not found", 404);
              const content = await readFile(filePath, "utf8");
              return json({ path: relativePath, content, bytes: Buffer.byteLength(content), revision: state.revision });
            }
            if (method === "PUT") {
              const body = await parseJsonBody(request, maxSourceBytes);
              const content = asString(body.content, "content", maxSourceBytes);
              if (content.includes("\0")) throw new Error("content contains a NUL byte");
              await mkdir(dirname(filePath), { recursive: true });
              await writeFile(filePath, content);
              state.revision += 1;
              state.error = undefined;
              state.publish = undefined;
              pushLog(state, `file saved: ${relativePath} (revision ${state.revision})`);
              await saveState(workspace, id, state);
              return json({ path: relativePath, bytes: Buffer.byteLength(content), revision: state.revision });
            }
          }
          if (parts[3] === "manifest") {
            const manifestPath = safeProjectFile(projectDir(id), "manifest.json");
            if (method === "GET") return new Response(await readFile(manifestPath), { headers: { "content-type": "application/json; charset=utf-8" } });
            if (method === "PUT") {
              const body = await parseJsonBody(request, maxJsonBytes);
              const content = JSON.stringify(body, null, 2) + "\n";
              await writeFile(manifestPath, content);
              state.revision += 1;
              state.error = undefined;
              state.publish = undefined;
              pushLog(state, `manifest saved: revision ${state.revision}`);
              await saveState(workspace, id, state);
              return json({ path: "manifest.json", bytes: Buffer.byteLength(content), revision: state.revision });
            }
          }
          if (parts[3] === "status" && method === "GET") return json(publicStatus(id, state));
          if (parts[3] === "logs" && method === "GET") return json({ logs: state.logs, error: state.error ?? null });
          if (parts[3] === "assets") {
            if (method === "GET") return json({ assets: await listAssets(projectDir(id)) });
            if (method === "POST") {
              const csrfHeader = request.headers.get("x-pocket-csrf");
              const editorHeader = request.headers.get("x-pocket-editor");
              const form = await request.formData();
              const formCsrf = form.get("csrfToken");
              const hasValidProof =
                csrfHeader === csrfToken ||
                editorHeader === "1" ||
                (typeof formCsrf === "string" && formCsrf === csrfToken);
              if (!hasValidProof) {
                return failure("forbidden: missing CSRF token for asset upload", 403);
              }
              const value = form.get("file");
              if (!(value instanceof File)) throw new Error("multipart field 'file' is required");
              if (value.size > maxAssetBytes) throw new Error("asset is too large");
              const fileName = basename(value.name);
              if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(fileName)) throw new Error("asset filename is unsafe");
              const assetPath = safeProjectFile(projectDir(id), `assets/${fileName}`, { allowAssets: true });
              await mkdir(dirname(assetPath), { recursive: true });
              await writeFile(assetPath, new Uint8Array(await value.arrayBuffer()));
              state.revision += 1;
              state.publish = undefined;
              pushLog(state, `asset saved: ${fileName}`);
              await saveState(workspace, id, state);
              return json({ assets: await listAssets(projectDir(id)), revision: state.revision });
            }
          }
          if ((parts[3] === "build" || parts[3] === "compile") && method === "POST") {
            await parseJsonBody(request);
            queueBuild(workspace, id, states, runner);
            return json({ status: publicStatus(id, state) }, 202);
          }
          if ((parts[3] === "publish" || parts[3] === "package") && method === "POST") {
            await parseJsonBody(request);
            if (state.busy) return failure("build is still running", 409);
            const config = await loadConfig(projectDir(id), id);
            const boundOrigin = `http://127.0.0.1:${server.port}`;
            const result = await publishProject(workspace, id, config, state, boundOrigin);
            return json({
              status: publicStatus(id, state),
              manifest: result.envelope,
              manifestUrl: state.publish?.manifestUrl,
              hostConfigUrl: state.publish?.hostConfigUrl,
              updateUrl: `/updates/${id}/latest.json`,
              archiveUrl: `/releases/${id}.tar.gz`,
            });
          }
          if (parts[3] === "artifacts" && method === "GET") {
            const bytes = await readArtifact(workspace, id, parts[4] ?? "", state);
            if (!bytes) return failure("artifact not available; build first", 404);
            return new Response(bytes, { headers: { "content-type": contentType(parts[4] ?? "artifact"), "cache-control": "no-store" } });
          }
          return failure("not found", 404);
        }

        return failure("not found", 404);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = (error as unknown as { status?: number })?.status ?? (message.includes("not found") ? 404 : 400);
        return failure(message, status);
      }
    },
  });
  return server;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const index = args.findIndex((value) => value.startsWith(prefix));
    if (index < 0) return undefined;
    const value = args.splice(index, 1)[0]!.slice(prefix.length);
    if (!value) throw new Error(`--${name} requires a value`);
    return value;
  };
  const projectRoot = option("project-root");
  const workspace = option("workspace");
  const host = option("host");
  const portValue = option("port");
  if (args.length > 0) throw new Error(`unknown editor option ${args[0]}`);
  const port = portValue === undefined ? undefined : Number(portValue);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error("--port must be an integer from 0 through 65535");
  const server = await startEditor({ projectRoot, workspace, host, port });
  console.log(`Pocket Studio listening at http://${server.hostname}:${server.port}`);
  console.log(`workspace: ${resolve(workspace ?? process.env.POCKET_EDITOR_WORKSPACE ?? join(root, ".pocket-build/editor-workspace"))}`);
  if (projectRoot) console.log(`project: ${resolve(projectRoot)}`);
}

