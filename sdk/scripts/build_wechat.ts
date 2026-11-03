import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { buildGuest } from "./build_guest.ts";

const SDK_ROOT = resolve(import.meta.dir, "..");
const TARGET_ROOT = resolve(import.meta.dir, "../targets/wechat");
const UPSTREAM_REVISION = "99924de47c62fa36f526a8791055d91cbbdb3836";
const RQUICKJS_SUPPORT_VERSION = "0.14.0";
const RQUICKJS_SUPPORT_CRATE_SHA256 = "cee271d0eeba64f0915b846cb7ae02e16faf3dfdffdca91731101d9d30fe3423";
const RQUICKJS_SUPPORT_LICENSE_SHA256 = "976ad3d07927343ab99b31510625acba89eac8e0e517c712925620ddeda91b70";
const WASI_LIBC_ARCHIVE_SHA256 = "566b9d6322cb3f339963cb1e6719b0bb0c932724fafa3418cf6aebe763dc2036";
const WASI_LIBC_INCLUDE_TREE_SHA256 = "3c9e8cf31f92df2a82da6e436ab26bae97d0b852e4004d7d3af36beca66aee63";
const WASM_SHIM_SHA256 = "2230370e7bde19e441a2addfefda894083d9c96a301830275ae16fa47c26286e";
const WASM_BINDINGS_SHA256 = "c3e5e1b99f3dccb78702bc82b2316896fc47b9973f23c4810d6949dafe42a0f5";
const WASM_BINDINGS_ABI_SHA256 = "ea0b38213d704c274012a42c3303dc93030ba0ad717ec9933e34b8e4d00e3f70";
const WASM_BINDINGS_PATCH_SHA256 = "cb8c7613b08821ad8e5f1d15e5ad3db6d718873c8e26d6ab93538bbbe7ae725e";
const WASI_NOTICE_SHA256 = "0a0e814a210338c57b9d65eb516546045c0ca8caa308bf29aa3736236b08346b";
const MAX_WECHAT_PACKAGE_BYTES = 2 * 1024 * 1024;
const WASM_LINK_STACK_BYTES = 1024 * 1024;
const QUICKJS_STACK_LIMIT_BYTES = 512 * 1024;

export type BuildWechatOptions = {
  projectRoot: string;
  outDir: string;
  entry?: string;
  tickHz?: number;
  log?: (line: string) => void;
};

