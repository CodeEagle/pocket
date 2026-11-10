/**
 * Assemble the release-side, platform-specific npm tool package.
 *
 * This command is intentionally run by release CI after the pinned compiler
 * cache and native binaries have been prepared. Consumer machines receive the
 * resulting package and do not need Rust, Cargo, Python or patch.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SDK_VERSION } from "./prebuilt_tools.mjs";

const SDK_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_OUT = join(SDK_ROOT, ".pocket-build", "toolchain-package");
const PINNED_REVISION = "99924de47c62fa36f526a8791055d91cbbdb3836";

export type PackageToolchainOptions = { sdkRoot: string; out: string; force: boolean; version: string };
export type PackageToolchainDependencies = {
  readAbi?: (sdkRoot: string) => string;
  platform?: string;
  arch?: string;
};

function fail(message: string): never {
  throw new Error(`package_toolchain: ${message}`);
}

function option(args: string[], name: string, fallback: string): string {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3) || fail(`--${name} requires a value`);
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`--${name} requires a value`);
  return value;
}

function copyTree(source: string, target: string): void {
  if (!existsSync(source) || !lstatSync(source).isDirectory()) fail(`missing compiler source directory: ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    force: true,
    filter: (path) => !relative(source, path).split(/[\\/]/).some((part) =>
      part === "node_modules" || part === "target" || part === ".cache" || part === ".pocket-build" || part === ".git" || part === ".gitignore" || part === ".npmignore"),
  });
}

function copyFile(source: string, target: string): void {
  if (!existsSync(source) || !lstatSync(source).isFile()) fail(`missing required file: ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { force: true });
}

function hashFile(path: string): { sha256: string; size: number } {
  const bytes = readFileSync(path);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
}

function findNobleBinding(sdkRoot: string, platform: string, arch: string): string | undefined {
  const nobleRoot = join(sdkRoot, "node_modules", "@abandonware", "noble");
  const tuple = `${platform}-${arch}`;
  const candidates = [
    join(nobleRoot, "build", "Release", "binding.node"),
    join(nobleRoot, "prebuilds", tuple, "node.napi.node"),
    join(nobleRoot, "prebuilds", tuple, "napi.node"),
    join(nobleRoot, "lib", platform === "darwin" ? "mac" : platform, "native", "binding.node"),
  ];
  return candidates.find((path) => existsSync(path) && lstatSync(path).isFile());
}

function filesUnder(root: string, current = root): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(root, path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

export type BytecodeRunnerResult = { status: number | null; stdout?: string; stderr?: string; error?: Error };
export type BytecodeRunner = (binary: string, args: string[]) => BytecodeRunnerResult;

/** Read ABI from the exact bytecode binary that is about to be shipped. */
export function readBytecodeAbi(
  sdkRoot: string,
  runBinary: BytecodeRunner = (binary, args) => spawnSync(binary, args, { encoding: "utf8" }),
): string {
  const binary = join(sdkRoot, "native", "target", "release", process.platform === "win32" ? "pocketjs_bytecode.exe" : "pocketjs_bytecode");
  if (!existsSync(binary)) fail(`missing bytecode compiler for ABI discovery: ${binary}`);
  const temporary = mkdtempSync(join(tmpdir(), "pocket-toolchain-abi-"));
  try {
    const source = join(temporary, "abi.js");
    const metadata = join(temporary, "abi.json");
    writeFileSync(source, "globalThis;\n");
    const result = runBinary(binary, ["--input", source, "--output", join(temporary, "abi.qjbc"), "--metadata", metadata]);
    if (result.error) fail(`bytecode compiler ABI probe failed: ${result.error.message}`);
    if (result.status !== 0 || !existsSync(metadata)) fail(`bytecode compiler ABI probe failed: ${result.stderr || result.stdout || "unknown error"}`);
    const value = JSON.parse(readFileSync(metadata, "utf8")) as Record<string, unknown>;
    if (typeof value.runtimeAbi !== "string") fail("bytecode compiler metadata has no runtimeAbi");
    return value.runtimeAbi;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function parseOptions(args: string[]): PackageToolchainOptions {
  const known = new Set(["--sdk-root", "--out", "--version", "--force", "--help"]);
  for (const arg of args) {
    if (arg.startsWith("--sdk-root=") || arg.startsWith("--out=") || arg.startsWith("--version=")) continue;
    if (arg.startsWith("--") && !known.has(arg)) fail(`unknown option: ${arg}`);
  }
  return {
    sdkRoot: resolve(option(args, "sdk-root", SDK_ROOT)),
    out: resolve(option(args, "out", DEFAULT_OUT)),
    version: option(args, "version", SDK_VERSION),
    force: args.includes("--force"),
  };
}

export function packageToolchain(options: PackageToolchainOptions, injected: PackageToolchainDependencies = {}): void {
  const platform = injected.platform ?? process.platform;
  const arch = injected.arch ?? process.arch;
  if (!(["darwin", "linux", "win32"] as string[]).includes(platform)) fail(`unsupported platform: ${platform}`);
  if (resolve(options.sdkRoot) !== SDK_ROOT && !existsSync(join(options.sdkRoot, "native", "Cargo.toml"))) fail(`invalid SDK root: ${options.sdkRoot}`);
  const markerPath = join(options.sdkRoot, ".cache", "pocketjs", ".pocketjs-revision");
  if (!existsSync(markerPath) || readFileSync(markerPath, "utf8").trim() !== PINNED_REVISION) fail(`pinned PocketJS revision mismatch: ${markerPath}`);
  const suffix = platform === "win32" ? ".exe" : "";
  const binaries = {
    probe: join(options.sdkRoot, "native", "target", "release", `pocket_probe${suffix}`),
    bytecode: join(options.sdkRoot, "native", "target", "release", `pocketjs_bytecode${suffix}`),
  };
  for (const [name, path] of Object.entries(binaries)) {
    if (!existsSync(path) || !statSync(path).isFile()) fail(`missing release binary (${name}): ${path}`);
  }
  const sourceDirs = ["framework", "contracts", "tools", "microts", "profiles", "assets"];
  for (const directory of sourceDirs) if (!existsSync(join(options.sdkRoot, ".cache", "pocketjs", directory))) fail(`missing pinned compiler source: ${directory}`);
  const requiredCompilerFiles = [
    join("framework", "compiler", "subpaths.ts"),
    join("framework", "src", "inline-fonts.ts"),
    join("tools", "inline-text-slots.ts"),
  ];
  for (const file of requiredCompilerFiles) {
    const filePath = join(options.sdkRoot, ".cache", "pocketjs", file);
    if (!existsSync(filePath) || !lstatSync(filePath).isFile()) fail(`missing patched compiler source: ${file}`);
  }
  const subpathsSource = readFileSync(join(options.sdkRoot, ".cache", "pocketjs", "framework", "compiler", "subpaths.ts"), "utf8");
  if (!subpathsSource.includes('"inline-fonts"')) fail("compiler/framework/compiler/subpaths.ts is missing @pocketjs/framework/inline-fonts");
  const output = resolve(options.out);
  const sdkRoot = resolve(options.sdkRoot);
  const pocketBuild = join(sdkRoot, ".pocket-build");
  const within = (parent: string, child: string): boolean => child === parent || child.startsWith(`${parent}${process.platform === "win32" ? "\\" : "/"}`);
  // External temporary/release paths are fine. Inside the checkout only the
  // generated .pocket-build tree is writable; SDK ancestors, native/, .cache/
  // and source directories are protected from accidental replacement.
  if (within(output, sdkRoot) || (within(sdkRoot, output) && !within(pocketBuild, output))) {
    fail(`refusing to overwrite SDK source/cache; output must be external or inside .pocket-build: ${output}`);
  }
  if (existsSync(output) && !lstatSync(output).isDirectory()) fail(`output is not a directory: ${output}`);
  if (existsSync(output)) {
    if (!options.force && readdirSync(output).length > 0) fail(`output exists: ${output}; pass --force to replace it`);
    rmSync(output, { recursive: true, force: true });
  }
  mkdirSync(output, { recursive: true });
  copyFile(binaries.probe, join(output, "bin", `pocket_probe${suffix}`));
  copyFile(binaries.bytecode, join(output, "bin", `pocketjs_bytecode${suffix}`));
  const upstream = join(options.sdkRoot, ".cache", "pocketjs");
  for (const directory of sourceDirs) copyTree(join(upstream, directory), join(output, "compiler", directory));
  for (const file of ["pocket.json", "tsconfig.json", "LICENSE"]) copyFile(join(upstream, file), join(output, "compiler", file));
  // Web runtime artifacts are built once on the release runner and are
  // optional for the native platform package. Never substitute a source or an
  // unverified upstream WASM file when the release artifact is absent.
  const webEngineRoot = join(options.sdkRoot, ".pocket-build", "web-engine");
  const webEngineWasm = join(webEngineRoot, "pocketjs.wasm");
  const webEngineRuntime = join(webEngineRoot, "pocket-web.js");
  const webRenderWorker = join(webEngineRoot, "pocket-render-worker.js");
  const webEngineIncluded = existsSync(webEngineWasm) && existsSync(webEngineRuntime)
    && statSync(webEngineWasm).isFile() && statSync(webEngineRuntime).isFile();
  const webRenderWorkerIncluded = webEngineIncluded && existsSync(webRenderWorker) && statSync(webRenderWorker).isFile();
  if (webEngineIncluded) {
    copyFile(webEngineWasm, join(output, "engine", "pocketjs.wasm"));
    copyFile(webEngineRuntime, join(output, "web", "pocket-web.js"));
    if (webRenderWorkerIncluded) copyFile(webRenderWorker, join(output, "web", "pocket-render-worker.js"));
  }
  const upstreamPackage = JSON.parse(readFileSync(join(upstream, "package.json"), "utf8")) as Record<string, unknown>;
  const compilerPackage = { ...upstreamPackage, private: false };
  writeFileSync(join(output, "compiler", "package.json"), `${JSON.stringify(compilerPackage, null, 2)}\n`);
  const dependencies = {
    ...Object.fromEntries(Object.entries((upstreamPackage.dependencies ?? {}) as Record<string, unknown>).filter(([, value]) => typeof value === "string" && !value.startsWith("workspace:"))),
    "@abandonware/noble": "1.9.2-26",
  };
  const nobleBinding = findNobleBinding(options.sdkRoot, platform, arch);
  const nobleIncluded = Boolean(nobleBinding);
  if (nobleBinding) copyFile(nobleBinding, join(output, "noble", "prebuilds", `${platform}-${arch}`, "node.napi.node"));
  const bytecodeAbi = (injected.readAbi ?? readBytecodeAbi)(options.sdkRoot);
  const packageName = `@pocket/tools-${platform}-${arch}`;
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    sdkVersion: options.version,
    platform,
    arch,
    upstreamRevision: PINNED_REVISION,
    bytecodeAbi,
    compilerRoot: "compiler",
    webEngine: { included: webEngineIncluded, ...(webEngineIncluded ? { wasm: "engine/pocketjs.wasm", runtime: "web/pocket-web.js", ...(webRenderWorkerIncluded ? { renderWorker: "web/pocket-render-worker.js" } : {}) } : {}) },
    noble: { included: nobleIncluded, ...(nobleIncluded ? { prebuild: `noble/prebuilds/${platform}-${arch}/node.napi.node` } : {}) },
    // bluetooth-hci-socket is loaded by node-pre-gyp from its own package
    // build/Release path and has no supported external prebuild override.
    // Keep this explicit so consumers do not mistake Noble's N-API addon for
    // a Linux HCI implementation.
    hci: { included: false, reason: "node-pre-gyp package-local loader; not distributed by this package" },
    files: {},
  };
  const packageJson = {
    name: packageName,
    version: options.version,
    description: "Prebuilt PocketJS QJBC compiler and native Preview probe",
    private: false,
    type: "module",
    os: [platform],
    cpu: [arch],
    bin: { "pocketjs-bytecode": `bin/pocketjs_bytecode${suffix}`, "pocket-probe": `bin/pocket_probe${suffix}` },
    files: ["bin", "compiler", "engine", "web", "noble", "manifest.json"],
    dependencies,
  };
  writeFileSync(join(output, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  const payloadFiles = filesUnder(output).filter((path) => relative(output, path) !== "manifest.json");
  for (const path of payloadFiles) {
    const key = relative(output, path).split("\\").join("/");
    (manifest.files as Record<string, unknown>)[key] = hashFile(path);
  }
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`package_toolchain: generated ${packageName} at ${output}`);
}

if (import.meta.main) {
  try {
    if (process.argv.includes("--help")) {
      console.log("usage: bun sdk/scripts/package_toolchain.ts [--sdk-root PATH] [--out PATH] [--version 0.1.0] [--force]");
    } else packageToolchain(parseOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(`package_toolchain: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
