# npm 工具链与完整 Guest 构建

Standalone Web SDK 的 npm 入口只负责调度现有的 PocketJS 构建实现。它不会另起一套编译器，也不会把源码解释执行当成成功占位：`buildGuest` 仍然使用固定版本的 PocketJS 编译器，随后使用同一 ABI 的 QuickJS 编译器生成 `app.qjbc`，并保留编译器生成的 `app.pak`。

## 安装与命令

产品开发者只需要 Node.js 20+ 和 npm。`npm run setup` 安装 npm 管理的 Bun 运行时、SDK workspace 依赖和当前系统对应的预编译工具包（例如 `@pocket/tools-darwin-arm64@0.1.1`）；它会校验 SDK 版本、QuickJS ABI、每个文件的 SHA-256 和平台，不会调用 Rust、Python、`patch`、C/C++ 编译器，也不会把 macOS 二进制当成 Windows/Linux 工具。

在仓库根目录或导出的 SDK 根目录运行：

```sh
npm run setup
npm run doctor
```

当前仓库的本地验收包位于 `sdk/.pocket-build/pocket-tools-darwin-arm64-0.1.1.tgz`。预编译包尚未发布到 npm registry；发布前可将对应平台的 `.tgz` 放入 SDK 的 `prebuilt/` 目录，或设置 `POCKET_TOOLS_PACKAGE=/absolute/path/to/unpacked/package`。缺少平台包、版本不匹配、ABI 不匹配或哈希校验失败时命令会直接报错。

完整 Guest 构建默认使用预先准备的 pinned compiler、预编译 `pocketjs_bytecode` 和 `pocket_probe`：

```sh
npm run build:guest -- \
  --project-root=/path/to/project \
  --outdir=/path/to/project/dist
npm run build:probe
```

`build:probe` 只验证已安装的预编译探针，不会在开发者电脑上编译 Rust。`npm run editor` / `npm start` 也使用同一平台包和 npm 管理的 Bun。

源码发布者才需要以下维护命令；它们需要 Python 3、`patch`、Rust/Cargo 1.93+ 和平台 C/LLVM 工具链：

```sh
npm run bootstrap:source
npm run setup:source
npm run build:probe:source
npm run build:engine:source
npm run package:tools
```

它们只用于生成下一版平台包，产品开发不需要执行。旧的 `build:wechat` 整包路径同样属于维护者 source build，不在 npm-only 用户支持范围内；只有显式设置 `POCKET_SOURCE_BUILD=1` 才允许它调用 Cargo。直接调用底层脚本时也必须显式设置 `POCKET_SOURCE_BUILD=1`，否则不会回退到本机源码编译。

`project-root` 必须包含 `pocket.json`、`manifest.json` 和项目入口。输出至少包含：

- `app.qjbc`：已准入的 QuickJS bytecode；
- `app.bytecode.json`：与该 bytecode 对应的 ABI/元数据；
- `app.pak`：编译器生成的资源包；
- `guest-manifest.json`。普通项目资源只有显式传入 `--copy-assets-to=/path/to/host/assets` 时才复制到宿主目录。

`@pocket/ui` 位于 `packages/pocket_ui`，版本固定为 `0.1.0`，以 npm 可解析的同版本 workspace 依赖提供给 Guest。导出脚本会去除它的内部 `private` 标记，但不会复制测试和构建缓存。平台包携带固定编译器源码及其依赖清单，开发者不需要安装 Bun；npm 安装的 Bun 只作为内部执行器。

Web 目标仍可通过 npm 转发：

```sh
npm run build:web -- --project-root=/path/to/project --outdir=/path/to/web
npm run editor
```

Editor 默认监听 `http://127.0.0.1:8791`。`build:web` 和 Editor 内部使用 npm 安装的 Bun；用户无需全局安装 Bun。浏览器 WebAssembly 运行时必须与所用平台包的 QJBC ABI 匹配，通用预编译 WASM 包的 Windows/Linux 实机验收尚未完成，不把 Web 输出或 native Preview 的 macOS 结果当作全平台证明。

## 来源与保留边界

