import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  /** Integer raster density used while baking glyphs and image assets. */
  rasterDensity?: number;
  /** Copy runtime artifacts and the project's ordinary assets to a host directory. */
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
  /** Pinned domains.worker output compiled by the same QuickJS ABI. The
   * source bundle is retained for diagnostics only; production assets contain
   * the admitted bytecode envelope, never a source fallback. */
  worker?: {
    source: string;
    bytecode: string;
    metadata: string;
  };
  tickHz: number;
};

export type GuestReleaseIdentity = {
  version: string;
  build: number;
};

function checkedRasterDensity(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    throw new Error(`build_guest: rasterDensity must be an integer from 1 through 4 (got ${value})`);
  }
  return value;
}

const DEFAULT_RELEASE_IDENTITY: GuestReleaseIdentity = { version: "0.1.0", build: 1 };

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
 * New projects keep the release identity in editor.json. pocket.json is the
 * compatibility source for projects created before Editor was introduced;
 * manifest.json is consulted only as a legacy fallback for projects that
 * predate both files carrying release fields. The source guest manifest is
 * otherwise a protocol/capability declaration, so it must not shadow an
 * Editor build update with a stale copied artifact.
 *
 * A source is selected when it contains either release field. Missing fields
 * in that source use the explicit compatibility default; they are deliberately
 * not filled from a lower priority file. Projects with no release fields use
 * that same default, so every caller receives the same complete identity.
 */
export function resolveReleaseIdentity(projectRoot: string, manifest?: Record<string, unknown>): GuestReleaseIdentity {
  const editor = readJsonObject(join(projectRoot, "editor.json"));
  const pocket = readJsonObject(join(projectRoot, "pocket.json"));
  // Select one authoritative object instead of silently mixing a version from
  // one file with a build from another. The order is deliberate: Editor is
  // authoritative, pocket.json is the legacy project fallback, and a release
  // field in manifest.json is accepted only for old projects with neither.
  const source = [editor, pocket, manifest].find((value) =>
    value !== undefined && (Object.hasOwn(value, "version") || Object.hasOwn(value, "build")),
  );
  if (!source) return { ...DEFAULT_RELEASE_IDENTITY };
  const hasVersion = Object.hasOwn(source, "version");
  const hasBuild = Object.hasOwn(source, "build");
  if (hasVersion && (typeof source.version !== "string" || source.version.length === 0)) {
    throw new Error("build_guest: release version must be a non-empty string");
  }
  if (hasBuild && (!Number.isSafeInteger(source.build) || Number(source.build) < 1)) {
    throw new Error("build_guest: release build must be a positive safe integer");
  }
  return {
    version: hasVersion ? source.version as string : DEFAULT_RELEASE_IDENTITY.version,
    build: hasBuild ? source.build as number : DEFAULT_RELEASE_IDENTITY.build,
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
  // A file dependency names source, while node_modules can be an older Bun
  // copy. Honor that declared source so a rebuild really includes SDK fixes
  // without replacing a consumer's vendored/custom UI package.
  const projectManifest = join(projectRoot, "package.json");
  if (existsSync(projectManifest)) {
    const manifest = JSON.parse(readFileSync(projectManifest, "utf8"));
    const dependency = manifest.dependencies?.["@pocket/ui"] ?? manifest.devDependencies?.["@pocket/ui"];
    if (typeof dependency === "string" && dependency.startsWith("file:")) {
      candidates.push(resolve(projectRoot, dependency.slice(5)));
    }
  }
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
    else if (arg.startsWith("--density=")) result.rasterDensity = checkedRasterDensity(Number(arg.slice("--density=".length)));
    else if (arg.startsWith("--copy-assets-to=")) result.copyAssetsTo = arg.slice("--copy-assets-to=".length);
    else if (arg.startsWith("--keep-source=")) result.keepSource = arg.slice("--keep-source=".length);
    else throw new Error(`build_guest: unknown option ${arg}`);
  }
  return result;
}

/**
 * Copy ordinary project resources without passing them through the image/PAK
 * baker. Video and other binary assets must stay byte-for-byte files so
 * Flutter's rootBundle and an OTA PocketPackageSource can open them directly.
 */