function run(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(args[0]!, args.slice(1), {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    stdio: "pipe",
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args[0]} exited with status ${result.status ?? 1}\n${output.trim()}`);
  return result.stdout || "";
}

function report(message: string, log?: (line: string) => void): void {
  console.log(message);
  log?.(message);
}

function pocketDeclaresWorker(projectRoot: string): boolean {
  const pocket = JSON.parse(readFileSync(join(projectRoot, "pocket.json"), "utf8")) as {
    domains?: unknown;
  };
  const domains = pocket.domains;
  return domains !== null
    && typeof domains === "object"
    && !Array.isArray(domains)
    && Object.hasOwn(domains, "worker");
}

function replaceOnce(source: string, before: string, after: string, label: string): string {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`build_wechat: pinned source shape changed at ${label}; refusing a fuzzy patch`);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function packageRoot(projectRoot: string): string {
  const candidates = [
    join(projectRoot, "vendor/pocket-ui"),
    join(projectRoot, "node_modules/@pocket/ui"),
    join(SDK_ROOT, "node_modules/@pocket/ui"),
    join(SDK_ROOT, "packages/pocket_ui"),
  ];
  const manifest = candidates.map((candidate) => join(candidate, "package.json")).find(existsSync);
  if (!manifest) throw new Error("build_wechat: @pocket/ui package source is required for native IME event delivery");
  return dirname(realpathSync(manifest));
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function treeSha256(root: string): string {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(root);
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(root, path).split(sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function supportTreeIsValid(root: string): boolean {
  const includeRoot = join(root, "vendor/wasi-libc/include");
  const files = [
    ["wasm-shim/shim.c", WASM_SHIM_SHA256],
    ["src/bindings/wasm32-wasip1.rs", WASM_BINDINGS_SHA256],
    ["vendor/wasi-libc/lib/libc.a", WASI_LIBC_ARCHIVE_SHA256],
    ["vendor/wasi-libc/NOTICE.md", WASI_NOTICE_SHA256],
    ["LICENSE", RQUICKJS_SUPPORT_LICENSE_SHA256],
  ] as const;
  return files.every(([path, hash]) => existsSync(join(root, path)) && fileSha256(join(root, path)) === hash)
    && existsSync(join(root, "PROVENANCE.md"))
    && existsSync(includeRoot)
    && existsSync(join(includeRoot, "stdlib.h"))
    && treeSha256(includeRoot) === WASI_LIBC_INCLUDE_TREE_SHA256;
}

async function ensureRquickjsSupportCache(): Promise<string> {
  const cacheRoot = join(SDK_ROOT, ".cache/wechat", `rquickjs-sys-${RQUICKJS_SUPPORT_VERSION}`);
  mkdirSync(cacheRoot, { recursive: true });
  const cratePath = join(cacheRoot, `rquickjs-sys-${RQUICKJS_SUPPORT_VERSION}.crate`);
  const providedArchive = process.env.POCKET_WECHAT_RQUICKJS_SYS_ARCHIVE;
  if (!existsSync(cratePath)) {
    if (providedArchive && existsSync(providedArchive)) {
      cpSync(providedArchive, cratePath);
    } else {
      const url = `https://static.crates.io/crates/rquickjs-sys/rquickjs-sys-${RQUICKJS_SUPPORT_VERSION}.crate`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`build_wechat: downloading pinned ${url} failed with HTTP ${response.status}`);
      writeFileSync(cratePath, Buffer.from(await response.arrayBuffer()));
    }
  }
  if (fileSha256(cratePath) !== RQUICKJS_SUPPORT_CRATE_SHA256) {
    rmSync(cratePath, { force: true });
    throw new Error(`build_wechat: rquickjs-sys ${RQUICKJS_SUPPORT_VERSION} archive SHA-256 mismatch`);
  }

  const supportRoot = join(cacheRoot, "support");
  if (supportTreeIsValid(supportRoot)) return supportRoot;
  rmSync(supportRoot, { recursive: true, force: true });
  const extracted = mkdtempSync(join(tmpdir(), "pocketjs-wechat-rquickjs-support-"));
  try {
    run([
      "tar", "-xzf", cratePath, "-C", extracted, "--strip-components=1",
      `rquickjs-sys-${RQUICKJS_SUPPORT_VERSION}/wasm-shim/shim.c`,
      `rquickjs-sys-${RQUICKJS_SUPPORT_VERSION}/src/bindings/wasm32-wasip1.rs`,
      `rquickjs-sys-${RQUICKJS_SUPPORT_VERSION}/vendor/wasi-libc`,
    ], SDK_ROOT);
    const licenseUrl = "https://raw.githubusercontent.com/DelSkayn/rquickjs/v0.14.0/LICENSE";
    const licenseResponse = await fetch(licenseUrl);
    if (!licenseResponse.ok) throw new Error(`build_wechat: downloading pinned ${licenseUrl} failed with HTTP ${licenseResponse.status}`);
    writeFileSync(join(extracted, "LICENSE"), Buffer.from(await licenseResponse.arrayBuffer()));
    const provenance = `# Cached QJBC WebAssembly support files\n\n` +
      `Source crate: [rquickjs-sys ${RQUICKJS_SUPPORT_VERSION}](https://crates.io/crates/rquickjs-sys/${RQUICKJS_SUPPORT_VERSION})\n` +
      `Archive: https://static.crates.io/crates/rquickjs-sys/rquickjs-sys-${RQUICKJS_SUPPORT_VERSION}.crate\n` +
      `Archive SHA-256: ${RQUICKJS_SUPPORT_CRATE_SHA256}\n` +
      `Repository: https://github.com/DelSkayn/rquickjs/tree/v${RQUICKJS_SUPPORT_VERSION}\n` +
      `License SHA-256: ${RQUICKJS_SUPPORT_LICENSE_SHA256}\n\n` +
      `The 0.14.0 shim and wasm32-wasip1 bindings are support inputs only. The build applies the SDK's wasm32-unknown-unknown-qjs-0.12.2.patch (SHA-256 ${WASM_BINDINGS_PATCH_SHA256}) to the binding copy so its declarations match the pinned 0.12.2 QuickJS headers. The QuickJS sources and QJBC reader remain pinned to the PocketJS lockfile's rquickjs-sys 0.12.2. The bundled wasi-libc archive is the upstream wasi-sdk-24 wasm32-wasi artifact documented by vendor/wasi-libc/NOTICE.md.\n`;
    writeFileSync(join(extracted, "PROVENANCE.md"), provenance);
    if (!supportTreeIsValid(extracted)) throw new Error("build_wechat: extracted QJBC support files failed their pinned hashes");
    cpSync(extracted, supportRoot, { recursive: true });
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
  return supportRoot;
}

