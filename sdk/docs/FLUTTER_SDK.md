# Pocket SDK

Flutter 项目接入入口。应用页面、组件组合、主题、路由与状态写在 JS；SDK 负责字节码加载、绘制/输入、平台几何、签名更新、插件准入与运行生命周期。

```dart
import 'package:flutter/material.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

void main() => runApp(const PocketApp(
  config: PocketAppConfig(appId: 'com.example.myapp'),
));
```

`pubspec.yaml` 声明 `pocket_sdk` 路径依赖及四个编译产物：`assets/app.qjbc`、`assets/app.pak`、`assets/app.bytecode.json`、`assets/guest-manifest.json`。使用 SDK 根目录的 `pocket.ts init` 生成独立工程，`build` 编译真实 QuickJS 字节码。完整步骤见 [接入文档](SDK_INTEGRATION.md)。

已有 Flutter App 使用 `PocketGuest(config: ...)` 嵌入当前 `MaterialApp`。它按父容器尺寸绘制，窗口变化保留 guest；不要把 JS 页面另写成 Flutter 页面。`PocketApp` 是独立启动壳，`PocketGuest` 是同一实现的嵌入入口，没有第二套生命周期。

可选配置：

- `updates: PocketUpdateConfig(...)` 接入签名发布源；`PocketUpdateConfig.fromEnvironment()` 读取开发环境的四个 `POCKET_*` 配置。客户端只接收公钥。
- `showFps: true` 显示实时指标；有界历史按 `appId` 隔离保存。
- `enableHardware: true` 注册已编译的硬件能力，再用 `allowedPermissions` 明确宿主策略；JS manifest 只能进一步收窄权限，系统授权仅在用户操作后请求。
- `pluginFactories` 注入应用插件。工厂接收 `PocketViewController`，每次经过验证的 guest 切换创建新实例，SDK 负责准入、激活、撤销与销毁。
- 四个 asset 字段可按项目调整，运行时仍只接受匹配 ABI 的字节码。

直接管理运行期时使用 `PocketSession(config: ...)`；`close()` 可等待插件退出与历史落盘。普通 App 不需要手写 session、bridge 或更新切换逻辑。

该版本是可本地集成的源码 SDK，尚未向 npm/pub.dev 发布。iOS 最低部署 15.0，
Android renderer 最低 API 24，当前 Android native archive 仅提供 `arm64-v8a`；Duo 原生几何桥需 Xcode / SDK 27.1+ 编译，在旧
iOS 运行时返回空保留区域。Android 硬件 provider 与 iOS 共用 capability/MethodChannel
协议，但真实 Android 硬件仍需实体设备验收。原生插件更新需要重新编译宿主，不随
JS 热更下载。
