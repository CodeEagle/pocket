# Pocket SDK

这里是可集成的 SDK 唯一入口。它包含公共 Flutter 包、JS UI 库、QuickJS/PocketJS runtime、字节码编译链、硬件和服务包、Editor 以及 CLI。Showcase 不在 SDK 内，位于同级 `../demo`。

公共 Flutter 包就是当前目录的 `pubspec.yaml` 和 `lib/pocket_sdk.dart`，包名为 `pocket_sdk`。底层实现放在 `packages/`，唯一 CLI 是 [`pocket.ts`](pocket.ts)。

视觉小说实现位于 `packages/pocket_vn`，剧情、菜单、存档策略和自动播放由 JS 拥有；Editor 可编辑同一份剧本、剧情连接、变量声明、资源、配音绑定、玩家输入与翻译目录，并提供完整项目备份/恢复。它沿用同一 `buildGuest` 字节码链路，完整示例是 Demo 的《雾港末班信》。接口与验收入口见 [引擎](docs/VISUAL_NOVEL_ENGINE.md)、[Editor](docs/VISUAL_NOVEL_EDITOR.md)、[变量生命周期](docs/VISUAL_NOVEL_VARIABLE_LIFETIMES.md)、[项目备份](docs/VISUAL_NOVEL_BACKUPS.md)、[草稿与编辑历史](docs/VISUAL_NOVEL_HISTORY.md)、[文本编写](docs/VISUAL_NOVEL_AUTHORING.md)、[舞台编排](docs/VISUAL_NOVEL_STAGE_AUTHORING.md)、[场景变换](docs/VISUAL_NOVEL_SCENE_TRANSFORMS.md)、[玩家输入](docs/VISUAL_NOVEL_INPUT.md)、[配音](docs/VISUAL_NOVEL_VOICE.md)、[本地化](docs/VISUAL_NOVEL_LOCALIZATION.md) 和 [平台](docs/VISUAL_NOVEL_PLATFORMS.md)；[完整市场差距表](docs/VISUAL_NOVEL_LETSGAL_PARITY.md) 保留尚未完成的能力；[当前 Goal 与量化验收](docs/VISUAL_NOVEL_GOAL.md) 规定功能、故事、画质、编辑、平台与性能的完成门槛。

创建一个独立消费者项目：

```sh
cd /Volumes/ORICO/Development/Github/pocket/sdk
npm run init -- /path/to/my-app --sdk-root "$PWD"
npm run build -- /path/to/my-app --sdk-root "$PWD" --platform=ios-sim
```

创建时可以选择两个初始模板，省略 `--template` 时使用 `app`：

```sh
npm run init -- /path/to/my-app --template=app --sdk-root "$PWD"
npm run init -- /path/to/my-game --template=game --sdk-root "$PWD"
```

App 模板适合 screens、forms 和 product UI；Game 模板是基于官方 `onFrame` 的星空点击小游戏：追逐漂浮星核、命中粒子反馈和 30 秒计分挑战。模板只提供 JS 起点，两个项目仍共用同一套 pinned `buildGuest`、QuickJS bytecode/PAK 和 Flutter 薄宿主。AI 开发官方 net.http 网络功能时应自动补齐业务 Worker 配置；Dio 则由原生插件自动使用独立 IO Worker isolate，保留 dio.request 接口；游戏寻路、AI 和地图生成等重计算同样走业务 Worker，UI 与动画保留原 JS 帧模型。宿主按 descriptor 自动启动业务 Worker，网络仍需明确 origin 授权；渲染 Worker 默认关闭。完整的生成文件、Studio 选择、能力边界和验收命令见 [`docs/PROJECT_TEMPLATES.md`](docs/PROJECT_TEMPLATES.md)。

硬件是可选 `--hardware`；系统栏/触觉是可选 `--platform-experience`。
硬件还可按相机、蓝牙、传感器、定位、生物识别和天气独立选择；系统权限复用 Flutter `permission_handler`，见 [`docs/HARDWARE_MODULES.md`](docs/HARDWARE_MODULES.md)。
Deep Link 默认关闭，只有显式 `init ... --deep-link-scheme=pocketapp` 才加入包依赖与原生 scheme。
已注册插件的 TS 客户端类型生成仍属于 SDK 发布者脚本；产品开发的构建、Preview 和 Studio 入口统一使用 npm。
HTTP Dio 是独立可选包 `pocket_dio`，可通过 `init ... --dio` 加入；请求和响应解码自动在独立 IO Worker 执行，需配置可信 origin 白名单，见 [Dio Worker](docs/DIO_WORKER.md)。完整清单与接入见 [`docs/OPTIONAL_PLUGINS.md`](docs/OPTIONAL_PLUGINS.md)。

生成的 Flutter 工程使用 `PocketApp`；已有 Flutter 工程可嵌入 `PocketGuest`。JS 页面从 `@pocket/ui` 导入。运行期加载真实 QuickJS 字节码和 PAK，签名更新在激活前校验，原生插件随宿主编译，不由 JS 下载。

TFTC 设备控制与实时反馈使用独立 JS 包 [`@pocket/tftc`](packages/pocket_tftc/README.md)，包含 Preview 连接、Windows/macOS 传输、notify 字段变更订阅和真机验收说明。

常用文档：

