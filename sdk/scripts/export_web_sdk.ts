/** Export and optionally publish the standalone Pocket Web SDK repository. */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const SDK_ROOT = resolve(import.meta.dir, "..");
const REPOSITORY_ROOT = resolve(SDK_ROOT, "..");
const DEFAULT_OUT = resolve(SDK_ROOT, ".pocket-build/web-sdk");
const DEFAULT_REPO = "CodeEagle/pocket-web-sdk";
const PINNED_REVISION = "99924de47c62fa36f526a8791055d91cbbdb3836";

type Options = { out: string; repo: string; publish: boolean; force: boolean };

function usage(exitCode = 0): never {
  console.log("usage: bun sdk/scripts/export_web_sdk.ts [--out PATH] [--repo OWNER/NAME] [--publish] [--force]");
  process.exit(exitCode);
}

function option(args: string[], name: string, fallback: string): string {
  const inline = args.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3) || usage(1);
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

function run(command: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, inherit = false): string {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(`${command.join(" ")} failed (${result.status ?? 1})\n${output.trim()}`);
  return result.stdout ?? "";
}

function copyFile(source: string, target: string): void {
  if (!existsSync(source) || !lstatSync(source).isFile()) throw new Error(`missing required file: ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { force: true });
}

function copyTree(source: string, target: string): void {
  if (!existsSync(source) || !lstatSync(source).isDirectory()) throw new Error(`missing required directory: ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    force: true,
    filter: (path) => !path.split(/[\\/]/).some((part) => part === "node_modules" || part === "target" || part === ".cache" || part === ".pocket-build" || part === ".git"),
  });
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function clearOutput(out: string, force: boolean): void {
  if (!existsSync(out)) {
    mkdirSync(out, { recursive: true });
    return;
  }
  const entries = readdirSync(out);
  if (entries.length > 0 && !force) throw new Error(`output exists: ${out}; pass --force to replace its generated files`);
  for (const entry of entries) {
    if (entry === ".git") continue;
    rmSync(join(out, entry), { recursive: true, force: true });
  }
}

function copySources(out: string): void {
  copyTree(join(SDK_ROOT, "editor"), join(out, "editor"));
  rmSync(join(out, "editor/test"), { recursive: true, force: true });

  for (const file of [
    "build_guest.ts",
    "build_system.ts",
    "build_web.ts",
    "build_wechat.ts",
    "flutter_target.ts",
    "native_probe_path.ts",
    "package_update.ts",
    "platform_scaffold.ts",
    "plugin_types.ts",
    "prepare_upstream.py",
    "preview_wechat.ts",
    "serve_updates.ts",
  ]) copyFile(join(SDK_ROOT, "scripts", file), join(out, "scripts", file));

  copyTree(join(SDK_ROOT, "targets/web"), join(out, "targets/web"));
  copyTree(join(SDK_ROOT, "targets/wechat"), join(out, "targets/wechat"));
  copyTree(join(SDK_ROOT, "native"), join(out, "native"));
  copyTree(join(SDK_ROOT, "packages/pocket_ui"), join(out, "packages/pocket_ui"));
  rmSync(join(out, "packages/pocket_ui/test"), { recursive: true, force: true });
  copyFile(
    join(SDK_ROOT, "packages/pocket_flutter/shaders/liquid_glass.frag"),
    join(out, "packages/pocket_flutter/shaders/liquid_glass.frag"),
  );

  for (const file of [
    "AI_APP_DEVELOPMENT.md",
    "COMPONENTS.md",
    "EDITOR_STUDIO.md",
    "EDITOR_TEST_PACKAGES.md",
    "HARDWARE_MODULES.md",
    "PACKAGE_UPDATE_MODES.md",
    "PROVENANCE.md",
    "WEB_SDK_EXPORT.md",
    "WECHAT_HOST_IMPLEMENTATION.md",
  ]) copyFile(join(SDK_ROOT, "docs", file), join(out, "docs", file));
  copyFile(join(REPOSITORY_ROOT, "LICENSE"), join(out, "LICENSE"));
}