function copyProject(projectRoot: string, destination: string): void {
  cpSync(projectRoot, destination, {
    recursive: true,
    filter: (path) => {
      const parts = relative(projectRoot, path).split(sep);
      return !parts.some((part) => part === "node_modules" || part === ".git" || part === ".pocket-build" || part === "target" || part === ".pocket-ui.lock");
    },
  });
  const sourceModules = join(projectRoot, "node_modules");
  if (!existsSync(sourceModules)) return;
  const targetModules = join(destination, "node_modules");
  mkdirSync(targetModules, { recursive: true });
  for (const name of readdirSync(sourceModules)) {
    const source = join(sourceModules, name);
    const target = join(targetModules, name);
    if (name === "@pocket") {
      mkdirSync(target, { recursive: true });
      for (const scopedName of readdirSync(source)) {
        if (scopedName === "ui") continue;
        symlinkSync(join(source, scopedName), join(target, scopedName), "junction");
      }
    } else {
      symlinkSync(source, target, "junction");
    }
  }
}

function prepareWechatUi(projectRoot: string, temporaryProject: string): void {
  const vendor = join(temporaryProject, "vendor/pocket-ui");
  rmSync(vendor, { recursive: true, force: true });
  mkdirSync(dirname(vendor), { recursive: true });
  cpSync(packageRoot(projectRoot), vendor, { recursive: true });
  const uiSource = join(vendor, "src/ui.tsx");
  let source = readFileSync(uiSource, "utf8");
  const marker = "export function InputField(props: {";
  if (!source.includes("__pocketTextInputEvent")) {
    source = replaceOnce(source, marker,
      `const pocketWechatGlobal = globalThis;\npocketWechatGlobal.__pocketTextInputEvent = deliverTextInputEvent;\n\n${marker}`,
      "make native IME delivery reachable from the guest QJBC realm");
    writeFileSync(uiSource, source);
  }
}

function registrySysRoot(): string {
  const metadata = run(["cargo", "metadata", "--manifest-path", join(SDK_ROOT, "native/Cargo.toml"), "--locked", "--format-version", "1"], SDK_ROOT);
  const document = JSON.parse(metadata) as { packages: { name: string; version: string; manifest_path: string }[] };
  const rquickjsPackage = document.packages.find((item) => item.name === "rquickjs-sys" && item.version === "0.12.2");
  if (!rquickjsPackage) throw new Error("build_wechat: sdk/native/Cargo.lock no longer resolves rquickjs-sys 0.12.2");
  return dirname(rquickjsPackage.manifest_path);
}

function patchRquickjsSys(sysRoot: string, supportRoot: string, destination: string): void {
  cpSync(sysRoot, destination, {
    recursive: true,
    filter: (path) => !path.split(sep).includes("target"),
  });
  const bindings = join(destination, "src/bindings");
  const wasiBindings = readFileSync(join(supportRoot, "src/bindings/wasm32-wasip1.rs"));
  const targetBindings = join(bindings, "wasm32-unknown-unknown.rs");
  writeFileSync(targetBindings, wasiBindings);
  const bindingsPatch = join(TARGET_ROOT, "wasm32-unknown-unknown-qjs-0.12.2.patch");
  if (fileSha256(bindingsPatch) !== WASM_BINDINGS_PATCH_SHA256) {
    throw new Error("build_wechat: 0.12.2 QuickJS ABI bindings patch hash mismatch");
  }
  run(["patch", "--batch", "-p0", "-i", bindingsPatch], bindings);
  if (fileSha256(targetBindings) !== WASM_BINDINGS_ABI_SHA256) {
    throw new Error("build_wechat: patched WASI bindings do not match the QuickJS 0.12.2 ABI");
  }
  const buildPath = join(destination, "build.rs");
  let build = readFileSync(buildPath, "utf8");
  build = replaceOnce(build,
`    if target_os == "wasi" {
        // pretend we're emscripten - there are already ifdefs that match
        // also, wasi doesn't ahve FE_DOWNWARD or FE_UPWARD
        defines.push(("EMSCRIPTEN".into(), Some("1")));
        defines.push(("FE_DOWNWARD".into(), Some("0")));
        defines.push(("FE_UPWARD".into(), Some("0")));
    }`,
`    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap();
    let is_wasm_unknown = target_arch == "wasm32" && target_os == "unknown";
    if target_os == "wasi" || is_wasm_unknown {
        defines.push(("EMSCRIPTEN".into(), Some("1")));
        defines.push(("FE_DOWNWARD".into(), Some("0")));
        defines.push(("FE_UPWARD".into(), Some("0")));
    }
    if is_wasm_unknown {
        println!("cargo:rerun-if-changed=vendor/wasi-libc/include");
        let vendor_include = Path::new("vendor/wasi-libc/include").canonicalize().expect("missing vendored wasi-libc headers");
        let flag = format!("-isystem{}", vendor_include.display());
        builder.flag(&flag);
        bindgen_cflags.push(flag);
    }`, "rquickjs-sys wasm target detection");
  build = replaceOnce(build,
`    builder.compile("libquickjs.a");`,
`    if is_wasm_unknown {
        builder.file("wasm-shim/shim.c");
    }
    builder.compile("libquickjs.a");
    if is_wasm_unknown {
        println!("cargo:rerun-if-changed=wasm-shim/shim.c");
        let vendor_lib = Path::new("vendor/wasi-libc/lib").canonicalize().expect("missing vendored wasi-libc archive");
        println!("cargo:rustc-link-search=native={}", vendor_lib.display());
        println!("cargo:rustc-link-lib=static=c");
    }`, "rquickjs-sys QuickJS shim and WASI libc link");
  writeFileSync(buildPath, build);
  cpSync(join(supportRoot, "wasm-shim/shim.c"), join(destination, "wasm-shim/shim.c"));
  cpSync(join(supportRoot, "vendor/wasi-libc"), join(destination, "vendor/wasi-libc"), { recursive: true });

  const libcHash = createHash("sha256").update(readFileSync(join(destination, "vendor/wasi-libc/lib/libc.a"))).digest("hex");
  const shimHash = createHash("sha256").update(readFileSync(join(destination, "wasm-shim/shim.c"))).digest("hex");
  const bindingsHash = createHash("sha256").update(readFileSync(join(destination, "src/bindings/wasm32-unknown-unknown.rs"))).digest("hex");
  if (libcHash !== WASI_LIBC_ARCHIVE_SHA256 || shimHash !== WASM_SHIM_SHA256 || bindingsHash !== WASM_BINDINGS_ABI_SHA256) {
    throw new Error("build_wechat: vendored WASI/QJBC shim hash mismatch; refusing to compile an unreviewed runtime");
  }
}

