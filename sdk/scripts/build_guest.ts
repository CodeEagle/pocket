import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "..");
// Loaded lazily by buildGuest after the pinned cache has been installed.
// Keeping the binding at module scope lets prepareUiPackage share the same
// transformer without evaluating the cache during static module loading.
let transformFile: any;

export type BuildGuestOptions = {
  /** Source project containing pocket.json and its app entry. */
  projectRoot?: string;
  /** Optional output directory. It is retained for external SDK builds. */
  outDir?: string;
  /** Override pocket.json's app entry (must stay inside projectRoot). */
  entry?: string;
  tickHz?: number;
  /** Copy the four runtime assets to a host asset directory. */
  copyAssetsTo?: string;
  /** Keep a diagnostic copy of the generated JavaScript source. */
  keepSource?: string;
  /** Optional build log sink used by Pocket Studio. */
  log?: (line: string) => void;
};

export type BuildGuestResult = {
  projectRoot: string;
  outDir: string;
  entry: string;
  source: string;
  pak: string;
  bytecode: string;
  metadata: string;
  manifest: string;
  tickHz: number;
};

type GuestReleaseIdentity = {
  version?: string;
  build?: number;
};

function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`build_guest: invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`build_guest: ${path} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Resolve release identity from the project's single release configuration.
 *
 * Older projects kept capabilities in manifest.json while editor.json (or
 * pocket.json) owned the release version/build.  The bytecode metadata must
 * still carry that identity: PocketSession cannot safely enforce an OTA floor
 * when it sees the default build 0.  A manifest value wins so an explicitly
 * pinned guest artifact remains reproducible; editor/pocket are fallbacks for
 * existing projects created before the fields were copied into the manifest.
 */
function releaseIdentity(projectRoot: string, manifest?: Record<string, unknown>): GuestReleaseIdentity {
  const editor = readJsonObject(join(projectRoot, "editor.json"));
  const pocket = readJsonObject(join(projectRoot, "pocket.json"));
  // Select one authoritative object instead of silently mixing a version from
  // one file with a build from another. A manifest that explicitly carries a
  // release field is an intentional artifact pin and therefore wins over the
  // editor/project configuration.
  const source = [manifest, editor, pocket].find((value) =>
    value !== undefined && (Object.hasOwn(value, "version") || Object.hasOwn(value, "build")),
  );
  if (!source) return {};
  const hasVersion = Object.hasOwn(source, "version");
  const hasBuild = Object.hasOwn(source, "build");
  if (hasVersion && (typeof source.version !== "string" || source.version.length === 0)) {
    throw new Error("build_guest: release version must be a non-empty string");
  }
  if (hasBuild && (!Number.isSafeInteger(source.build) || Number(source.build) < 1)) {
    throw new Error("build_guest: release build must be a positive safe integer");
  }
  return {
    ...(hasVersion ? { version: source.version as string } : {}),
    ...(hasBuild ? { build: source.build as number } : {}),
  };
}

