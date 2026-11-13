# Flutter 3.50 与 nativeapi 接入评估

记录日期：2026-11-13。分支：`research/flutter-3.50-nativeapi`。
评估基线：`2fb3ece74bf8c0bc0e2d3a5bd447257e2c500d44`，含当前工作区源码。

## 决策与当前状态

Flutter 3.50 值得做独立版本对照；nativeapi 值得作为可选的系统服务后端研究，优先桌面能力。两者均未接入：本次只创建分支、检查官方资料与发布源码、记录后续工作，不修改 `.fvmrc`、依赖、构建配置或运行时。

当前 `.fvmrc` 固定 Flutter 3.47.9；`sdk/pubspec.yaml` 的公开最低约束仍为 Flutter 3.35 / Dart 3.9.2。不能为了可选 nativeapi provider 未经评估提高所有 SDK 消费者的最低版本。

原有未提交的 Editor 修改和根目录审查文件保留，不属于本次变更。

## 来源与复用边界

按 source-first 要求检查保留父工程，排除 `pocket_host/`：

- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/real_hardware_bridge.dart`：保留真实权限、硬件和原生回调的来源；不迁回历史模拟成功行为。该文件未提供可直接复用的桌面托盘、全局快捷键或文件对话框 provider。
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/ffi_bridge.dart`、`lib/render/pocket_ui_components.dart`：既有 FFI 与绘制来源仍保留；本次不替换布局、引擎或渲染主路径。

当前可复用入口：

- `sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart`：PocketJS 通过已有 C FFI/固定 ABI 执行。
- `sdk/packages/pocket_flutter/lib/src/pocket_view.dart`：`CustomPainter`/Texture 表面、输入队列、Ticker、资源解码和 IME。
- `sdk/packages/pocket_services/lib/src/pocket_plugin.dart`：现有 capability schema、注册/授权、预算和 dispose；新后端应复用该入口。
- `sdk/packages/pocket_ui/src/platform.ts`、`platform-experience.ts`：JS 请求与业务编排入口；不另建 RPC 或 Dart 业务状态机。
- `sdk/packages/pocket_platform/lib/src/platform_plugin.dart`：深链、系统 UI、触觉的现有实现；保留官方 Flutter service 可直接完成的能力。
- `sdk/packages/pocket_hardware_core/lib/src/hardware_plugin.dart` 和各硬件包：保留相机、蓝牙、定位、传感器等专用边界。
- `sdk/docs/IOS_SWIFT_PACKAGE_MANAGER.md`：已有七个可复用 iOS 插件的 SwiftPM 迁移与验证记录；本次不重复迁移。
- `sdk/docs/UPSTREAM_CAPABILITY_AUDIT_2026-11-07.md`：既有系统服务、输入和 clipboard provider 缺口参考；本次源码检索未发现当前 JS/Dart SDK 已有通用剪贴板 provider，仍需逐个 target 追踪官方协议后再实现。

## Flutter 3.50 的项目价值

官方于 2026-11-11 发布 3.50，配套 Dart 3.14。收益判断与性能实测分开。

| 更新 | Pocket 相关性 | 边界与必要验证 |
| --- | --- | --- |
| iOS 触摸与帧生成调度提前 | 高；Pocket 消费 Flutter PointerEvent | 官方报告减少一帧输入延迟。Pocket 还经过 duplex/消息队列、Ticker 与 JS，端到端收益未测；检查活动动画和从空闲唤醒两种路径 |
| Impeller 绘制优化、纹理/GPU 修复 | 高；现有画布与 Texture 使用 Flutter 后端 | 按实际平台/后端测试，不把桌面 SDF 改善推广为全平台提速，不声称减少 JS 布局/解码成本 |
| Objective-C FFIgen / Java、Kotlin JNIgen 稳定 | 中；可用于新原生能力或实测热点 | 现有 PocketJS 已走 C FFI；升级不自动重写 MethodChannel，也不消除 JS 与宿主传输 |
| Material/Cupertino 从 SDK 库迁出、旧入口弃用 | 有维护影响 | 当前 PocketView、系统宿主和监控等仍引用 material.dart；先减少不必要依赖，需要的设计组件再评估独立包，弃用不等于当期移除 |
| Android release Intent 校验收紧 | 有兼容影响 | 验证深链、入口、诊断/预构建二进制启动脚本；不能依赖 release Intent 注入引擎参数 |
| HCPP | 主画布收益低 | 当前 PocketView 不创建 AndroidView/UiKitView；不能用 Platform View 跑分推定本项目提速 |
| Flutter GPU 2D 纹理数组 | 需另行改造 | 当前 Canvas/Texture 主路径不会自动获得自定义 GPU 批处理；不为使用新 API 增设第二套渲染器 |
| Flutter Web Wasm / 浏览器文本布局 | 与当前 native FFI 主路径不同 | 独立 Web SDK 和 Editor preview 必须分别验证，不能沿用 Flutter Web 官方跑分 |

