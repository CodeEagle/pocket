# VS Code 启动 Showcase

在 VS Code 打开仓库根目录，使用「运行和调试」中的 `Pocket Demo (iPhone Duo)`。
Duo 模拟器需已启动；设备按名称匹配，不绑定本机 simulator UUID。
所有入口显式使用 `demo/` 工作目录和 `demo/lib/main.dart`。
首次使用仍按仓库 README 安装 Bun/Flutter 依赖和 Rust targets，并在 `demo/`
执行 `flutter pub get`。

| 入口 | 设备 | 模式 | 启动前准备 |
| --- | --- | --- | --- |
| iPhone Duo | 已启动的 iPhone Duo | debug | iOS native + guest |
| iOS device | VS Code 状态栏选中的 iOS 真机 | debug / profile / release | iOS native + guest |
| macOS | Apple Silicon Mac（macos） | debug / profile / release | macOS native + guest |
| Android arm64 | VS Code 状态栏选中的 arm64 Android | debug | Android native + guest |

iOS 模拟器使用 debug；profile/release 入口用于真机或 macOS。
Android 原生构建仍需已有 SDK/NDK 环境，当前库只提供 arm64-v8a。

`.vscode/tasks.json` 按顺序执行：

1. 既有 `sdk/scripts/build_native.sh` 准备对应平台库。iOS 一次生成 device 和
   simulator 两个 slice；Cargo 复用未变化的编译产物。
2. 在 `demo/js/` 执行既有 `bun run build:system`，以同一 pinned `buildGuest`
   流程更新 SystemUI、profile、lobby 的 qjbc/PAK/metadata。
3. 准备任务成功后，由 Dart-Code 正常启动 Flutter 并连接调试器。

任何准备步骤失败都会阻止启动。更新 Rust、SDK TSX 或 mini-app 后，停止再启动
调试会重新执行准备任务；运行中的 hot reload/hot restart 只处理 Flutter 进程内的
更新，完整准备流程仍由下一次启动执行。

原配置把 SDK 与每个插件包都当成可执行 Flutter App，且没有准备任务。
这些包没有独立应用入口，现已从 launch 列表移除；其测试仍可通过 Dart-Code
测试视图执行。

## 来源与验证

- 检查 retained parent `pocketjs_flutter_demo/.vscode/launch.json`，保留其 Dart
  debugger 和 `flutterMode` 用法；没有读取或修改父工程 `pocket_host/`。
- 复用现有 `build_native.sh`、`demo/js/package.json` 的 `build:system` 和
  `demo/js/scripts/build_mini_apps.ts`，没有新增编译器或构建缓存层。
- 使用本机 Dart-Code 3.146.0 的 launch schema 校验字段；其设备选择实现支持
  `deviceId` 按精确名称匹配。8 个 launch 入口、7 个 task 的引用与路径检查通过。
- 2026-11-05 在实际 VS Code 的「运行和调试」面板启动
  `Pocket Demo (iPhone Duo)`：观察到 native iOS、guest bytecode 任务顺序完成，
  Xcode 构建后调试器进入 Running / Thread 1 is not paused，Duo 首页正常显示；
  在 Device Hub 点击真实 `+1`，JS 计数从 `00` 变为 `01`，动作文本变为
  `Incremented in JS`。本轮未实测 macOS、iOS 真机或 Android 的 VS Code 启动。
