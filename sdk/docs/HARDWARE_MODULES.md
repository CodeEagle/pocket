# 独立硬件包与系统权限

系统权限直接复用 Flutter `permission_handler`。Pocket 仅负责将其真实结果传给 JS，以及执行可信宿主/guest manifest 的能力准入；不缓存授权状态、不维护另一套授权队列、不在硬件读取时自动申请权限。

| 可选包 | Dart 插件 | 能力 |
| --- | --- | --- |
| `pocket_permissions` | `PocketPermissionsPlugin` | `permissions.status/request/openSettings` |
| `pocket_camera` | `PocketCameraPlugin` | 相机预览、纹理、镜头、闪光灯、拍照、私有照片列表/删除、保存到系统相册 |
| `pocket_bluetooth` | `PocketBluetoothPlugin` | 扫描、连接、GATT 读写、通知流 |
| `pocket_sensors` | `PocketSensorsPlugin` | 一次性传感器读数、连续采样流 |
| `pocket_location` | `PocketLocationPlugin` | 获取真实定位 |
| `pocket_biometrics` | `PocketBiometricsPlugin` | 系统生物识别认证 |
| `pocket_weather` | `PocketWeatherPlugin` | 保留的 Open-Meteo 天气请求；单独使用时显式传入经纬度 |

相机与照片仍在一个包，保留已有拍摄→私有文件→可选保存到系统相册的资源生命周期，避免为同一条管线引入跨插件协调。生物识别是一次认证操作，不是系统权限弹窗；网络也不是运行时权限。

`pocket_hardware_core` 提供共享契约、schema、请求校验和传输，不包含原生硬件插件，也不依赖权限插件。原生包分别拥有自己的 Kotlin/Swift 实现、channel 和平台声明。选择一个原生包不会依赖其余原生包。

旧 `pocket_hardware` 为兼容聚合包，依赖上述各包并保留 `HardwarePlugin`、`hardware.permissions`、`hardware.permissions.request`。旧权限方法转到同一套 `PocketSystemPermissions`，不再调用自建原生权限实现。新消费者应直接选择所需包。

## 脚手架按需选择

```sh
bun sdk/pocket.ts init /path/to/app --camera --bluetooth
bun sdk/pocket.ts init /path/to/motion --sensors
bun sdk/pocket.ts init /path/to/motion-ios --sensors --permissions=hardware.sensors
bun sdk/pocket.ts init /path/to/weather --weather
```

可组合 `--camera`、`--bluetooth`、`--sensors`、`--location`、`--biometrics`、`--weather`。默认不选择任何硬件包；旧 `--hardware` 保留全量兼容行为。`--permissions=<逗号分隔的 hardware policy keys>` 可以独立使用，也可以补充所选模块的权限入口。相机、蓝牙、定位自动注册匹配 allowlist 的权限插件；传感器只有显式选择权限时才引入它，供 iOS motion 授权使用。生物识别和天气不会自动引入权限插件。

生成的 Flutter 依赖、factory、guest manifest、Android declarations、iOS usage descriptions 与编译宏随所选模块变化；重建会保留消费者自定义文件。

## Flutter 嵌入

在消费者 `pubspec.yaml` 只添加需要的包。例如仅相机和权限：

```yaml
dependencies:
  pocket_camera:
    path: /path/to/pocket/sdk/packages/pocket_camera
  pocket_permissions:
    path: /path/to/pocket/sdk/packages/pocket_permissions
```

```dart
import 'package:pocket_camera/pocket_camera.dart';
import 'package:pocket_permissions/pocket_permissions.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

final config = PocketAppConfig(
  appId: 'dev.example.camera',
  allowedPermissions: {HardwarePermissions.camera, HardwarePermissions.photos},
  pluginFactories: [
    (_) => PocketPermissionsPlugin(allowedPermissions: {
      HardwarePermissions.camera, HardwarePermissions.photos,
    }),
    (controller) => PocketCameraPlugin(
      onTextureRegistered: controller.authorizePlatformTexture,
      onTextureReleased: controller.revokePlatformTexture,
    ),
  ],
);
```