Android 基线是 AGP 8.11.1、Kotlin 2.2.20、Gradle 8.14；app 的 Java/Kotlin 编译目标为 11，这不等同于运行 Gradle 的 JDK 版本。本轮未核验实际 JDK。Flutter 版本实验与 AGP 9 / Built-in Kotlin 迁移分别推进，官方新工程默认值不应直接覆盖现有工程。

## nativeapi 0.6.0 的发布源码核查

使用 pub.dev JSON API 获取三个 0.6.0 归档，下载后逐一校验 SHA-256。检查缓存位于被 Git 忽略的 `.cache/flutter-350-nativeapi-research/`，不将第三方源码或二进制作为本项目源码提交。

| 包 | 约束与职责 | 发布归档 SHA-256 |
| --- | --- | --- |
| nativeapi 0.6.0 | Dart `^3.14.0`；面向 Dart 的系统 API | `c71a5e10aacd177fe1c3eef279179beeba6fd08132f0d36e0a7e081e13906749` |
| cnativeapi 0.6.0 | Dart `^3.14.0`；C ABI/FFI 与本机构建 hook | `bcf1d65504a397cd1b1eeaea582baf08250f38d46074739fddb3c5437f1b9e06` |
| nativeapi_flutter 0.6.0 | Flutter `>=3.50.0` / Dart `^3.14.0`；widgets、类型转换和可选窗口桥接 | `3709b58224473298349375c8a0404d19dc0b5f151397cae2f127fe49a3a1a491` |

发布 API：`https://pub.dev/api/packages/{nativeapi,cnativeapi,nativeapi_flutter}`。三个包均发布于 2026-11-12 UTC。以归档版本和哈希为准，不把仓库 main 或包页面抓取时间作为版本证据。

下列源码路径均相对对应包的 **0.6.0 归档**：