function workspaceMembers(workspace: string): void {
  const manifestPath = join(workspace, "Cargo.toml");
  const source = readFileSync(manifestPath, "utf8");
  const lines = source.split(/\r?\n/);
  let section: "members" | "default-members" | null = null;
  const filtered = lines.filter((line) => {
    const header = line.match(/^\s*(members|default-members)\s*=\s*\[/);
    if (header) section = header[1] as "members" | "default-members";
    if (!section) return true;
    const member = line.match(/^\s*"([^"*?]+)"\s*,?\s*$/);
    if (member && !existsSync(join(workspace, member[1]!))) return false;
    if (line.includes("]")) section = null;
    return true;
  });
  writeFileSync(manifestPath, filtered.join("\n"));
}

function findLlvmAr(): string {
  const explicit = process.env.POCKET_WECHAT_LLVM_AR;
  if (explicit && existsSync(explicit)) return explicit;
  const emsdk = process.env.EMSDK;
  if (emsdk) {
    for (const candidate of [join(emsdk, "upstream/bin/llvm-ar"), join(emsdk, "upstream/emscripten/emar")]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  const brew = "/opt/homebrew/Cellar/emscripten";
  if (existsSync(brew)) {
    const versions = readdirSync(brew).sort().reverse();
    for (const version of versions) {
      const candidate = join(brew, version, "libexec/llvm/bin/llvm-ar");
      if (existsSync(candidate)) return candidate;
    }
  }
  const cargoHome = process.env.CARGO_HOME || join(homedir(), ".cargo");
  const maybe = join(cargoHome, "bin/llvm-ar");
  if (existsSync(maybe)) return maybe;
  throw new Error("build_wechat: wasm32-unknown-unknown needs an LLVM-compatible llvm-ar/emar (set POCKET_WECHAT_LLVM_AR)");
}

function patchPinnedWorkspace(workspace: string, qjbc: string, pak: string, tickHz: number, sysOverlay: string, bytecodeModule: string): void {
  workspaceMembers(workspace);
  const rootCargo = join(workspace, "Cargo.toml");
  let rootManifest = readFileSync(rootCargo, "utf8");
  rootManifest += `\n[patch.crates-io]\nrquickjs-sys = { path = ${JSON.stringify(sysOverlay)} }\n`;
  writeFileSync(rootCargo, rootManifest);

  const wasmCargo = join(workspace, "programs/web/wasm/Cargo.toml");
  let wasmManifest = readFileSync(wasmCargo, "utf8");
  wasmManifest += `\npocket-guest-rquickjs = { workspace = true, default-features = true }\nrquickjs = "0.12.2"\n`;
  writeFileSync(wasmCargo, wasmManifest);

  const src = join(workspace, "programs/web/wasm/src");
  cpSync(join(TARGET_ROOT, "src/wechat_guest.rs"), join(src, "wechat_guest.rs"));
  cpSync(bytecodeModule, join(src, "bytecode.rs"));
  writeFileSync(join(src, "wechat_assets.rs"),
    `pub const APP_QJBC: &[u8] = include_bytes!(${JSON.stringify(qjbc)});\n` +
    `pub const APP_PAK: &[u8] = include_bytes!(${JSON.stringify(pak)});\n` +
    `pub const TICK_HZ: u32 = ${tickHz};\n`);

  const libPath = join(src, "lib.rs");
  let lib = readFileSync(libPath, "utf8");
  lib = replaceOnce(lib, "mod browser;", "pub(crate) mod browser;\nmod bytecode;\nmod wechat_guest;\nmod wechat_assets;", "WebAssembly target modules");
  lib = replaceOnce(lib,
`        Err(e) => {
            *host.result.borrow_mut() = format!("{e:?}").into_bytes();
            -1
        }`,
`        Err(e) => {
            let mut result = host.result.borrow_mut();
            if result.is_empty() {
                *result = format!("{e:?}").into_bytes();
            }
            -1
        }`,
    "preserve detailed Guest errors during WeChat boot");
  lib = replaceOnce(lib, "    runtime: RefCell<Option<Runtime>>,", "    runtime: RefCell<Option<Runtime>>,\n    pub(crate) quickjs: Rc<RefCell<Option<pocket_guest_rquickjs::RquickjsGuest>>>,", "owned QuickJS handle");
  lib = replaceOnce(lib, "        runtime: RefCell::new(None),", "        runtime: RefCell::new(None),\n        quickjs: Rc::new(RefCell::new(None)),", "QuickJS state initialization");
  lib = replaceOnce(lib, "RefCell::new((\"web\".into(), BINDING_GENERATION))", "RefCell::new((\"wechat\".into(), BINDING_GENERATION))", "WeChat host identity");
  writeFileSync(libPath, lib);

  const browserPath = join(src, "browser.rs");
  let browser = readFileSync(browserPath, "utf8");
  const guestStart = browser.indexOf("#[cfg(target_arch = \"wasm32\")]\n#[link(wasm_import_module = \"pocket_web\")]");
  const guestEnd = browser.indexOf("pub struct BrowserInput", guestStart);
  if (guestStart < 0 || guestEnd < 0) throw new Error("build_wechat: pinned BrowserGuest source section changed; refusing fuzzy replacement");
  browser = browser.slice(0, guestStart) + browser.slice(guestEnd);
  browser = replaceOnce(browser,
    "use pocket_runtime::{Cow, Guest, GuestEnvironment, GuestFrame, Profile, RuntimeConfig};",
    "use pocket_runtime::{Cow, Profile, RuntimeConfig};", "remove source-eval BrowserGuest imports");
  browser = replaceOnce(browser,
    "runtime.set_native_asset_loading(false)?;",
    "// Native PAK admission installs the same texture/glyph registry as every PocketJS host.",
    "enable native PAK and glyph resource admission");
  browser = replaceOnce(browser,
    "runtime.set_guest(Box::new(BrowserGuest(h)))?;",
    "runtime.set_guest(Box::new(crate::wechat_guest::WechatGuest::new(h.quickjs.clone(), h as *const WasmHost)))?;",
    "use real QuickJS bytecode guest");
  browser = replaceOnce(browser,
    'embedded::identity("web", "dev.pocketjs.web.embedded", "Web embedded guest")',
    'embedded::identity("wechat", "dev.pocketjs.wechat.embedded", "WeChat embedded guest")',
    "WeChat embedded package identity");
  browser = replaceOnce(browser,
    '        let payload=serde_json::to_vec(&json!({"name":descriptor.name,"args":arguments,"result":format!("{:?}",descriptor.result)})).unwrap();\n' +
    '        // Only the provider-result mailbox is mutably borrowed across this\n' +
    '        // callback. Reentrant core operations fail through OpContext::Busy.\n' +
    '        let host = unsafe { &*self.host };\n' +
    '        host.provider_result.borrow_mut().take();\n' +
    '        BrowserGuest(self.host).call(5, &payload, &[])?;\n' +
    '        host.provider_result\n' +
    '            .borrow_mut()\n' +
    '            .take()\n' +
    '            .ok_or(RuntimeError::InvalidArgument)',
    '        Err(RuntimeError::UnsupportedOperation)',
    "do not claim synchronous WX provider dispatch");
  writeFileSync(browserPath, browser);

  const packagePath = join(workspace, "engine/package/src/embedded.rs");
  let embedded = readFileSync(packagePath, "utf8");
  embedded = replaceOnce(embedded,
`    if code.contains(&0) {
        return Err(EncodeError::InvalidJavaScript);
    }
`,
"    // The JS section carries the admitted PJBC envelope as opaque bytes.\n",
    "allow binary QuickJS envelope in package JS section");
  writeFileSync(packagePath, embedded);

  const guestPath = join(workspace, "engine/guest-rquickjs/src/lib.rs");
  let guest = readFileSync(guestPath, "utf8");
  guest = replaceOnce(guest,
    "use std::time::{Duration, Instant};",
    `use std::time::Duration;
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;

#[cfg(target_arch = "wasm32")]
type TurnDeadline = u64;
#[cfg(not(target_arch = "wasm32"))]
type TurnDeadline = Instant;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn __rquickjs_host_now_us() -> f64;
}

#[cfg(target_arch = "wasm32")]
fn turn_deadline_after(duration: Duration) -> TurnDeadline {
    let now = unsafe { __rquickjs_host_now_us() } as u64;
    now.saturating_add(duration.as_micros().min(u64::MAX as u128) as u64)
}
#[cfg(not(target_arch = "wasm32"))]
fn turn_deadline_after(duration: Duration) -> TurnDeadline {
    Instant::now() + duration
}

#[cfg(target_arch = "wasm32")]
fn turn_deadline_expired(deadline: TurnDeadline) -> bool {
    (unsafe { __rquickjs_host_now_us() }) as u64 >= deadline
}
#[cfg(not(target_arch = "wasm32"))]
fn turn_deadline_expired(deadline: TurnDeadline) -> bool {
    Instant::now() >= deadline
}`,
    "use host clock for wasm32 QuickJS execution deadlines");
  guest = replaceOnce(guest,
    "turn_deadline: Arc<Mutex<Option<Instant>>>",
    "turn_deadline: Arc<Mutex<Option<TurnDeadline>>>", "cross-target guest deadline");
  guest = replaceOnce(guest,
    "runtime.set_max_stack_size(4 * 1024 * 1024);",
    `// QuickJS on wasm32 uses 32-bit pointers for stack_limit = stack_top - stack_size.
        // Keep its ceiling below the explicit 1 MiB linker stack to avoid unsigned underflow.
        runtime.set_max_stack_size(${QUICKJS_STACK_LIMIT_BYTES});`,
    "bound QuickJS below the WebAssembly C stack to prevent 32-bit stack-limit underflow");
  guest = replaceOnce(guest,
    "Some(Instant::now() + duration);",
    "Some(turn_deadline_after(duration));", "guest deadline creation");
  guest = replaceOnce(guest,
    `runtime.set_interrupt_handler(Some(Box::new(move || {
            deadline.lock().unwrap().is_some_and(|end| Instant::now() >= end)
        })));`,
    `runtime.set_interrupt_handler(Some(Box::new(move || {
            deadline.lock().unwrap().is_some_and(|end| turn_deadline_expired(end))
        })));`,
    "QuickJS interrupt deadline");
  guest = replaceOnce(guest,
    "self.turn_deadline.lock().unwrap().is_some_and(|end| Instant::now() >= end)",
    "self.turn_deadline.lock().unwrap().is_some_and(|end| turn_deadline_expired(end))",
    "microtask drain deadline");
  const sourceEvalStart = guest.indexOf("    fn evaluate(&mut self, code: &[u8]) -> Result<(), RuntimeError> {");
  const frameStart = guest.indexOf("    fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError> {", sourceEvalStart);
  if (sourceEvalStart < 0 || frameStart < 0) throw new Error("build_wechat: pinned QuickJS Guest evaluate section changed; refusing fuzzy replacement");
  guest = guest.slice(0, sourceEvalStart) +
    "    fn evaluate(&mut self, _code: &[u8]) -> Result<(), RuntimeError> {\n" +
    "        self.last_error = Some(\"JavaScript source evaluation is disabled in the WeChat target\".to_owned());\n" +
    "        Err(RuntimeError::Guest)\n" +
    "    }\n" +
    guest.slice(frameStart);
  writeFileSync(guestPath, guest);
}

function copyWorkspace(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    filter: (path) => {
      const rel = relative(source, path).split(sep);
      return !rel.some((part) => part === "target" || part === "node_modules" || part === ".git" || part === ".pocket-build");
    },
  });
}