guest manifest 必须声明实际使用的能力与对应 policy key。例如：

```json
{
  "protocolVersion": 1,
  "capabilities": {"requires": [], "optional": [
    "permissions.status", "permissions.request", "permissions.openSettings",
    "hardware.camera.preview.start", "hardware.camera.preview.stop"
  ]},
  "permissions": {"optional": ["hardware.camera"]}
}
```

```ts
import { createPocketPermissionsClient } from '@pocket/ui/permissions';

const permissions = createPocketPermissionsClient(host);
// 用户操作触发；状态来自 permission_handler，不是本地授权副本。
const result = await permissions.request('hardware.camera');
if (result.granted) {
  await host.request('hardware.camera.preview.start', { lens: 'back' });
}
```

`limited` 单独返回，`granted` 只表示完整授权。拒绝请求正常返回 `ok: true, granted: false` 与系统状态；能力未声明、宿主未允许等准入错误通过 bridge 拒绝。是否展示说明、再次申请或打开设置由 JS 决定。

Android 12+ 蓝牙使用 scan/connect 权限；较早 Android 的扫描按需使用定位权限。依赖固定为 `permission_handler 12.0.1`、`device_info_plus 11.5.0`，与当前 Flutter 3.35 / Android 工具链保持兼容。`device_info_plus` 只提供 SDK 版本事实，由 `permission_handler` 执行请求。Android 私有照片与普通运动传感器不需要系统授权弹窗；iOS 照片保存使用 add-only 权限。平台权限声明、iOS usage descriptions 和 permission_handler 编译宏仍需与所选能力一致。

## 来源与消融

实施前检查 retained parent（排除 `pocket_host/`）：

- `pocketjs_flutter_demo/mini_apps/pocket_plugins.json` 声明了 `permission_handler`，但 parent `pubspec.yaml` 未实际引入它。
- `lib/core/real_hardware_bridge.dart` 的旧方法名、参数与场景用于兼容对照。其授权失败后假成功等 fallback 未迁移。
- `ios/Runner/AppDelegate.swift` 是原有相机、BLE、传感器、定位、生物识别实现的来源。

本次从当前 SDK 的 `pocket_hardware` 实际实现提取 Kotlin/Swift，保留原有纹理授权回收、BLE GATT 队列、传感器 owner token/operation generation、采样频率和 session cleanup 修复。共享 Dart 适配移到 `pocket_hardware_core/lib/src/hardware_plugin.dart`，不复制第二份实现。

消除的冗余包括原生统一 `checkPermissions/requestPermission`、原生授权 pending 状态、授权回调分发与通过传感器读取探测权限的路径。硬件操作前真实的授权检查、设备可用性检查及资源取消仍然保留。

## 验证边界

权限包测试使用 `permission_handler` 的实际 platform interface；测试 denied、limited、永久拒绝、Android 蓝牙版本差异与 manifest/host 准入。JS 测试使用已有 HostBridge，并用 pinned buildGuest 与真实 QuickJS/native probe 验证指针点击后请求和拒绝结果的绘制帧变化。

核心和兼容聚合包保留流、配额、传感器超时、跨 session 身份隔离回归；新增选择性注册与独立 channel 路由测试。本次验证记录：

- 权限包 7、共享层 4、兼容聚合包 11、Demo 硬件契约 16 项 Dart 测试通过；六个独立能力包静态分析通过。
- JS 权限客户端与真实 QuickJS/native 指针交互测试 2 项通过（49 assertions）；严格 TypeScript 检查通过。
- 脚手架、Dio 与 Android 配置回归 10 项通过，平台声明和编译宏重复应用不变。
- Android 五包与 Demo Kotlin 编译通过；BLE 1、传感器 2 项原生测试通过。
- iOS 五个独立 pod 的 Simulator Release 编译通过；传感器 2 项原生测试通过。当前本机 Xcode 不接受 lint 中 Flutter pod 的旧 deployment target 11；手动指定项目使用的 `IPHONEOS_DEPLOYMENT_TARGET=15.0` 验证通过。

以上不等同于真实设备相机、BLE 或授权弹窗联调。