| 证据路径 | 核查结果 | 对 Pocket 的影响 |
| --- | --- | --- |
| nativeapi: `lib/src/clipboard.dart` | 暴露 text、HTML、image、filePaths | 值得研究富剪贴板；类型存在不证明每个平台全部可用 |
| cnativeapi: `cxx_impl/src/platform/android/android_runtime.h`、`.cpp` | 初始化入口为 `Initialize(ANativeActivity*)`；需要 UI 线程、Looper，并接管/转发 focus、destroy 回调 | 普通 FlutterActivity 不会自动提供该接入；移动端需明确适配后才能宣称支持 |
| cnativeapi: `cxx_impl/src/platform/android/clipboard_android.cpp` | 有真实 JNI 剪贴板访问、焦点/监测相关实现 | 不是空 API，但依赖上述初始化与 OS 授权限制，不能直接作为 Flutter Android 可用性证明 |
| cnativeapi: `cxx_impl/src/platform/{android/file_dialog_android.cpp,ios/file_dialog_ios.mm}` | `IsSupported()` 返回 false；Open 失败 | 不能用它补齐当前 Android/iOS 文件选择器 |
| cnativeapi: `cxx_impl/src/platform/{macos/file_dialog_macos.mm,linux/file_dialog_linux.cpp,windows/file_dialog_windows.cpp}` | macOS 的 IsSupported 也返回 false；Linux/Windows 返回 true 且有实现 | 文件对话框也不能按“桌面支持”整体承诺，先限 Linux/Windows 候选 |
| cnativeapi: `cxx_impl/src/platform/{android/notification_manager_android.cpp,ios/notification_manager_ios.mm}` | IsSupported/Initialize/Show 返回 false | 不能用它宣称补齐移动系统通知 |
| cnativeapi: `cxx_impl/src/platform/{android/secure_storage_android.cpp,ios/secure_storage_ios.mm}` | stub；写入返回 false，读取返回默认值，IsAvailable false | 不能用作移动端安全存储，也不能将默认读取当作成功 |
| cnativeapi: `cxx_impl/src/platform/{macos/secure_storage_macos.mm,macos/notification_manager_macos.mm}` | macOS 安全存储也是 stub；通知 IsSupported 返回 false | 本版本不能用来补齐 macOS 安全存储或系统通知 |
| cnativeapi: `cxx_impl/src/platform/{android/shortcut_manager_android.cpp,ios/shortcut_manager_ios.mm}` | IsSupported/RegisterShortcut 返回 false | 全局快捷键作为桌面候选，不能承诺移动端 |
| nativeapi_flutter: `lib/windowing.dart`、`lib/src/windowing/flutter_window.dart` | 桥接 Flutter 内部 `_window*.dart` 与原生窗口句柄 | 多窗口实验不进入公共 SDK 必需路径；上游说明“checked with 3.50.0”不等于稳定 API 保证 |
| nativeapi: `lib/nativeapi.dart`、`lib/src/web/*` | Web 条件导出避免依赖 dart:ffi；平台操作不提供真实服务 | 可以编译不代表浏览器支持本地系统能力 |
| cnativeapi: `hook/build.dart` | 构建 vendored C++17 源码和 event-loop shim；Android 使用静态 C++ runtime，Linux 需 GTK3/X11/Xi；Windows hook 排除 WinUI3 后端 | 引入额外本机构建、体积、签名与平台依赖成本；应测 clean build 与增量构建，不只测 Dart API |

注意：包仍标注 WIP；0.6.0 changelog 记录多项 callback、关闭/退出、hot restart 与 release AOT 修复。独立 `standalone.dart` runner 尚不支持 Dart 3.14，应避免导入；普通 nativeapi 导入已经与其分离。以上是风险和验收依据，不是声称普通 Flutter 使用一定失败。

HarmonyOS 的上游变更记录不能证明当前 Dart 发布包可直接使用：0.6.0 build hook 仅列 Android/iOS/Linux/macOS/Windows。原生 HarmonyOS 移植与 Android APK 在卓易通运行必须分开验证，不宣称支持。

## 能完善哪些底层能力

| 优先级 | 候选 | 建议 |
| --- | --- | --- |
| P1 | 桌面富剪贴板与变更事件 | 作为首个可选 provider 实验；纯文本先与 Flutter Clipboard 对照，只有富格式/监测等明确增量才引入该依赖 |
| P1 | 桌面窗口属性、显示器查询/事件 | 可研究尺寸、置顶、屏幕信息与窗口状态；已有 Flutter 显示信息够用的部分保留，native 坐标转换只留一个来源 |
| P2 | 桌面托盘、原生菜单、全局快捷键；Linux/Windows 文件对话框 | 针对产品需求逐项接入；macOS 文件对话框发布源码仍不支持。JS 定义菜单数据、快捷键业务动作，宿主只注册 OS 资源与转发事件 |
| P2 | 窗口遮挡事实与省电 | 可转发原生遮挡状态给既有生命周期/调度；unknown 不等于隐藏，不另建 Dart 调度状态机 |
| 暂缓 | 多窗口与独立原生控件树 | 内部实验 API 和额外视图/布局会增加维护面；不替换现有 JS UI 或 Pocket 引擎 |
| 不替换 | 相机、蓝牙、定位、传感器、音视频、JS Worker、包存储/OTA | 本轮未见 nativeapi 能完整替代的证据；保留已有实现 |

接入形态应为：现有 JS SDK → 现有 capability RPC/准入 → 最小 Dart provider → nativeapi → OS。依赖只放进需要它的可选包，不加入所有消费者必经的 pocket_sdk 核心。只有确需 Flutter 类型转换时考虑 nativeapi_flutter；首轮系统服务实验优先 nativeapi，避免连带导入多窗口桥接。