function projectEntry(projectRoot: string, requested?: string): string {
  let entry = requested;
  if (!entry) {
    const manifestPath = join(projectRoot, "pocket.json");
    if (existsSync(manifestPath)) {
      const value = JSON.parse(readFileSync(manifestPath, "utf8")) as { app?: { entry?: unknown } };
      if (typeof value.app?.entry === "string") entry = value.app.entry;
    }
  }
  entry ??= "app.tsx";
  const absolute = resolve(projectRoot, entry);
  const rel = relative(resolve(projectRoot), absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("build_guest: app entry must stay inside projectRoot");
  if (!existsSync(absolute)) throw new Error(`build_guest: app entry does not exist: ${absolute}`);
  return absolute;
}

function runOrThrow(command: string[], cwd: string, log?: (line: string) => void): void {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    stdio: log ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (log) {
    for (const line of `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split(/\r?\n/).filter(Boolean)) log(line);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command[0]} exited with status ${result.status ?? 1}`);
}

function report(message: string, log?: (line: string) => void): void {
  console.log(message);
  log?.(message);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function copyTree(source: string, target: string): void {
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink()) throw new Error(`build_guest: @pocket/ui contains unsupported symlink: ${source}`);
  if (sourceStat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) copyTree(join(source, entry), join(target, entry));
    return;
  }
  cpSync(source, target, { force: true });
}

/**
 * The pinned low-level compiler has a deliberate package boundary: pass 1
 * walks relative imports and the framework package, while Bun pass 2 resolves
 * arbitrary node_modules packages.  `@pocket/ui` is an SDK package rather
 * than a framework package, so preload its public entry through a temporary
 * relative import.  This lets the unchanged compiler collect the package's
 * class literals and glyphs into the same PAK as the app.  The wrapper is
 * written beside the real entry so image/font manifests keep their normal
 * app-directory lookup semantics.
 */
function publicUiPackageRoot(projectRoot: string): string | undefined {
  const candidates = [join(projectRoot, "vendor/pocket-ui")];
  const localPackage = join(projectRoot, "node_modules/@pocket/ui");
  // The in-repo demo and external projects may install the UI locally. The
  // SDK package is also an allowed build-time fallback; compiled artifacts do
  // not retain a dependency on this checkout.
  if (projectRoot === root || projectRoot.startsWith(`${root}/`)) {
    candidates.push(join(root, "node_modules/@pocket/ui"), join(root, "packages/pocket_ui"));
  }
  candidates.push(localPackage);
  // Pocket Studio creates projects from the checked-in guest template. Its
  // source intentionally imports the SDK package but does not vendor a copy;
  // the editor is allowed to use this local SDK source at build time. The
  // generated project still contains only the transformed build artifacts.
  if (projectRoot !== root && !projectRoot.startsWith(`${root}/`)) {
    candidates.push(join(root, "node_modules/@pocket/ui"), join(root, "packages/pocket_ui"));
  }
  const candidate = candidates.find((path) => existsSync(join(path, "package.json")));
  // Bun's local file dependency can symlink each package file instead of the
  // package directory. Resolve its manifest to the actual source directory
  // before replacing node_modules for JSX lowering; otherwise its symlinked
  // entries are rejected or an old installed copy becomes the source.
  return candidate ? dirname(realpathSync(join(candidate, "package.json"))) : undefined;
}

type UiPreparation = {
  packageRoot?: string;
  cleanup: () => void;
};

function acquireUiLock(projectRoot: string): { release: () => void } {
  const path = join(projectRoot, ".pocket-ui.lock");
  const lock = (): void => {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = "unknown";
      try { owner = readFileSync(path, "utf8").trim() || owner; } catch {}
      const pid = Number(owner);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 0);
        } catch (probeError) {
          if ((probeError as NodeJS.ErrnoException).code === "ESRCH") {
            unlinkSync(path);
            return lock();
          }
        }
      }
      throw new Error(`build_guest: @pocket/ui preparation is already running for ${projectRoot} (lock owner ${owner})`);
    }
  };
  lock();
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try { unlinkSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

/**
 * Materialize the public SDK UI package at the project-local package boundary.
 *
 * The pinned compiler deliberately does not lower arbitrary node_modules in
 * pass 2. Keeping this one preparation here means the CLI, editor and the
 * repository build all use exactly the same JSX transform and package copy;
 * none of them need a second compiler or a source-evaluation fallback.
 */
async function prepareUiPackage(projectRoot: string, entry: string, log?: (line: string) => void): Promise<UiPreparation> {
  const source = publicUiPackageRoot(projectRoot);
  if (!source) {
    if (usesPublicUi(entry)) throw new Error("build_guest: app imports @pocket/ui but no vendored package source was found");
    return { cleanup: () => {} };
  }
  const targetRoot = join(projectRoot, "node_modules/@pocket/ui");
  const sourceRoot = realpathSync(source);
  const targetParent = dirname(targetRoot);
  const lock = acquireUiLock(projectRoot);
  // Keep the backup beside the consumer project: /tmp is a separate APFS
  // volume in the development environment, so cross-device rename would
  // otherwise fail for an existing node_modules package.
  const backupRoot = mkdtempSync(join(projectRoot, ".pocket-ui-backup-"));
  const backup = join(backupRoot, "ui");
  const hadTarget = pathExists(targetRoot);
  const hadParent = pathExists(targetParent);
  const targetWasSymlink = hadTarget && lstatSync(targetRoot).isSymbolicLink();
  const sourceIsTarget = hadTarget && sourceRoot === realpathSync(targetRoot);
  let cleaned = false;
  const restore = (): void => {
    if (!hadTarget || !pathExists(backup)) return;
    rmSync(targetRoot, { recursive: true, force: true });
    renameSync(backup, targetRoot);
  };
  try {
    mkdirSync(targetParent, { recursive: true });
    if (hadTarget) renameSync(targetRoot, backup);
    // When an existing package is the only source, it is also targetRoot.
    // After the backup rename, read the real directory from backup; a moved
    // symlink still points at sourceRoot and must be dereferenced instead.
    const copySource = sourceIsTarget && !targetWasSymlink ? backup : sourceRoot;
    copyTree(copySource, targetRoot);
    const transform = async (directory: string): Promise<void> => {
      for (const name of readdirSync(directory)) {
        const sourceFile = join(directory, name);
        const targetFile = join(targetRoot, relative(copySource, sourceFile));
        const stat = lstatSync(sourceFile);
        if (stat.isDirectory()) {
          await transform(sourceFile);
        } else if (stat.isFile() && /\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
          const transformed = await transformFile(
            sourceFile,
            readFileSync(sourceFile, "utf8"),
            "solid",
            { entry },
          );
          writeFileSync(targetFile, transformed.code);
        }
      }
    };
    await transform(copySource);
    const packageJson = join(targetRoot, "package.json");
    const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as Record<string, unknown>;
    writeFileSync(packageJson, `${JSON.stringify({ ...manifest, name: "@pocket/ui", type: "module", main: "./src/index.ts" }, null, 2)}\n`);
    log?.(`build_guest: prepared @pocket/ui from ${sourceRoot}`);
  } catch (error) {
    // Restore a package manager symlink/directory before surfacing the build
    // error; an interrupted compiler must not corrupt the consumer project.
    rmSync(targetRoot, { recursive: true, force: true });
    restore();
    rmSync(backupRoot, { recursive: true, force: true });
    lock.release();
    throw error;
  }
  return {
    packageRoot: targetRoot,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(targetRoot, { recursive: true, force: true });
      restore();
      rmSync(backupRoot, { recursive: true, force: true });
      if (!hadParent && pathExists(targetParent) && readdirSync(targetParent).length === 0) rmSync(targetParent, { recursive: true, force: true });
      lock.release();
    },
  };
}