function copyProjectAssets(projectRoot: string, destinationRoot: string): void {
  const sourceRoot = resolve(projectRoot, "assets");
  if (!existsSync(sourceRoot)) return;
  const sourceStat = lstatSync(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`build_guest: project assets must be a real directory: ${sourceRoot}`);
  }
  const destination = resolve(destinationRoot);
  const nested = relative(sourceRoot, destination);
  // `copyAssetsTo=project/assets` is the retained runtime-artifact contract;
  // the ordinary source tree is already at the requested destination, so
  // there is nothing to copy and, importantly, no recursive walk to perform.
  if (nested === "") return;
  if (!nested.startsWith("..") && !isAbsolute(nested)) {
    throw new Error("build_guest: project asset destination must not be inside project assets");
  }
  mkdirSync(destination, { recursive: true });
  const copyTree = (source: string): void => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const sourcePath = join(source, entry.name);
      const relativePath = relative(sourceRoot, sourcePath);
      const targetPath = join(destination, relativePath);
      if (entry.isSymbolicLink()) {
        throw new Error(`build_guest: project assets contain unsupported symlink: ${sourcePath}`);
      }
      if (entry.isDirectory()) {
        mkdirSync(targetPath, { recursive: true });
        copyTree(sourcePath);
      } else if (entry.isFile()) {
        mkdirSync(dirname(targetPath), { recursive: true });
        copyFileSync(sourcePath, targetPath);
      } else {
        throw new Error(`build_guest: unsupported project asset: ${sourcePath}`);
      }
    }
  };
  copyTree(sourceRoot);
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
  const [{ WORKER_PROTOCOL_VERSION, WORKER_RESOURCES, workerDeclarationSchema }, { validateSchema }] = await Promise.all([
    import("../.cache/pocketjs/contracts/spec/worker.ts"),
    import("../.cache/pocketjs/framework/src/manifest/schema.ts"),
  ]);

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
    const rasterDensity = checkedRasterDensity(options.rasterDensity ?? 1);
    const entry = projectEntry(projectRoot, options.entry);
    const preparedUi = await prepareUiPackage(projectRoot, entry, options.log);
    uiCleanup = preparedUi.cleanup;
    const compilerEntry = prepareCompilerEntry(projectRoot, entry, preparedUi.packageRoot, options.log);
    compilerEntryCleanup = compilerEntry.cleanup;
    report(`build_guest: compiler=${compiler}`, options.log);
    report(`build_guest: source=${entry}`, options.log);
    runOrThrow(["bun", compiler, compilerEntry.path, "--framework=solid", `--project-root=${projectRoot}`, `--outdir=${output}`, `--hz=${tickHz}`, `--density=${rasterDensity}`, "--strict-classes"], root, options.log);

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
    const sourcePocket = readJsonObject(join(projectRoot, "pocket.json"));
    const domains = sourcePocket?.domains;
    const workerDeclaration = domains && typeof domains === "object" && !Array.isArray(domains)
      ? (domains as Record<string, unknown>).worker
      : undefined;
    let worker: BuildGuestResult["worker"];
    if (workerDeclaration !== undefined) {
      const diagnostics: Parameters<typeof validateSchema>[3] = [];
      validateSchema(workerDeclaration, workerDeclarationSchema, "/domains/worker", diagnostics);
      if (diagnostics.length) {
        throw new Error(diagnostics.map((item) => `${item.path}: ${item.message}`).join("; "));
      }
      const declaration = workerDeclaration as {
        entry: string;
        nodes: { name: string; kind: keyof typeof WORKER_RESOURCES }[];
        channels?: unknown[];
      };
      const workerCapabilities = new Set(declaration.nodes.map((node) => WORKER_RESOURCES[node.kind].capability));
      const sourceManifestPath = join(projectRoot, "manifest.json");
      const sourceManifest = readJsonObject(sourceManifestPath);
      const capabilityObject = sourceManifest?.capabilities;
      const required = capabilityObject && typeof capabilityObject === "object" && !Array.isArray(capabilityObject)
        ? (capabilityObject as Record<string, unknown>).requires
        : undefined;
      if (!Array.isArray(required)) {
        throw new Error("build_guest: domains.worker requires manifest.json capabilities.requires");
      }
      for (const capability of workerCapabilities) {
        if (!required.includes(capability)) {
          throw new Error(`build_guest: worker node requires declared capability ${capability}`);
        }
      }
      const workerSource = join(output, `${compilerBase}.worker.js`);
      const workerBytecode = join(output, "app.worker.qjbc");
      const workerMetadata = join(output, "app.worker.bytecode.json");
      if (!existsSync(workerSource)) {
        throw new Error(`pinned compiler declared domains.worker but did not produce ${compilerBase}.worker.js`);
      }
      runOrThrow(["cargo", "run", "--locked", "--manifest-path", join(root, "native/Cargo.toml"), "--bin", "pocketjs_bytecode", "--", "--input", workerSource, "--output", workerBytecode, "--metadata", workerMetadata, "--kind", "script", "--tick-hz", String(tickHz)], root, options.log);
      if (!existsSync(workerBytecode) || !existsSync(workerMetadata)) {
        throw new Error("QuickJS compiler did not produce app.worker.qjbc and app.worker.bytecode.json");
      }
      worker = { source: workerSource, bytecode: workerBytecode, metadata: workerMetadata };
    }
    const bytecode = join(output, "app.qjbc");
    const metadata = join(output, "app.bytecode.json");
    // Do not duplicate the ABI generation here. pocketjs_bytecode defaults to
    // pocket_spec::BINDING_GENERATION, the same contract consumed by the
    // runtime, so a generation bump cannot leave the build script stale.
    runOrThrow(["cargo", "run", "--locked", "--manifest-path", join(root, "native/Cargo.toml"), "--bin", "pocketjs_bytecode", "--", "--input", source, "--output", bytecode, "--metadata", metadata, "--kind", "script", "--tick-hz", String(tickHz)], root, options.log);
    if (!existsSync(bytecode) || !existsSync(metadata)) throw new Error("QuickJS compiler did not produce app.qjbc and app.bytecode.json");
    const guestManifest = join(projectRoot, "manifest.json");
    const manifestObj = readJsonObject(guestManifest);
    const identity = resolveReleaseIdentity(projectRoot, manifestObj);
    const metadataObj = readJsonObject(metadata) ?? {};
    let workerDescriptor: Record<string, unknown> | undefined;
    if (worker) {
      const workerMeta = readJsonObject(worker.metadata) ?? {};
      const workerBytes = readFileSync(worker.bytecode);
      workerDescriptor = {
        kind: "quickjs-bytecode",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        bytecode: {
          path: "app.worker.qjbc",
          bytes: workerBytes.byteLength,
          sha256: createHash("sha256").update(workerBytes).digest("hex"),
        },
        declaration: workerDeclaration,
        requiredCaps: Array.from(new Set(["runtime.worker", ...(workerDeclaration as {
          nodes: { kind: keyof typeof WORKER_RESOURCES }[];
        }).nodes.map((node) => WORKER_RESOURCES[node.kind].capability)])).sort(),
        formatVersion: workerMeta.formatVersion,
        sourceSha256: workerMeta.sourceSha256,
        payloadSha256: workerMeta.payloadSha256,
        runtimeAbi: workerMeta.runtimeAbi,
        engineAbi: workerMeta.engineAbi,
        bindingGeneration: workerMeta.bindingGeneration,
        tickHz: workerMeta.tickHz,
      };
      metadataObj.worker = workerDescriptor;
    }
    let metadataModified = workerDescriptor !== undefined;
    if (metadataObj.version !== identity.version) {
      metadataObj.version = identity.version;
      metadataModified = true;
    }
    if (metadataObj.build !== identity.build) {
      metadataObj.build = identity.build;
      metadataModified = true;
    }
    if (metadataModified) writeFileSync(metadata, `${JSON.stringify(metadataObj, null, 2)}\n`);
    const generatedManifest = join(output, "guest-manifest.json");
    if (manifestObj) {
      // Keep a generated manifest beside the bytecode even when the caller
      // does not request host assets. The Editor runner packages this output;
      // source manifest.json remains protocol/capability-only.
      const outputManifest = { ...manifestObj } as Record<string, unknown>;
      outputManifest.version = identity.version;
      outputManifest.build = identity.build;
      if (workerDeclaration !== undefined) {
        outputManifest.domains = { ...(outputManifest.domains as Record<string, unknown> | undefined), worker: workerDeclaration };
      }
      if (workerDescriptor) outputManifest.worker = workerDescriptor;
      if (workerDescriptor) {
        const capabilities = outputManifest.capabilities && typeof outputManifest.capabilities === "object"
          ? outputManifest.capabilities as Record<string, unknown>
          : {};
        const requires = Array.isArray(capabilities.requires)
          ? capabilities.requires.filter((value): value is string => typeof value === "string")
          : [];
        const optional = Array.isArray(capabilities.optional)
          ? capabilities.optional.filter((value): value is string => typeof value === "string" && value !== "runtime.worker")
          : [];
        outputManifest.capabilities = {
          ...capabilities,
          requires: Array.from(new Set([...requires, "runtime.worker"])).sort(),
          optional,
        };
      }
      writeFileSync(generatedManifest, `${JSON.stringify(outputManifest, null, 2)}\n`);
    }
    const assets = options.copyAssetsTo ? resolve(options.copyAssetsTo) : undefined;
    if (assets) {
      mkdirSync(assets, { recursive: true });
      copyFileSync(bytecode, join(assets, "app.qjbc"));
      copyFileSync(metadata, join(assets, "app.bytecode.json"));
      if (worker) {
        copyFileSync(worker.bytecode, join(assets, "app.worker.qjbc"));
        copyFileSync(worker.metadata, join(assets, "app.worker.bytecode.json"));
      }
      if (!manifestObj) throw new Error(`build_guest: missing or invalid guest manifest: ${guestManifest}`);
      copyFileSync(generatedManifest, join(assets, "guest-manifest.json"));
      copyFileSync(pak, join(assets, "app.pak"));
      // Keep ordinary project resources beside the runtime artifacts. This
      // destination is also the Flutter asset root for built-in consumers;
      // binary media stays a loose file and never enters the image PAK.
      copyProjectAssets(projectRoot, assets);
    }
    if (options.keepSource) {
      mkdirSync(resolve(options.keepSource, ".."), { recursive: true });
      copyFileSync(source, resolve(options.keepSource));
    }
    return { projectRoot, outDir: output, entry, source, pak, bytecode, metadata, manifest: join(projectRoot, "manifest.json"), ...(worker ? { worker } : {}), tickHz };
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