能力按平台和实际初始化结果注册，unsupported/denied/error 如实返回。宿主对象、回调、监听和句柄必须随 session dispose 清理。系统文件路径不能直接绕过现有 guest 隔离；菜单点击、快捷键和关闭请求回到 JS，由 JS 决定业务动作。

不先写全模块通用封装，不新增第二个 capability registry、消息总线、存储缓存或窗口业务状态机。若替换某条原生实现，应在验证后删除被替代路径，避免两套监听和状态并存。

## 分阶段验证与消融计划

1. **A：当前 Flutter 3.47.9。** 固定 PocketJS revision/ABI、guest bytecode、资源、设备、profile/release 模式，保存基线。
2. **B：仅 Flutter 3.50。** 不加 nativeapi、不混入 AGP9 迁移；测试点击/拖拽到画面变化、空闲唤醒、中文 IME、视频/Live2D、后台恢复；比较端到端延迟、build/raster/native/decode P95 与空闲耗电指标。FrameTiming 本身不等于 input-to-photon，需端到端采样手段。
3. **C：在 B 上仅加一个 nativeapi provider。** macOS 首试富剪贴板/监听；实测 HTML/图像等声明格式、双向跨应用、取消/拒绝、焦点、真实 JS 事件驱动帧变化和退出清理。若先试纯文本，须与 Flutter Clipboard 对照，避免新增冗余依赖。
4. **消融。** 关闭新增 provider 或恢复旧后端，确认新增能力/性能差异确实消失；测安装体积、干净构建和 hot restart，不把调用返回成功或静态检查当作交互验收。
5. **扩展平台。** 桌面分别验证 Windows/macOS/Linux；Linux 区分 X11/Wayland。Android/iOS 先补实际初始化与支持矩阵，未通过能力保持不可用。最终再决定是否更新 `.fvmrc` 和公开包约束。

复用已有回归场景：`sdk/packages/pocket_flutter/test/pocket_view_input_test.dart`、`pocket_view_pointer_wake_test.dart`、`pocket_view_pointer_order_ffi_test.dart`、`pocket_duplex_pointer_ffi_test.dart`、`pocket_frame_binary_ffi_test.dart`，以及 `demo/integration_test/input_regression_test.dart`、`video_playback_test.dart`。这些文件只是后续入口，本次未运行，也未将旧验证记录冒充 3.50 的结果。

## 本次验证与审查状态

- 已完成官方发布资料、包约束、三个发布归档校验和关键平台源码检查；未运行 Flutter 3.50 构建、真实系统能力或性能实验。
- 已按仓库要求尝试 Argon Low 委派；返回 `RESOURCE_EXHAUSTED`（个人配额耗尽）。没有替换模型，源码调查和本文由主代理完成。
- 文档与路径/版本检查完成后，已申请一次 Argon Medium 汇总审查；同样返回 `RESOURCE_EXHAUSTED`，未取得独立审查结果。未替换模型。此记录不是接入验收。
- 主代理追加核对了桌面实现：发现 macOS 文件对话框、通知和安全存储也有 stub，已修正上表，避免将“桌面优先”误解成全量桌面支持。

## 官方资料

- [Flutter 3.50 公告](https://flutter.dev/blog/whats-new-in-flutter-3-50)
- [Flutter 3.50 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.50.0)
- [Flutter native interop](https://docs.flutter.dev/interop)
- [Material/Cupertino 迁移](https://docs.flutter.dev/release/breaking-changes/material-ui-and-cupertino-ui)
- [Android Built-in Kotlin 迁移条件](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers)
- [nativeapi 包](https://pub.dev/packages/nativeapi/versions/0.6.0)、[changelog](https://pub.dev/packages/nativeapi/changelog)
- [cnativeapi 包](https://pub.dev/packages/cnativeapi/versions/0.6.0)、[nativeapi_flutter 包](https://pub.dev/packages/nativeapi_flutter/versions/0.6.0)
- [nativeapi 仓库](https://github.com/libnativeapi/nativeapi)、[nativeapi-core 仓库](https://github.com/libnativeapi/nativeapi-core)