本入口复用当前 SDK 中的 `scripts/build_guest.ts`、固定编译器、平台工具包和 `packages/pocket_ui`。本次先检查了保留父工程 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` 的 `pubspec.yaml`、`tools/compile_pocket_syslib_aot.py` 和 `native/pocket_runtime_multi.c`（排除旧的 `pocket_host/`）。父工程保留宿主/资源分工，但没有完整的 `buildGuest` 或 `@pocket/ui` npm 包；因此继续复用当前 SDK 已有的固定上游构建管线，不退回历史 AOT 工具。npm 用户路径只消费发布侧生成的平台包；`prepare_upstream.py`、Rust 和补丁脚本留在发布/CI 侧。固定上游版本、归档校验和补丁清单由 `prepare_upstream.py` 作为单一来源维护。

这样做消除了重复的编译包装层：npm 调度器只安装平台包、校验 ABI/哈希、选择 npm Bun 并转发参数；不会复制 `buildGuest`、QuickJS 编译器、布局引擎或运行时。`@pocket/ui` 也只有一个公开 workspace 来源。

## 平台验证边界

macOS 已使用真实预编译平台包生成 app/game 模板的 QJBC、PAK，并在 Pocket Preview 路径执行。导出测试会检查 `build_guest.ts`、`@pocket/ui`、templates、平台包解析器和 toolchain manager 都进入独立包，且不会带入源码缓存、`target` 或 Flutter 项目。

Windows/Linux 的 npm 入口和平台包结构已定义，发布 CI 负责分别生成对应的 `win32-x64`、`linux-x64` 等包；当前 checkout 尚未在这些系统实机完成工具包构建、Preview 或蓝牙硬件验收。因此只能声明“无需 Rust 的分发路径已接好”，不能声明 Windows/Linux 已实机通过。

## 本次实际验收（macOS）

- 本地 `pocket-tools-darwin-arm64-0.1.1.tgz` 安装后，`npm run setup` 成功；在 `/tmp/pocket-node-only-path` 中用 sentinel 屏蔽 `cargo`、`rustc`、`python`、`python3`、`patch`、`cc`、`gcc`、`clang` 和全局 `bun` 后，默认 npm 路径仍成功，`/tmp/pocket-node-only-blocked.log` 为 0 bytes。
- 独立导出目录 `/tmp/pocket-node-only-sdk-acceptance` 的 npm setup 成功（约 22 秒）；没有 `.cache/pocketjs`、`native/target` 或 Flutter 项目，clean Guest 和 clean Web 均已生成真实产物；clean Web 的 Playwright 实跑也完成主题背景切换和恢复，无浏览器错误（`/tmp/pocket-node-only-clean-web-test.log`）。
- 导出目录中的 App 模板生成 QJBC 190738 bytes、PAK 905744 bytes；Game 模板生成 QJBC 184898 bytes、PAK 905728 bytes。真实 Preview 加载这些字节码，指针输入完成 App 深浅主题切换、Game 命中计分、暂停后计时保持、继续后计时变化。结果日志：`/tmp/pocket-node-only-preview.log`。这验证 Pocket native Preview 运行，不等同于 Flutter 手机实跑或 WASM 浏览器验收。
- 本轮 App/Game 真实 QJBC/PAK 与 Native Preview 验收全部通过：主题切换、命中计分、暂停/继续均有输入驱动的帧变化。最新测试计数由主线程在最终验收后补充；本节不重复记录历史批次计数。
- 当前 source 编译出的 WASM 已替换旧的 binary-input 不兼容产物。Playwright Chromium 真实 Web 验收中，Canvas 背景从 `[248,250,252,255]` 切换为 `[13,23,38,255]` 后恢复，浏览器无错误；日志：`/tmp/pocket-node-only-web-test.log`。这验证当前 source WASM 与 QJBC/PAK 的契约，不代表 Windows/Linux Web 已验收。
- 生成该 source WASM 时，维护者环境需要用一个仅存在于 `/tmp` 的临时 linker wrapper 修正损坏的 `rust-lld` 库搜索路径；wrapper 没有写入 SDK，也不进入 npm-only 用户路径。
- Guest 模板的默认 Inter 字体目前缺少中文字形，Web 截图中的中文可能显示为方框；Studio DOM 中文正常。本轮没有把字体覆盖限制当作已修复。
- 平台包发布侧仍需在 CI 运行 Rust 构建；本次开发者验收只验证 npm 安装、ABI/哈希校验、QJBC/PAK 生成和 Preview 运行。
- 干净导出最终包为 `sdk/.pocket-build/pocket-web-sdk-tools-0.1.1.tgz`。最终 setup 日志为 `/tmp/pocket-node-only-final-setup.log`；Noble 的 N-API 预编译文件来自 `/tmp/pocket-node-only-sdk-final/node_modules/@pocket/tools-darwin-arm64/noble/prebuilds/darwin-arm64/node.napi.node`，`sourceBuildPresent:false`。`npm install --ignore-scripts` 不编译该 native 模块，作用域环境变量由 Node 负责设置。0.1.0 的旧验收日志可继续作为历史证据，但不代表当前分发版本。
- Noble `poweredOn` 后的实际扫描发现了附近 BLE 设备，日志为 `/tmp/pocket-node-only-final-ble.log`；本轮未扫到 DK-META2，因此不把这次扫描写成 DK-META2 的重新连接验收。Linux 当前明确为 `unsupported`；没有生成、发布或验收 Linux HCI 预编译包，也没有新增 loader，不会要求用户安装 Rust 或其他本机工具链。

`npm run doctor` 检查平台包、清单、ABI 和文件哈希；不能代替上述加载和交互验收。源码发布命令才需要 `patch`；产品开发不需要把它加入 PATH。完整 Worker 能力也尚未在 Windows 验收。

当前只生成并验收了 macOS arm64 平台包；Windows/Linux CI 尚未运行，npm registry 也尚未发布平台包。Flutter 真机/模拟器打包仍需要消费者自己的 Flutter SDK、对应平台 SDK、签名与设备环境，本轮没有进行手机实跑。

额外执行 `python3 sdk/scripts/check_architecture.py` 时，当前共享工作区的 `demo/lib/main.dart` 为 203 行，超过薄宿主 100 行限制；该项未通过。本次 npm 工具链没有修改该 Dart 文件，也未将此检查记为通过。

## 0.1.1 打包复验

- 干净目录 `/tmp/pocket-sdk-0.1.1` 的 `npm run setup` 验证 0.1.1 平台包与 npm 管理的 Bun；屏蔽源码工具链的日志仍为 0 bytes。
- 0.1.1 回归共 51 tests / 11 files / 359 expectations，全部通过（`/tmp/pocket-0.1.1-tests.log`、`/tmp/pocket-0.1.1-guest-tests.log`）。
- 实际 Web 构建生成 QJBC、PAK 和 16384391 bytes 的 WASM；Playwright Chromium 主题切换与恢复通过，无浏览器错误（`/tmp/pocket-0.1.1-web-test.log`）。
- 预编译 Noble 实际扫描通过，本地模块没有 `build/Release/binding.node`（`/tmp/pocket-0.1.1-ble.log`）；本轮未发现 DK-META2。
- 分发包仅包含当前已生成的 macOS arm64 平台包；Windows 平台包需 CI 生成并进行实机验收。未发布 npm registry。
