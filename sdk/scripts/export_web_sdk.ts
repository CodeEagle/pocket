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

import { SDK_VERSION } from "./prebuilt_tools.mjs";

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
  copyTree(join(SDK_ROOT, "templates"), join(out, "templates"));
  copyTree(join(SDK_ROOT, "editor"), join(out, "editor"));
  rmSync(join(out, "editor/test"), { recursive: true, force: true });

  for (const file of [
    "build_guest.ts",
    "prebuilt_tools.mjs",
    "toolchain.mjs",
    "package_toolchain.ts",
    "build_web_engine.ts",
    "build_system.ts",
    "build_web.ts",
    "build_wechat.ts",
    "flutter_target.ts",
    "native_probe_path.ts",
    "editor_service.mjs",
    "package_update.ts",
    "platform_scaffold.ts",
    "project_templates.ts",
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
  copyTree(join(SDK_ROOT, "packages/pocket_tftc"), join(out, "packages/pocket_tftc"));
  rmSync(join(out, "packages/pocket_tftc/test"), { recursive: true, force: true });
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
    "PROJECT_TEMPLATES.md",
    "tftc-migration.md",
    "TFTC_TRANSPORT_CONTRACT.md",
    "WEB_SDK_EXPORT.md",
    "NPM_TOOLCHAIN.md",
    "WINDOWS_BUILD.md",
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
    version: SDK_VERSION,
    description: "Standalone PocketJS Web SDK and Editor; no Flutter environment required",
    private: false,
    type: "module",
    license: "MIT",
    engines: { node: ">=22.22.2" },
    workspaces: ["packages/pocket_ui", "packages/pocket_tftc"],
    dependencies: {
      bun: "1.3.9",
      "find-process": "2.1.1",
      "tree-kill": "1.2.2",
    },
    devDependencies: {
      "@open-wxa/wxa-runner-core": "0.12.3",
      "node-gyp": "12.3.0",
    },
    optionalDependencies: { "@abandonware/noble": "1.9.2-26" } as Record<string, string>,
    scripts: {
      setup: "node scripts/toolchain.mjs setup",
      "setup:source": "node scripts/toolchain.mjs setup:source",
      "bootstrap:source": "node scripts/toolchain.mjs bootstrap:source",
      "build:probe:source": "node scripts/toolchain.mjs build:probe:source",
      bootstrap: "node scripts/toolchain.mjs bootstrap",
      doctor: "node scripts/toolchain.mjs doctor",
      "build:guest": "node scripts/toolchain.mjs build:guest",
      "build:probe": "node scripts/toolchain.mjs build:probe",
      "build:web": "node scripts/toolchain.mjs run scripts/build_web.ts",
      "build:wechat": "node scripts/toolchain.mjs run scripts/build_wechat.ts",
      start: "node scripts/editor_service.mjs start",
      stop: "node scripts/editor_service.mjs stop",
      status: "node scripts/editor_service.mjs status",
      editor: "node scripts/editor_service.mjs start",
      "editor:lan": "bun run editor",
    },
  };
  const archives = (existsSync(join(SDK_ROOT, '.pocket-build')) ? readdirSync(join(SDK_ROOT, '.pocket-build')) : []).filter(name => /^pocket-tools-(darwin|linux|win32)-(arm64|x64)-[0-9.]+\.tgz$/.test(name) && name.endsWith(`-${SDK_VERSION}.tgz`));
  if (archives.length) {
    Object.assign(packageJson.optionalDependencies, Object.fromEntries(archives.map(name => {
      copyFile(join(SDK_ROOT, '.pocket-build', name), join(out, 'prebuilt', name));
      const suffix = name.slice('pocket-tools-'.length, -`-${SDK_VERSION}.tgz`.length);
      return [`@pocket/tools-${suffix}`, `file:prebuilt/${name}`];
    })));
  }
  write(join(out, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  write(join(out, ".gitignore"), [
    ".cache/", ".pocket-build/", "node_modules/", "native/target/", "target/", "dist/", ".DS_Store", "*.log", "*.pem", "*.key", "",
  ].join("\n"));

  write(join(out, "README.md"), `# Pocket Web SDK\n\nStandalone PocketJS Web SDK and Editor. Flutter, Dart, CocoaPods, Xcode and the Android SDK are not required for the Web toolchain.\n\nThe Web target uses the pinned PocketJS compiler, admitted QuickJS bytecode (QJBC), PAK resources and the real PocketJS runtime compiled to WebAssembly. The browser boundary is standard \`WebAssembly.instantiate\` + Canvas2D with Pointer, IME, resize and visibility lifecycle support. There is no mock runtime or source-evaluation fallback.\n\n## AI 开发入口：先读这些文档\n\nAI 在修改代码前应按下列顺序读取；不要只看 README 后直接创造第二套运行时、布局系统或控件行为。\n\n| 顺序 | 文档 | AI 应从中获得什么 |\n| --- | --- | --- |\n| 1 | [AI_APP_DEVELOPMENT.md](docs/AI_APP_DEVELOPMENT.md) | 完整开发流程、JS/宿主边界、控件用法、Editor、资源打包、发布和热更新约定。 |\n| 2 | [COMPONENTS.md](docs/COMPONENTS.md) | 现有组件契约；自定义皮肤时必须继承默认交互、焦点、键盘/手柄、IME、无障碍和生命周期行为。 |\n| 3 | [EDITOR_STUDIO.md](docs/EDITOR_STUDIO.md) | Editor 启动、真实预览、版本后台、局域网发布和预览入口。 |\n| 4 | [EDITOR_TEST_PACKAGES.md](docs/EDITOR_TEST_PACKAGES.md) | test/stable 包、签名产物、版本管理和局域网热更新测试。 |\n| 5 | [PACKAGE_UPDATE_MODES.md](docs/PACKAGE_UPDATE_MODES.md) | 首次整包以及后续按资源/内容哈希进行细粒度更新。 |\n| 6 | [HARDWARE_MODULES.md](docs/HARDWARE_MODULES.md) | 硬件和权限按需启用；浏览器没有的能力由应用注册真实 adapter。 |\n| 7 | [WEB_SDK_EXPORT.md](docs/WEB_SDK_EXPORT.md) | Web SDK 的来源、保留实现、必要适配、消融结果和真实验证证据。 |\n| 8 | [NPM_TOOLCHAIN.md](docs/NPM_TOOLCHAIN.md) | npm 安装、跨平台工具链入口、buildGuest/QJBC/PAK 构建和验证边界。 |\n| 9 | [PROVENANCE.md](docs/PROVENANCE.md) | 固定上游版本、来源和验证边界。 |\n| 10 | [WECHAT_HOST_IMPLEMENTATION.md](docs/WECHAT_HOST_IMPLEMENTATION.md) | 仅在需要微信目标时阅读：WXWebAssembly、Canvas2D 和平台限制。 |\n\nAI 必须遵守：业务 UI、状态、路由和组件组合放在 JS；硬件能力按需声明；缺失能力明确返回 unsupported/unconfigured；新界面默认继承现有控件行为；Web/Editor 都使用固定的 buildGuest/QJBC/PAK 管线，不增加 mock 或 source-eval fallback。\n\n## Install and build\n\nOnly Node.js 22.22.2+（建议 Node.js 24 LTS） and npm are required. Bun is installed and managed by npm; compiler/probe binaries and the prepared pinned compiler are supplied by the platform package. Run:\n\n\`\`\`sh\nnpm run setup\n\`\`\`\n\n\`npm run setup\` installs npm dependencies and verifies the prebuilt tools (platform, SDK revision, QuickJS ABI and SHA-256). It does not invoke Rust/Cargo, Python or C/C++ tools, and will fail clearly if the platform package is unavailable. Source builds are maintainer-only commands ending in :source. No Flutter command is run by setup or by the Web build.\n\nA project root contains \`pocket.json\`, \`manifest.json\` and its JS/TS entry. Build the complete guest artifacts directly with npm:\n\n\`\`\`sh\nnpm run build:guest -- --project-root=/path/to/app --outdir=/path/to/app/dist\nnpm run build:web -- --project-root=/path/to/app --outdir=/path/to/web\n\`\`\`\n\nThe guest build invokes the pinned \`buildGuest\` implementation, emits \`app.qjbc\`, \`app.bytecode.json\` and \`app.pak\`, and includes the vendored \`@pocket/ui\` workspace package. It does not require Flutter. The Web build additionally emits \`pocket-web.js\`, \`engine/pocketjs.wasm\`, \`pocket.config.json\`, build metadata, types and usage instructions.\n\nThe bundle includes macOS arm64 and Windows x64 platform archives. Windows CI has verified clean npm setup/doctor, Noble WinRT addon loading, real App/Game QJBC/PAK builds and input-driven Preview frames, plus Studio start/health/status/stop on fixed port 8791. Windows physical BLE device connections/notifications and Linux native BLE remain unverified or unsupported as documented. The npm packages have not been published to a registry yet. See docs/NPM_TOOLCHAIN.md and docs/WINDOWS_BUILD.md for evidence and limits.\n\n## Editor\n\n\`\`\`sh\nnpm run editor\n# open http://127.0.0.1:8791\n\`\`\`\n\nThe Editor includes project management, real Guest preview, input/IME inspection, version management, signed packages and LAN test publishing. Device deployment remains an optional host integration and is not required for Web development.\n\nTFTC control and live notify changes are provided by [@pocket/tftc](packages/pocket_tftc/README.md). Its guide covers Preview Bluetooth, Windows prerequisites, event contracts and hardware acceptance limits.\n\n## UI ownership\n\nBusiness UI, state, routing and component composition belong in JS. Reuse the existing controls and inherit their focus, press/cancel, disabled, keyboard/gamepad, scrolling, IME, safe-area, accessibility, route and lifecycle behavior before changing skins or adding evidenced behavior. See [AI_APP_DEVELOPMENT.md](docs/AI_APP_DEVELOPMENT.md) and [COMPONENTS.md](docs/COMPONENTS.md).\n\n## Updates\n\nThe canonical update route is \`<root>/<optional-prefix>/pocket/<hostVersion>/<packageId>/<packageVersion>/latest.json\`. Initial install may fetch the complete PAK; subsequent releases can fetch only changed content-addressed resource parts. The Editor version backend can publish and test this layout on a LAN.\n`);

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