function directoryBytes(root: string): number {
  return readdirSync(root, { withFileTypes: true }).reduce((total, entry) => {
    const path = join(root, entry.name);
    return total + (entry.isDirectory() ? directoryBytes(path) : readFileSync(path).byteLength);
  }, 0);
}

function writeConsumer(output: string, sourceProject: string, tickHz: number, wasm: Buffer, qjbcMetadata: Record<string, unknown>): void {
  const files = ["app.js", "app.json", "app.wxss", "sitemap.json", "wechat-host.js"];
  cpSync(join(TARGET_ROOT, "template/pages"), join(output, "pages"), { recursive: true });
  for (const file of files) cpSync(join(TARGET_ROOT, "template", file), join(output, file));
  mkdirSync(join(output, "engine"), { recursive: true });
  const compressed = brotliCompressSync(wasm, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC,
    },
  });
  if (!brotliDecompressSync(compressed).equals(wasm)) throw new Error("build_wechat: Brotli output did not round trip");
  if (compressed.byteLength > MAX_WECHAT_PACKAGE_BYTES) {
    throw new Error(`build_wechat: compressed engine is ${compressed.byteLength} bytes, above WeChat's 2 MiB per-package limit`);
  }
  writeFileSync(join(output, "engine/pocketjs.wasm.br"), compressed);

  const pocket = JSON.parse(readFileSync(join(sourceProject, "pocket.json"), "utf8")) as { id?: string };
  const manifest = JSON.parse(readFileSync(join(sourceProject, "manifest.json"), "utf8")) as {
    capabilities?: { requires?: string[]; optional?: string[] };
  };
  const appId = typeof pocket.id === "string" && pocket.id ? pocket.id : "pocket.guest";
  const requires = Array.isArray(manifest.capabilities?.requires) ? manifest.capabilities!.requires! : [];
  const optional = Array.isArray(manifest.capabilities?.optional) ? manifest.capabilities!.optional! : [];
  writeFileSync(join(output, "pocket.config.js"), `module.exports = ${JSON.stringify({
    appId,
    tickHz,
    enginePath: "engine/pocketjs.wasm.br",
    requires,
    optional,
  }, null, 2)};\n`);
  writeFileSync(join(output, "project.config.json"), `${JSON.stringify({
    appid: "touristappid",
    compileType: "miniprogram",
    miniprogramRoot: "./",
    libVersion: "2.14.0",
    setting: { urlCheck: true, es6: true, minified: true },
  }, null, 2)}\n`);
  writeFileSync(join(output, "build-info.json"), `${JSON.stringify({
    target: "wechat-host-qjbc",
    appId,
    composition: "single-guest-primary-surface",
    upstreamRevision: UPSTREAM_REVISION,
    rquickjs: "0.12.2",
    quickjsBytecode: qjbcMetadata,
    engineBytes: wasm.byteLength,
    compressedEngineBytes: compressed.byteLength,
    engineSha256: createHash("sha256").update(wasm).digest("hex"),
    compressedEngineSha256: createHash("sha256").update(compressed).digest("hex"),
    hostRuntime: "WXWebAssembly + Canvas2D",
  }, null, 2)}\n`);
  writeFileSync(join(output, "README.md"), `# PocketJS WeChat Mini Program consumer\n\n` +
`Open this directory as a Mini Program in WeChat DevTools, replace touristappid with the registered app id, and run on a physical device before distribution. The generated engine is ${compressed.byteLength} bytes Brotli-compressed and embeds the app's admitted QuickJS 0.12.2 bytecode and PAK.\n\n` +
`This target hosts one PocketJS Guest on one primary surface. It does not host PocketSystem dynamic child compositing.\n\n` +
`Requirements: WeChat base library 2.14.0 or newer for WXWebAssembly with Brotli .wasm.br package paths; Canvas2D uses the type=2d API (2.9.0 or newer). The app's Canvas2D surface must stay within 1365 by 1365 pixels.\n\n` +
`Only manifest-declared platform.storage capabilities are serviced by the built-in app-scoped wx storage adapter. Other host.request capabilities return permission_denied or unconfigured unless registered through wechat-host.js.\n`);
  const packageBytes = directoryBytes(output);
  if (packageBytes > MAX_WECHAT_PACKAGE_BYTES) {
    throw new Error(`build_wechat: generated main package is ${packageBytes} bytes, above WeChat's 2 MiB package limit`);
  }
}

