# 本地 Pocket Studio

Studio 编辑原始 JS/TS 项目，使用 SDK 已有的 `buildGuest` 构建 QuickJS 字节码，提供网页交互预览和 Flutter 设备部署。默认页面仅显示预览、测试包与折叠高级设置，Copy preview link 供 Codex 浏览器直接访问。内置聊天已移除，详见 [预览页说明](EDITOR_PREVIEW_PAGE.md)。业务页面仍属于 JS；这次没有增加 Dart 页面或第二套布局引擎。

## 一键启动或重启

```sh
cd /Volumes/ORICO/Development/Github/pocket
npm run setup   # 首次安装依赖
npm start
```

浏览器固定打开 **http://127.0.0.1:8791**。`npm start` 和 `npm restart` 都会停止本仓库已有 Studio 后重新启动，并清理遗留的 8790、8792、8793 Studio 实例；不删除工作区或项目。`npm run status` 查看状态，`npm stop` 停止。其他程序占用 8791 时明确报错，不会换端口，也不会终止无关程序。在 `demo/js` 执行 `bun run editor` 也会调用同一个 npm 入口。

启动器使用 Node.js 与 npm 库 [`find-process`](https://github.com/yibn2008/find-process)、[`tree-kill`](https://github.com/pkrumins/node-tree-kill)，复用平台进程查找和进程树终止能力。Windows、macOS、Linux 使用同一份启动逻辑；产品开发只需要 Node.js 22.22.2+（建议 Node.js 24 LTS） 和 npm。npm 会安装受 SDK 锁定的 Bun 运行时与当前系统预编译工具包，不要求全局安装 Bun、Rust、Python、`patch` 或 C/C++ 工具链。服务使用后台子进程并将日志写到 `sdk/.pocket-build/`，不安装登录项或系统服务。工作区固定保留在 `sdk/.pocket-build/editor-workspace-8791/`。旧 macOS launchd 任务只在升级清理时移除，新的启动不再依赖 launchctl。

首次执行 `npm run setup` 安装 SDK workspace 依赖、npm Bun 和平台预编译的 `pocketjs_bytecode`/`pocket_probe`，并校验 SDK 版本、QuickJS ABI 和文件哈希；不会在本机运行 Cargo。日常只需 `npm start`。完整命令、平台包目录和维护者源码构建入口见 [NPM_TOOLCHAIN.md](NPM_TOOLCHAIN.md)。启动器成功返回前会检查服务健康，不会将进程已创建当作启动成功。真实 Preview 需要上述 setup 成功完成；Windows/Linux 的 npm 调度入口已适配，但对应平台包和实机 Preview 尚未在这些系统验收。

Studio 使用简体中文界面。左上角可选择项目或新建，先选“应用 / 游戏”模板。

通用消费者可以直接运行：

```sh
cd sdk
npm run editor -- \
  --project-root=/absolute/path/to/js-project \
  --flutter-root=/absolute/path/to/flutter-project
```

Flutter 根目录是启动时的可信配置，网页不能提交任意本地路径或命令。仅需网页预览时可以省略 `--flutter-root`。部署到 Flutter 模拟器/真机时，仍需消费者自己的 Flutter SDK 和签名/设备环境；这与 npm Preview 工具包是两条边界。

使用 npm 启动的 Studio 不需要单独准备 Bun、Rust native probe 或 Python；这些内容由 npm 平台包提供。`flutter-root` 只在要部署到 Flutter 模拟器/真机时需要，网页 Preview 本身不要求 Flutter。

## 创建 App 或 Game 项目

Studio 左上角的项目选择器用于切换已有项目，旁边的 **新建项目** 打开新建对话框，先选择 `App` 或 `Game` 模板。App 适合 screens、forms 和 product UI；Game 提供一个纯 JS 的 3×3 目标格子、30 秒倒计时、计分、暂停/继续和重新开始 示例。提交时 Studio 将 `template` 写入 `/api/projects`，并保存到生成项目的 `editor.json`；默认值是 `app`。

CLI 和 Studio 使用同一个模板解析器，因此也可以在终端创建：

```sh
cd /Volumes/ORICO/Development/Github/pocket/sdk
npm run init -- /absolute/path/to/app --template=app --sdk-root "$PWD"
npm run init -- /absolute/path/to/game --template=game --sdk-root "$PWD"
```

两种模板都生成 `app.tsx`、`manifest.json`、`pocket.json` 和 `editor.json`。CLI 还会生成 `vendor/pocket-ui/` 和 `flutter/`；Studio 工作区使用 SDK 公共 UI 包和现有 Preview。模板、创建参数、构建命令和 Game 能力边界见 [`PROJECT_TEMPLATES.md`](PROJECT_TEMPLATES.md)。

若本机尚未安装平台包，先执行 `npm run setup`；`npm run build:probe` 只验证已安装的预编译 probe，不会编译 Rust。临时测试包可通过 `POCKET_TOOLS_PACKAGE=/absolute/path/to/unpacked/package` 指定。源码发布者需要 `npm run build:probe:source`，产品开发不需要执行。

## 本地版本后台与局域网发布

Editor 内置一个只读版本后台，复用正式 `packageArtifacts`、Ed25519 签名、bundle/blob
和同一客户端更新协调器。点击 **Publish test package** 时会自动选择本机私有 IPv4，
局域网只开放签名后的发布产物，不开放 Editor API、项目源码或私钥。地址遵循：

```text
http://<LAN_IP>:<port>/pocket/<hostVersion>/<packageId>/test/latest.json
```

多网卡或需要固定地址时显式启动：

```sh
npm run editor -- \
  --project-root=/absolute/path/to/js-project \
  --flutter-root=/absolute/path/to/flutter-project \
  --update-host=192.168.1.20 \
  --update-host-version=3.2.0
```

`test` 是单调递增的测试槽，正式 Publish 使用 `stable` 槽；实际 version/build 仍在
签名 payload 中。首次需要让调试宿主取得页面给出的 `host.json` 公钥配置，之后只需
Build → Publish → App Check/Apply，不再重新构建 Flutter。没有可用 LAN 时 Publish
仍可回退 loopback 供模拟器/桌面测试；真机必须能访问显示的 LAN 地址。HTTP 只用于
debug allowlist，生产发布仍应部署到 HTTPS。

Editor 顶部的 **Versions** 按钮和页面中的 **Version management** 面板是版本后台入口。
打开后会启动/刷新只读 listener，同时展示后台 origin、hostVersion、`test`/`stable`
两个槽，以及根应用和 mini-app 当前签名 payload 的 version/build、`latest.json` 与
`host.json`。列表直接读取真实发布目录，不维护可能漂移的第二份版本数据库。

## 编辑与预览

1. 选择项目和源文件，修改并保存。
2. 构建，查看真实编译日志和 QJBC/PAK 产物。
3. 网页预览接收真实运行时帧；可以点击、滚动、输入和切换视口。
4. 选择设备并部署，检查 Flutter 实际效果。

创建项目后，点击 **构建** 才会把当前模板编译成真实 QJBC/PAK；随后在 Preview 中观察输入驱动的帧变化。Game 模板的倒计时由官方 `onFrame({ continuous })` 和 `simulationHz()` 驱动，暂停时应停止计时，点击命中格子应更新分数和目标。Studio 不会把父 Demo 的 3D/物理/DrawList 展示代码复制进项目，也不会把业务状态放进 Flutter。

显示名称与机器名称分开：设置中的 Display name 更新 `pocket.title`，保留已有合法的 `pocket.name` slug；保存配置保留消费者自定义入口、输出名称和其他 app 字段。`editor.json` 保存 Editor 的版本/build 等构建身份，遵循 SDK 既有优先级。

网页端不是 Flutter Web。`preview.ts` 启动 SDK 的 `pocket_probe`，加载已构建的 QJBC/PAK，执行 PocketJS 布局、Guest 事件和帧逻辑。`client/preview.js` 将真实 FrameResult 的 DrawOps 和资源投到 Canvas2D。运行时的 demand schedule 决定下一次唤醒，SSE 推送帧；没有持续空闲绘制探针。最后一个浏览器订阅断开后释放空闲 probe，活动会话数量有上限。

Canvas 的字体、圆角栅格、资源解码与 Flutter 可能不同，浏览器性能数据不能代替 Flutter 真机 FPS/功耗验收。System catalog 映射启动真实 SystemUI，并为已安装且有构建产物的子应用启动独立 native probe；adapter 将真实 child DrawOps 按 host-surface rect 做裁剪/缩放、资源命名空间隔离和输入坐标转换。Showcase 的 Profile → Lobby → 返回结果链已用真实 JS guest 验证。子 probe 接收 `system.runtime.create` 的 `memory.heapLimitBytes`/`maxPakBytes`，由现有 native QuickJS/PAK admission 执行；浏览器不承诺 GPU、Dart 或操作系统内存配额。原生硬件、视频和依赖原生 textInput 插件的输入框不会被伪造为成功；相应行为需要部署到设备确认，浏览器键盘事件转发不等于完整原生 IME。未知 host capability 返回明确 unsupported 错误而不是永久 pending。源码保存后需重新构建，旧构建的预览不代表未构建的最新源码。

## 模拟器与真机部署

`devices.ts` 使用 `flutter devices --machine` 枚举当前可用目标，支持 iOS Simulator、Android Emulator、连接的 iOS/Android 设备。未启动的模拟器需要先在 Xcode/Android 工具中启动；无线设备需先建立 Flutter 可识别的连接。

部署先执行同一 SDK 字节码构建流程，再执行绑定消费者的 `flutter run --machine`。带 System 子应用的消费者复用既有 `build:system` 管线。设备 ID 必须来自实际枚举；命令使用固定 argv，网页不能传 shell 命令。日志与任务历史有容量限制，构建/启动有并发锁，取消只终止 Studio 自己启动的子进程。

状态到 `running` 表示 Flutter 已启动预览。可以继续编辑源码；需要重新构建、停止旧部署并再次部署，当前没有声称 TSX 自动热重载到已运行的字节码。真机仍需要消费者工程本身的签名、开发者模式、USB/无线信任和系统权限；错误在部署日志中显示，Studio 不代办这些系统授权。

## 给 Codex 打开预览

选择并构建项目后点击 **Copy preview link**，把绝对链接交给 Codex 浏览器即可直接打开并操作预览。独立预览路径为 `/api/projects/<project-id>/preview`；本地页面无需 Codex 登录，不发送模型请求。

源码和构建操作仍使用当前项目文件与 pinned `buildGuest`，代码修改在外部 Codex 中完成。页面不再保留内置聊天、模型选择、附件和聊天区域标注状态。旧传输 API 暂保留给既有调用方，网页不会访问它们。

## 代码职责与复用来源

| 代码 | 职责与来源 |
| --- | --- |
| `editor/server.ts` | 复用既有 Editor 的文件、安全、构建与签名发布边界，组合新路由。 |
| `editor/preview.ts`、`client/preview.js` | 使用现有 native probe/FrameResult；新增本地 SSE 与 Canvas 投影适配，不复刻布局引擎。 |
| `editor/devices.ts` | 可信消费者绑定、固定命令、设备枚举、部署任务与进程生命周期。 |
| `editor/codex.ts` | 复用 pinned PocketJS `tools/companion/codex.ts` 的 CLI/App Server 传输，增加项目/图片/区域/任务边界。 |
| `editor/client/` | 编辑、预览、设备日志、悬浮对话的纯网页 UI。 |
| `scripts/editor_service.mjs` | npm 统一启动器，固定 8791，复用进程管理库、既有 Editor 与工作区。 |

实现前检查了保留的旧工程 `pocketjs_flutter_demo`（排除 `pocket_host/`），参考 `native/` 的 Guest 执行链和 `web_wasm_preview/index.html`。保留当前 SDK 已迁移的 Editor 项目/构建工作流，扩展现有 native probe。旧网页中的演示图形不是通用 Guest 执行器，因此没有复制为“Demo 已支持网页”的占位实现。Codex 接入复用当前 pinned 上游 `tools/companion/codex.ts` 传输；没有复制用户凭证或引入新的认证存储。没有保留新模块的兼容别名、重复模型清单或后台空闲帧轮询。原来的签名发布入口保留在折叠的 Advanced 区域。npm 用户路径消费平台包；Rust/Python/补丁脚本只用于 SDK 发布侧生成下一版平台包。

## 验证

2026-11-06 在 macOS 实测 `npm run setup → npm start → npm restart → npm stop → npm start`：重启替换 PID，旧进程退出；停止后 8791 释放；8790/8792/8793 遗留 Studio 均清理。用独立测试 HTTP 程序占用 8791 时，启动器拒绝接管且保留该进程；设置其他端口也会拒绝，不影响已运行的 8791。最终服务在 8791 保持运行。Windows/Linux 使用库提供的平台进程 API，尚未在对应系统实机验收。

23 项创建/配置/构建/导出回归通过，中文 Studio 已通过真实浏览器操作；App/Game 中文模板均通过真实字节码 Preview 的输入与计时验收。诊断日志、用户项目名称和用户业务源码保留原始内容，不做自动翻译。

本轮 npm 平台包验收在 macOS 完成：`npm run setup` 使用本地 `pocket-tools-darwin-arm64-0.1.1.tgz`，未运行 Cargo；`npm run build:guest` 生成真实 QJBC/PAK，Preview 通过主题切换、命中计分、暂停/继续输入检查。Windows/Linux 平台包由发布 CI 生成，当前尚未在对应系统完成实机 Preview 或蓝牙硬件验收。

本轮进一步在 `/tmp/pocket-node-only-path` 中屏蔽 `cargo`、`rustc`、`python`、`python3`、`patch`、`cc`、`gcc`、`clang` 和全局 `bun`，默认 npm setup、App/Game QJBC/PAK 和 Native Preview 仍全部通过；阻断日志 `/tmp/pocket-node-only-blocked.log` 为 0 bytes。App 主题切换、Game 命中计分、暂停/继续均产生真实帧变化。最新测试计数由主线程在最终验收后补充。

当前 source WASM 已替换旧的 binary-input 不匹配产物。Playwright Chromium 验收中 Canvas 背景从 `[248,250,252,255]` 切换到 `[13,23,38,255]` 后恢复且无浏览器错误，日志为 `/tmp/pocket-node-only-web-test.log`。这轮仅在 macOS arm64 完成；Windows/Linux CI 和 npm registry 发布尚未完成。默认 Inter 字体缺少中文字形，Guest Web 截图中的中文可能显示为方框，Studio DOM 中文正常；这属于已知字体覆盖限制。生成 source WASM 使用的 linker 修正仅为维护者 `/tmp` wrapper，没有写入 SDK。

本轮没有进行 Flutter 手机实跑。Flutter 真机/模拟器打包仍需要消费者自己的 Flutter SDK、对应平台 SDK、签名和设备环境；旧的 `build:wechat` 整包与 `build:engine:source` 属于维护者 source 路径，只有显式 `POCKET_SOURCE_BUILD=1` 才允许 Cargo，不属于 npm-only 用户支持范围。

干净导出最终包为 `sdk/.pocket-build/pocket-web-sdk-tools-0.1.1.tgz`，setup 日志为 `/tmp/pocket-node-only-final-setup.log`。Noble N-API 预编译文件来自 `/tmp/pocket-node-only-sdk-final/node_modules/@pocket/tools-darwin-arm64/noble/prebuilds/darwin-arm64/node.napi.node`，`sourceBuildPresent:false`；`npm install --ignore-scripts` 不编译 native 模块，Noble 的作用域环境变量由 Node 设置。`poweredOn` 后实际扫描发现附近 BLE 设备，日志为 `/tmp/pocket-node-only-final-ble.log`，但本轮未扫到 DK-META2，不记录为 DK-META2 的重新连接验收。Linux 当前明确为 `unsupported`；没有生成、发布或验收 Linux HCI 预编译包，也没有新增 loader，不会让用户安装 Rust 或其他工具链。0.1.0 相关日志仅保留为历史验收证据。

```sh
cd sdk
bun run test:editor
python3 scripts/check_architecture.py
```

Editor 回归覆盖既有文件/安全/构建发布流程，以及 Codex 传输、图片/区域边界、真实 native Guest 输入变帧、设备固定命令/并发/取消。真实模型请求、浏览器和模拟器验收结果应与单元测试区分；测试不伪造模型或设备上线成功。

本轮实际验收：

- `bun run test:editor`：28 pass / 0 fail；架构边界检查与客户端语法检查通过。
- 本机 CLI 返回 ChatGPT 登录状态和 8 个动态模型；真实请求完成，无凭证文件读取或复制。
- Playwright Chromium 从网页保存并恢复源码、真实构建、点击 Showcase 计数 `00 → 01`。
- 网页框选后，真实模型收到截图和 `(25,52,325,160)` 区域，识别出 `Made to feel native.`；后续消息沿用同一 thread。
- 通过 Editor 网页按钮真实执行 System 主/子应用构建及 `flutter run --machine`，在 iPhone 18 Pro Simulator 安装并显示首页；状态到达 `running`，刷新网页后恢复该任务与停止按钮。
- 移动 `390×844` 与平板 `768×1023` 切换后，已校验运行时实际尺寸；使用有效的 10-bit pointer 范围，避免提供超出 1023 坐标的交互预设。
- Canvas 已验证贴图加载、圆角 mask、ARGB tint 与资源增量重放；真实 Hero 圆角内像素 `(28,80)` 为 `[49,93,235,255]`。新订阅者会补齐已有贴图，普通帧仍只传资源增量。
- 独立的两个 Chromium 客户端都通过圆角/图标像素检查；第二个客户端收到 8 份缓存资源，未因原生资源只发增量而缺图。
- Android 真机已被实际枚举；本轮没有安装到该真机，不将枚举成功当作真机部署验收。

本地验收日志/截图位于 `/tmp/pocket-studio-acceptance-verified.log`、`/tmp/pocket-studio-deploy-ui-final.log`、`/tmp/pocket-studio-preview-fixed.png`、`/tmp/pocket-studio-device-final.png`，属于临时证据，不是 SDK 发布产物。

测试包与模拟器 Check/Apply 的接入、版本规则及实际验收见 [Editor 测试包与模拟器热更新](EDITOR_TEST_PACKAGES.md)。