function usesPublicUi(entry: string): boolean {
  const visited = new Set<string>();
  const resolveLocal = (from: string, spec: string): string | undefined => {
    if (!spec.startsWith("./") && !spec.startsWith("../")) return undefined;
    const base = resolve(dirname(from), spec);
    return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, join(base, "index.ts"), join(base, "index.tsx")]
      .find((candidate) => existsSync(candidate));
  };
  const visit = (file: string): boolean => {
    const absolute = resolve(file);
    if (visited.has(absolute)) return false;
    visited.add(absolute);
    const source = readFileSync(absolute, "utf8");
    if (/(?:from|import)\s*["']@pocket\/ui(?:["'\/])/.test(source)) return true;
    const imports = /(?:^|\n)\s*(?:import|export)\b[^;'"\n]*?(?:from\s*)?["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = imports.exec(source))) {
      const child = resolveLocal(absolute, match[1]!);
      if (child && visit(child)) return true;
    }
    return false;
  };
  return visit(entry);
}

function moduleSpecifier(fromDirectory: string, target: string): string {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

interface CompilerEntry {
  path: string;
  cleanup: () => void;
}

function prepareCompilerEntry(projectRoot: string, entry: string, preparedPackageRoot?: string, log?: (line: string) => void): CompilerEntry {
  const packageRoot = preparedPackageRoot ?? publicUiPackageRoot(projectRoot);
  if (!packageRoot) {
    if (!usesPublicUi(entry)) return { path: entry, cleanup: () => {} };
    throw new Error("build_guest: app imports @pocket/ui but no vendored package source was found");
  }
  const packageEntry = [
    join(packageRoot, "src/index.ts"),
    join(packageRoot, "src/index.tsx"),
    join(packageRoot, "index.ts"),
    join(packageRoot, "index.tsx"),
  ].find(existsSync);
  if (!packageEntry) throw new Error(`build_guest: @pocket/ui has no source entry under ${packageRoot}`);

  // mkdtemp gives us an unguessable sibling name without leaving a directory
  // in the application tree. The compiler sees a normal app-directory file;
  // cleanup runs after Bun has finished both passes.
  const marker = mkdtempSync(join(dirname(entry), "pocket-ui-entry-"));
  rmSync(marker, { recursive: true, force: true });
  const wrapper = `${marker}.tsx`;
  writeFileSync(
    wrapper,
    `import ${JSON.stringify(moduleSpecifier(dirname(wrapper), packageEntry))};\n` +
      `import ${JSON.stringify(moduleSpecifier(dirname(wrapper), entry))};\n`,
  );
  report(`build_guest: pass-1 preload=${packageEntry}`, log);
  return {
    path: wrapper,
    cleanup: () => rmSync(wrapper, { force: true }),
  };
}

export function parseBuildGuestArgs(args: string[]): BuildGuestOptions {
  const result: BuildGuestOptions = {};
  for (const arg of args) {
    if (arg.startsWith("--project-root=")) result.projectRoot = arg.slice("--project-root=".length);
    else if (arg.startsWith("--outdir=")) result.outDir = arg.slice("--outdir=".length);
    else if (arg.startsWith("--entry=")) result.entry = arg.slice("--entry=".length);
    else if (arg.startsWith("--tick-hz=")) result.tickHz = Number(arg.slice("--tick-hz=".length));
    else if (arg.startsWith("--copy-assets-to=")) result.copyAssetsTo = arg.slice("--copy-assets-to=".length);
    else if (arg.startsWith("--keep-source=")) result.keepSource = arg.slice("--keep-source=".length);
    else throw new Error(`build_guest: unknown option ${arg}`);
  }
  return result;
}

export async function buildGuest(options: BuildGuestOptions = {}): Promise<BuildGuestResult> {
  // The SDK has no application entry of its own. Consumers and the sibling
  // demo pass an explicit projectRoot; a zero-argument build is supported only
  // for a checkout that intentionally places app.tsx at its root.
  const defaultProject = existsSync(join(root, "app.tsx")) ? root : undefined;
  if (!options.projectRoot && !defaultProject) {
    throw new Error("build_guest: projectRoot is required for the SDK; use pocket.ts build <project>");
  }
  const projectRoot = resolve(options.projectRoot ?? defaultProject!);
  const upstream = join(root, ".cache/pocketjs");
  report(`build_guest: validating the local pinned PocketJS cache (project=${projectRoot})`, options.log);
  runOrThrow(["python3", join(root, "scripts/prepare_upstream.py")], root, options.log);
  const compiler = join(upstream, "tools/build.ts");
  if (!existsSync(compiler)) throw new Error(`build_guest: pinned PocketJS compiler not found after bootstrap: ${compiler}`);

  // Dependencies are part of the pinned cache, never the application. A
  // frozen install keeps compiler behavior reproducible for external projects.
  if (existsSync(join(upstream, "package.json")) && existsSync(join(upstream, "bun.lock"))) {
    runOrThrow(["bun", "install", "--frozen-lockfile"], upstream, options.log);
  }

  // The compiler's JSX transformer imports Babel from the pinned cache. Keep
  // this import after the bootstrap/install step: Bun evaluates static imports
  // before `prepare_upstream.py` can materialize the cache's node_modules, so
  // a clean standalone checkout otherwise fails before buildGuest starts.
  transformFile = (await import("../.cache/pocketjs/framework/compiler/jsx-plugin.ts")).transformFile;
  if (typeof transformFile !== "function") {
    throw new Error("build_guest: pinned JSX transformer does not export transformFile");
  }

  const ownsOutput = options.outDir === undefined;
  const output = resolve(options.outDir ?? mkdtempSync(join(tmpdir(), "pocketjs-guest-build-")));
  mkdirSync(output, { recursive: true });
  let compilerEntryCleanup = (): void => {};
  let uiCleanup = (): void => {};
  try {
    const tickHz = options.tickHz ?? Number(process.env.POCKET_TICK_HZ ?? "60");
    if (!Number.isInteger(tickHz) || tickHz < 1 || tickHz > 120) {
      throw new Error(`POCKET_TICK_HZ must be an integer from 1 through 120 (got ${tickHz})`);
    }
    const entry = projectEntry(projectRoot, options.entry);
    const preparedUi = await prepareUiPackage(projectRoot, entry, options.log);
    uiCleanup = preparedUi.cleanup;
    const compilerEntry = prepareCompilerEntry(projectRoot, entry, preparedUi.packageRoot, options.log);
    compilerEntryCleanup = compilerEntry.cleanup;
    report(`build_guest: compiler=${compiler}`, options.log);
    report(`build_guest: source=${entry}`, options.log);
    runOrThrow(["bun", compiler, compilerEntry.path, "--framework=solid", `--project-root=${projectRoot}`, `--outdir=${output}`, `--hz=${tickHz}`, "--strict-classes"], root, options.log);

    const compilerBase = compilerEntry.path.replace(/^.*[\\/]/, "").replace(/\.(?:tsx?|vue)$/, "");
    const compilerSource = join(output, `${compilerBase}.js`);
    const compilerPak = join(output, `${compilerBase}.pak`);
    const source = join(output, "app.js");
    const pak = join(output, "app.pak");
    if (!existsSync(compilerSource) || !existsSync(compilerPak)) {
      throw new Error(`pinned compiler did not produce ${compilerBase}.js and ${compilerBase}.pak`);
    }
    if (compilerSource !== source) copyFileSync(compilerSource, source);
    if (compilerPak !== pak) copyFileSync(compilerPak, pak);
    const bytecode = join(output, "app.qjbc");
    const metadata = join(output, "app.bytecode.json");
    // Do not duplicate the ABI generation here. pocketjs_bytecode defaults to
    // pocket_spec::BINDING_GENERATION, the same contract consumed by the
    // runtime, so a generation bump cannot leave the build script stale.
    runOrThrow(["cargo", "run", "--locked", "--manifest-path", join(root, "native/Cargo.toml"), "--bin", "pocketjs_bytecode", "--", "--input", source, "--output", bytecode, "--metadata", metadata, "--kind", "script", "--tick-hz", String(tickHz)], root, options.log);
    if (!existsSync(bytecode) || !existsSync(metadata)) throw new Error("QuickJS compiler did not produce app.qjbc and app.bytecode.json");
    const guestManifest = join(projectRoot, "manifest.json");
    const manifestObj = readJsonObject(guestManifest);
    const identity = releaseIdentity(projectRoot, manifestObj);
    const metadataObj = readJsonObject(metadata) ?? {};
    let metadataModified = false;
    if (identity.version !== undefined && metadataObj.version !== identity.version) {
      metadataObj.version = identity.version;
      metadataModified = true;
    }
    if (identity.build !== undefined && metadataObj.build !== identity.build) {
      metadataObj.build = identity.build;
      metadataModified = true;
    }
    if (metadataModified) writeFileSync(metadata, `${JSON.stringify(metadataObj, null, 2)}\n`);
    const assets = options.copyAssetsTo ? resolve(options.copyAssetsTo) : undefined;
    if (assets) {
      mkdirSync(assets, { recursive: true });
      copyFileSync(bytecode, join(assets, "app.qjbc"));
      copyFileSync(metadata, join(assets, "app.bytecode.json"));
      if (!manifestObj) throw new Error(`build_guest: missing or invalid guest manifest: ${guestManifest}`);
      // Keep the copied manifest self-describing for package/update tools while
      // leaving the consumer's source manifest untouched.
      const outputManifest = { ...manifestObj } as Record<string, unknown>;
      if (identity.version !== undefined) outputManifest.version = identity.version;
      if (identity.build !== undefined) outputManifest.build = identity.build;
      writeFileSync(join(assets, "guest-manifest.json"), `${JSON.stringify(outputManifest, null, 2)}\n`);
      copyFileSync(pak, join(assets, "app.pak"));
    }
    if (options.keepSource) {
      mkdirSync(resolve(options.keepSource, ".."), { recursive: true });
      copyFileSync(source, resolve(options.keepSource));
    }
    return { projectRoot, outDir: output, entry, source, pak, bytecode, metadata, manifest: join(projectRoot, "manifest.json"), tickHz };
  } finally {
    // The temporary package preload must never become application source.
    compilerEntryCleanup();
    uiCleanup();
    if (ownsOutput) rmSync(output, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const parsed = parseBuildGuestArgs(process.argv.slice(2));
    await buildGuest(parsed);
  } catch (error) {
    console.error(`build_guest: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