function writeRepositoryFiles(out: string): void {
  const uiManifestPath = join(out, "packages/pocket_ui/package.json");
  const uiManifest = JSON.parse(readFileSync(uiManifestPath, "utf8")) as Record<string, unknown>;
  delete uiManifest.private;
  write(uiManifestPath, `${JSON.stringify(uiManifest, null, 2)}\n`);

  const packageJson = {
    name: "@pocket/web-sdk-tools",
    version: "0.1.0",
    description: "Standalone PocketJS Web SDK and Editor; no Flutter environment required",
    private: false,
    type: "module",
    license: "MIT",
    workspaces: ["packages/pocket_ui"],
    scripts: {
      setup: "python3 scripts/prepare_upstream.py && bun install && cargo build --locked --release --manifest-path native/Cargo.toml --bin pocket_probe",
      bootstrap: "python3 scripts/prepare_upstream.py && bun install",
      "build:probe": "cargo build --locked --release --manifest-path native/Cargo.toml --bin pocket_probe",
      "build:web": "bun scripts/build_web.ts",
      "build:wechat": "bun scripts/build_wechat.ts",
      editor: "bun editor/server.ts --host=127.0.0.1 --port=8791",
      "editor:lan": "bun editor/server.ts --host=0.0.0.0 --port=8791 --update-host=0.0.0.0 --update-port=8792",
    },
    dependencies: {
      "@open-wxa/wxa-runner-core": "0.12.3",
      "@pocket/ui": "workspace:*",
    },
  };
  write(join(out, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  write(join(out, ".gitignore"), [
    ".cache/", ".pocket-build/", "node_modules/", "native/target/", "target/", "dist/", ".DS_Store", "*.log", "*.pem", "*.key", "",
  ].join("\n"));

  write(join(out, "README.md"), `# Pocket Web SDK\n\nStandalone PocketJS Web SDK and Editor. Flutter, Dart, CocoaPods, Xcode and the Android SDK are not required.\n\nThe Web target uses the pinned PocketJS compiler, admitted QuickJS bytecode (QJBC), PAK resources and the real PocketJS runtime compiled to WebAssembly. The browser boundary is standard \`WebAssembly.instantiate\` + Canvas2D with Pointer, IME, resize and visibility lifecycle support. There is no mock runtime or source-evaluation fallback.\n\n## Setup\n\nRequirements: Bun, Python 3, Rust/Cargo and an LLVM-compatible \`llvm-ar\`/\`emar\`.\n\n\`\`\`sh\nbun run setup\n\`\`\`\n\nNo Flutter command is run by setup or by the Web build.\n\n## Build a Web app\n\nA project root contains \`pocket.json\`, \`manifest.json\` and its JS/TS entry.\n\n\`\`\`sh\nbun run build:web -- --project-root=/path/to/app --outdir=dist/my-app\npython3 -m http.server 8080 -d dist/my-app\n\`\`\`\n\nThe output contains \`pocket-web.js\`, \`engine/pocketjs.wasm\`, \`pocket.config.json\`, build metadata, types and usage instructions. Hardware capabilities are opt-in browser adapters. If a browser or registered adapter does not provide a capability, the guest receives an explicit unsupported/unconfigured error.\n\n## Editor\n\n\`\`\`sh\nbun run editor\n# open http://127.0.0.1:8791\n\`\`\`\n\nThe Editor includes project management, real Guest preview, input/IME inspection, version management, signed packages and LAN test publishing. To expose the Editor and update server on the LAN, run \`bun run editor:lan\`. Device deployment remains an optional host integration and is not required for Web development.\n\n## UI ownership\n\nBusiness UI, state, routing and component composition belong in JS. Reuse the existing controls and inherit their focus, press/cancel, disabled, keyboard/gamepad, scrolling, IME, safe-area, accessibility, route and lifecycle behavior before changing skins or adding evidenced behavior. See \`docs/AI_APP_DEVELOPMENT.md\` and \`docs/COMPONENTS.md\`.\n\n## Updates\n\nThe canonical update route is \`<root>/<optional-prefix>/pocket/<hostVersion>/<packageId>/<packageVersion>/latest.json\`. Initial install may fetch the complete PAK; subsequent releases can fetch only changed content-addressed resource parts. The Editor version backend can publish and test this layout on a LAN.\n`);

  const sourceCommit = run(["git", "rev-parse", "HEAD"], REPOSITORY_ROOT).trim();
  write(join(out, "provenance.json"), `${JSON.stringify({
    sourceRepository: "CodeEagle/pocket",
    sourceCommit,
    pinnedPocketJsRevision: PINNED_REVISION,
    runtime: "QuickJS QJBC + PAK + PocketJS WebAssembly + Canvas2D",
  }, null, 2)}\n`);
}

function codeEagleEnvironment(): NodeJS.ProcessEnv {
  const token = run(["gh", "auth", "token", "--user", "CodeEagle"], REPOSITORY_ROOT).trim();
  if (!token) throw new Error("CodeEagle GitHub token is unavailable; run `gh auth login` for CodeEagle");
  return { ...process.env, GH_TOKEN: token };
}

function publish(out: string, repo: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`invalid GitHub repository: ${repo}`);
  const ssh = `git@github.com:${repo}.git`;
  if (!existsSync(join(out, ".git"))) run(["git", "init", "-b", "main"], out, process.env, true);
  run(["git", "config", "user.name", "CodeEagle"], out);
  run(["git", "config", "user.email", "stasura@hotmail.com"], out);
  run(["git", "add", "-A"], out);
  const staged = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: out, stdio: "ignore" });
  if (staged.status === 1) run(["git", "commit", "-m", "release: standalone Pocket Web SDK with Editor"], out, process.env, true);
  else if (staged.status !== 0) throw new Error("git diff --cached failed");

  const ghEnv = codeEagleEnvironment();
  const view = spawnSync("gh", ["repo", "view", repo], { cwd: out, env: ghEnv, stdio: "ignore" });
  if (view.status !== 0) run(["gh", "repo", "create", repo, "--public", "--description", "Standalone PocketJS Web SDK and Editor; no Flutter required"], out, ghEnv, true);
  const remotes = run(["git", "remote"], out).split(/\s+/).filter(Boolean);
  if (remotes.includes("origin")) run(["git", "remote", "set-url", "origin", ssh], out);
  else run(["git", "remote", "add", "origin", ssh], out);
  run(["git", "push", "--set-upstream", "origin", "main"], out, process.env, true);
  console.log(`export_web_sdk: published ${ssh}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) usage();
  const known = new Set(["--publish", "--force", "--help", "--out", "--repo"]);
  for (const arg of args) {
    if (arg.startsWith("--out=") || arg.startsWith("--repo=")) continue;
    if (arg.startsWith("--") && !known.has(arg)) throw new Error(`unknown option: ${arg}`);
  }
  const options: Options = {
    out: resolve(option(args, "out", DEFAULT_OUT)),
    repo: option(args, "repo", DEFAULT_REPO),
    publish: args.includes("--publish"),
    force: args.includes("--force"),
  };
  if ([REPOSITORY_ROOT, SDK_ROOT, resolve(REPOSITORY_ROOT, "demo")].includes(options.out)) throw new Error("refusing to export over a source directory");
  clearOutput(options.out, options.force);
  copySources(options.out);
  writeRepositoryFiles(options.out);
  if (options.publish) publish(options.out, options.repo);
  console.log(`export_web_sdk: generated ${options.out}`);
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    console.error(`export_web_sdk: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