export async function buildWechat(options: BuildWechatOptions): Promise<{ outDir: string; wasmBytes: number; brotliBytes: number }> {
  const projectRoot = resolve(options.projectRoot);
  const output = resolve(options.outDir);
  if (!existsSync(join(projectRoot, "pocket.json")) || !existsSync(join(projectRoot, "manifest.json"))) {
    throw new Error("build_wechat: projectRoot must contain pocket.json and manifest.json");
  }
  if (existsSync(join(projectRoot, "pocket.system.json"))) {
    throw new Error("build_wechat: this target embeds one Guest on one primary surface; PocketSystem dynamic child compositing is not supported");
  }
  if (pocketDeclaresWorker(projectRoot)) {
    throw new Error("build_wechat: this target hosts one Guest only; domains.worker (Worker/HTTP/io.offload) is not supported");
  }
  if (existsSync(output) && readdirSync(output).length > 0) throw new Error(`build_wechat: output directory is not empty: ${output}`);
  mkdirSync(output, { recursive: true });

  const tempRoot = mkdtempSync(join(tmpdir(), "pocketjs-wechat-build-"));
  const guestOutput = join(tempRoot, "guest");
  const upstream = join(SDK_ROOT, ".cache/pocketjs");
  const temporaryProject = join(tempRoot, "project");
  try {
    const marker = readFileSync(join(upstream, ".pocketjs-revision"), "utf8").trim();
    if (marker !== UPSTREAM_REVISION) throw new Error(`build_wechat: expected pinned PocketJS ${UPSTREAM_REVISION}, found ${marker}`);
    const bytecodeModule = join(tempRoot, "bytecode.rs");
    cpSync(join(SDK_ROOT, "native/src/bytecode.rs"), bytecodeModule);
    copyProject(projectRoot, temporaryProject);
    prepareWechatUi(projectRoot, temporaryProject);
    const requestedEntry = options.entry || JSON.parse(readFileSync(join(projectRoot, "pocket.json"), "utf8")).app?.entry || "app.tsx";
    const sourceEntry = relative(projectRoot, resolve(projectRoot, requestedEntry));
    const guest = await buildGuest({ projectRoot: temporaryProject, entry: sourceEntry, outDir: guestOutput, tickHz: options.tickHz });
    report(`build_wechat: Guest artifacts ready (QJBC=${guest.bytecode}, PAK=${guest.pak})`, options.log);

    const supportRoot = await ensureRquickjsSupportCache();
    const sysOverlay = join(tempRoot, "rquickjs-sys-0.12.2-wechat");
    patchRquickjsSys(registrySysRoot(), supportRoot, sysOverlay);
    const workspace = join(tempRoot, "pocketjs");
    copyWorkspace(upstream, workspace);
    patchPinnedWorkspace(workspace, guest.bytecode, guest.pak, guest.tickHz, sysOverlay, bytecodeModule);
    const ar = findLlvmAr();
    const cargoEnv = {
      AR: ar,
      AR_wasm32_unknown_unknown: ar,
      CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_AR: ar,
      RUSTFLAGS: `-C link-arg=-z -C link-arg=stack-size=${WASM_LINK_STACK_BYTES}`,
    };
    const wasmManifest = join(workspace, "programs/web/wasm/Cargo.toml");
    report(`build_wechat: compile PocketJS Runtime + QJBC guest with rquickjs 0.12.2 (${UPSTREAM_REVISION})`, options.log);
    run(["cargo", "build", "--manifest-path", wasmManifest, "--target", "wasm32-unknown-unknown", "--release"], workspace, cargoEnv);
    const wasmPath = join(workspace, "target/wasm32-unknown-unknown/release/pocketjs_wasm.wasm");
    const wasm = readFileSync(wasmPath);
    if (!wasm.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d]))) throw new Error("build_wechat: generated engine is not a WebAssembly module");
    const metadata = JSON.parse(readFileSync(guest.metadata, "utf8")) as Record<string, unknown>;
    writeConsumer(output, projectRoot, guest.tickHz, wasm, metadata);
    return {
      outDir: output,
      wasmBytes: wasm.byteLength,
      brotliBytes: readFileSync(join(output, "engine/pocketjs.wasm.br")).byteLength,
    };
  } finally {
    if (process.env.POCKET_WECHAT_KEEP_TEMP === "1") report(`build_wechat: retained temporary build tree ${tempRoot}`, options.log);
    else rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function parseBuildWechatArgs(args: string[]): Pick<BuildWechatOptions, "projectRoot" | "outDir" | "entry" | "tickHz"> {
  const options: { projectRoot?: string; outDir?: string; entry?: string; tickHz?: number } = {};
  for (const arg of args) {
    if (arg.startsWith("--project-root=")) options.projectRoot = arg.slice("--project-root=".length);
    else if (arg.startsWith("--outdir=")) options.outDir = arg.slice("--outdir=".length);
    else if (arg.startsWith("--entry=")) options.entry = arg.slice("--entry=".length);
    else if (arg.startsWith("--tick-hz=")) options.tickHz = Number(arg.slice("--tick-hz=".length));
    else throw new Error(`build_wechat: unknown option ${arg}`);
  }
  if (!options.projectRoot || !options.outDir) throw new Error("usage: bun sdk/scripts/build_wechat.ts --project-root=<consumer> --outdir=<new-miniprogram-dir>");
  return options as Pick<BuildWechatOptions, "projectRoot" | "outDir" | "entry" | "tickHz">;
}

if (import.meta.main) {
  try {
    const options = parseBuildWechatArgs(process.argv.slice(2));
    const result = await buildWechat(options);
    console.log(`build_wechat: generated ${result.outDir} (wasm=${result.wasmBytes}, brotli=${result.brotliBytes})`);
  } catch (error) {
    console.error(`build_wechat: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