- [`docs/SDK_INTEGRATION.md`](docs/SDK_INTEGRATION.md)：公共 API、脚手架、更新、插件和 iOS/Android 配置。
- [`docs/OVERVIEW.md`](docs/OVERVIEW.md)：SDK 目录地图和运行链。
- [`docs/FRAMEWORK_GUIDE.md`](docs/FRAMEWORK_GUIDE.md)：代码职责、能力边界和来源对照。
- [`docs/VALIDATION.md`](docs/VALIDATION.md)：已执行验证与平台限制。
- [`docs/MULTI_APP_IMPLEMENTATION.md`](docs/MULTI_APP_IMPLEMENTATION.md)：JS SystemUI、多应用公共能力与薄宿主职责。
- [`docs/RECORDING_REPLAY.md`](docs/RECORDING_REPLAY.md)：可选会话录制、离线回放、导出/导入及限制。
- [`docs/WORKER_RECORDING_REPLAY_PLAN.md`](docs/WORKER_RECORDING_REPLAY_PLAN.md)：Worker 调度、IO facts、channel 与 offload 确定性录制回放的实现及验收范围。
- [`docs/POCKETJS_FEATURE_PARITY.md`](docs/POCKETJS_FEATURE_PARITY.md)：已接入的能力和仍待补齐的上游特性。
- [`docs/GAME_INPUT_IMPLEMENTATION.md`](docs/GAME_INPUT_IMPLEMENTATION.md)：按需开启游戏键盘、外接按钮与双摇杆；Flutter/Web 的接法和验收边界。
- [`docs/WEB_WORKER_IMPLEMENTATION.md`](docs/WEB_WORKER_IMPLEMENTATION.md)：独立 Web Worker QJBC、HTTP origin 策略与浏览器验收。
- [`docs/WEB_RENDER_WORKER.md`](docs/WEB_RENDER_WORKER.md)：Web UI 引擎和绘制默认留在主线程，可按需移入 Worker；含输入/IME 边界、打包、诊断与消融验证。
- [`docs/LARGE_IMAGE_IMPLEMENTATION.md`](docs/LARGE_IMAGE_IMPLEMENTATION.md)：母版和运行时纹理、现有大图预处理与构建限制。
- [`docs/VISUAL_NOVEL_FONT_RENDERING.md`](docs/VISUAL_NOVEL_FONT_RENDERING.md)：字体源、PAK 排版度量与 Flutter/IME 实际绘制的对应关系。
- [`docs/EDITOR_STUDIO.md`](docs/EDITOR_STUDIO.md)：Studio 创建项目、模板选择和 Preview 工作流。

SDK 本身没有 Showcase app，构建时必须指定项目。SDK 0.1.1 的完整构建源码、`@pocket/ui`、编译器、字节码工具和 Preview probe 通过平台 npm 包提供，日常开发只需要 Node.js/npm；详见 [`docs/NPM_TOOLCHAIN.md`](docs/NPM_TOOLCHAIN.md)：

```sh
# 仓库根目录；只需 Node.js 22.22.2+（建议 Node.js 24 LTS） 和 npm
npm run setup
npm run build:guest -- --project-root=../demo/js --outdir=.pocket-build/npm-guest
```

`setup` 会安装 npm 管理的 Bun 和当前系统的预编译工具包，校验 QuickJS ABI 与文件哈希；不会调用 Rust、Python、`patch`、C/C++ 编译器，也不会把 macOS 二进制用于其他系统。`build:guest` 生成真实 `app.qjbc`、`app.pak` 和字节码元数据，不要求 Flutter。Flutter 消费者仍可使用 `npm --prefix sdk run build -- /absolute/path/to/my-app`。

当前本地平台包为 `sdk/.pocket-build/pocket-tools-darwin-arm64-0.1.1.tgz`。预编译包尚未发布到 npm registry；Windows/Linux 包由发布 CI 生成。缺少平台包或 ABI/哈希不匹配时命令会明确失败，不会回退到本机源码编译。SDK 发布者才需要 `npm run setup:source`、`npm run build:probe:source` 和 `npm run package:tools`，这些命令需要完整 Rust/Python/C 工具链。

本轮在屏蔽 Rust、Python、patch、C/C++ 和全局 Bun 的环境中完成了 npm setup、App/Game QJBC/PAK 与 Native Preview 验收；macOS arm64 平台包通过，Windows/Linux CI 和 npm registry 发布尚未完成。默认 Inter 字体暂缺中文字形，Guest Web 截图中的中文可能显示为方框，Studio DOM 中文正常。Flutter 真机/模拟器仍需消费者自己的 Flutter 与平台 SDK，本轮未进行手机实跑。

最终本地导出包为 `sdk/.pocket-build/pocket-web-sdk-tools-0.1.1.tgz`。Noble 使用 macOS arm64 预编译 N-API，`npm install --ignore-scripts` 不编译 native 模块；本轮扫描发现了 BLE 设备，但未重新连接 DK-META2。Linux 当前明确为 `unsupported`，没有生成、发布或验收 Linux HCI 预编译包或新 loader，不会要求用户安装 Rust 或其他工具链。0.1.0 日志仅作为历史验收证据。

在仓库根首次执行 `npm run setup`，然后 `npm start` 启动或重启中文 Studio，固定使用 `http://127.0.0.1:8791`；`npm run status` 查看状态，`npm stop` 停止。启动器在 Windows/macOS/Linux 共用 Node.js 实现，详见 [`docs/EDITOR_STUDIO.md`](docs/EDITOR_STUDIO.md)。
