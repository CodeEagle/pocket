# Pocket SDK

这里是可集成的 SDK 唯一入口。它包含公共 Flutter 包、JS UI 库、QuickJS/PocketJS runtime、字节码编译链、硬件和服务包、Editor 以及 CLI。Showcase 不在 SDK 内，位于同级 `../demo`。

公共 Flutter 包就是当前目录的 `pubspec.yaml` 和 `lib/pocket_sdk.dart`，包名为 `pocket_sdk`。底层实现放在 `packages/`，唯一 CLI 是 [`pocket.ts`](pocket.ts)。

创建一个独立消费者项目：

```sh
cd /Volumes/ORICO/Development/Github/pocket/sdk
bun pocket.ts init /path/to/my-app --sdk-root "$PWD"
bun pocket.ts build /path/to/my-app --sdk-root "$PWD" --platform=ios-sim
```

硬件是可选 `--hardware`；系统栏/触觉是可选 `--platform-experience`。
Deep Link 默认关闭，只有显式 `init ... --deep-link-scheme=pocketapp` 才加入包依赖与原生 scheme。
已注册插件的 TS 客户端可用 `bun pocket.ts types plugins.json --out=plugin-types.ts` 生成。

生成的 Flutter 工程使用 `PocketApp`；已有 Flutter 工程可嵌入 `PocketGuest`。JS 页面从 `@pocket/ui` 导入。运行期加载真实 QuickJS 字节码和 PAK，签名更新在激活前校验，原生插件随宿主编译，不由 JS 下载。

常用文档：

- [`docs/SDK_INTEGRATION.md`](docs/SDK_INTEGRATION.md)：公共 API、脚手架、更新、插件和 iOS/Android 配置。
- [`docs/OVERVIEW.md`](docs/OVERVIEW.md)：SDK 目录地图和运行链。
- [`docs/FRAMEWORK_GUIDE.md`](docs/FRAMEWORK_GUIDE.md)：代码职责、能力边界和来源对照。
- [`docs/VALIDATION.md`](docs/VALIDATION.md)：已执行验证与平台限制。
- [`docs/MULTI_APP_IMPLEMENTATION.md`](docs/MULTI_APP_IMPLEMENTATION.md)：JS SystemUI、多应用公共能力与薄宿主职责。
- [`docs/RECORDING_REPLAY.md`](docs/RECORDING_REPLAY.md)：可选会话录制、离线回放、导出/导入及限制。
- [`docs/WORKER_RECORDING_REPLAY_PLAN.md`](docs/WORKER_RECORDING_REPLAY_PLAN.md)：Worker 调度、IO facts、channel 与 offload 确定性录制回放的实现及验收范围。
- [`docs/POCKETJS_FEATURE_PARITY.md`](docs/POCKETJS_FEATURE_PARITY.md)：已接入的能力和仍待补齐的上游特性。

SDK 本身没有 Showcase app，不能在 SDK 根目录直接执行无项目的 `bun run build:guest`。需要构建应用时，请使用 `bun pocket.ts build /path/to/my-app`，或在 Demo 的 [`js/`](../demo/js/) 中执行 JS 构建命令。Editor 服务可用 `bash scripts/editor_service.sh start|status|stop` 管理。
