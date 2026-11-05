# PocketJS Flutter SDK 接入

本目录是可本地引用的 SDK 源码树，当前没有发布到 pub.dev 或 npm。SDK 工作根目录为 `/Volumes/ORICO/Development/Github/pocket/sdk`；Showcase 位于同级 `../demo`，不属于 SDK 公共 API。业务页面、组件、主题、路由和状态仍由 JS guest 负责；Flutter SDK 只负责字节码准入、绘制/输入、平台几何、更新签名、插件生命周期和运行期资源。

## 新建一个独立工程

在 SDK 仓库外执行：

```sh
bun /Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts init /path/to/my-pocket-app \
  --sdk-root /Volumes/ORICO/Development/Github/pocket/sdk \
  --app-id com.example.myapp
# 需要硬件 provider 时，把上面的命令追加：--hardware
# 需要系统栏/触觉时追加：--platform-experience（Deep Link 仍关闭）
# 需要自定义 URL scheme 时显式追加：--deep-link-scheme=pocketapp
```

`init` 只复制 SDK 的公共 `packages/pocket_ui` 到工程的
`vendor/pocket-ui`，不会复制 Showcase 的 `../demo` 或使用旧仓库的绝对路径。它生成：

- `app.tsx`、`pocket.json`、`manifest.json`、`editor.json`；
- 可独立编辑的 `vendor/pocket-ui` 和预编译的 `node_modules/@pocket/ui`；
- 独立的 `flutter/`（iOS、Android、macOS）应用；
- `flutter/pubspec.yaml` 的本地 `pocket_sdk` 路径依赖，以及四个运行期 asset；
- iOS 15.0 deployment target 和 Apple Silicon `arm64` 架构设置（Flutter 可用时会同时执行 `flutter pub get`，因此 Podfile 已物化）。

`--hardware` 是显式选择：它添加独立 `pocket_hardware` 依赖、显式 plugin factory、硬件权限/能力的 optional
manifest、iOS usage-description 和 Android `AndroidManifest.xml` 权限声明写入脚手架；
Android 工程的 `minSdk` 同时至少为 API 24（`pocket_flutter` 的 Android renderer
要求）；当前 `build_native.sh android` 只产出 `arm64-v8a`，不宣称 x86/x86_64 或
32-bit ABI。默认 init 不启用硬件 provider，也不会由 CLI 主动 patch 应用 manifest；如果
应用已经依赖 `pocket_hardware`，Flutter plugin 的库 manifest 可能仍合并静态权限
声明，但不会在启动时请求系统授权。

`--platform-experience` 添加独立 `pocket_platform` 包和显式 factory，提供系统栏与触觉；
默认项目不依赖该包。Deep Link 是另一层选择：只有 `--deep-link-scheme=pocketapp`
才生成 URL scheme、iOS SceneDelegate 转发、Android intent filter，以及 optional links
能力。普通 Showcase 也保持关闭。独立 `PocketDeepLinkPlugin` 与原生静态声明必须同时接入，
Guest 不能自行启用或改 scheme。这里只支持自定义 scheme，不宣称 Universal Links。

链接 provider 保留有界的原生 URL 事实，允许 App 从后台恢复时接收链接；系统栏/触觉
provider 则按前后台正常撤销。两者复用同一平台包，业务路由和 App 打开策略仍由 JS 决定。

JS 消费已有 HostBridge，无需另一套消息循环：

```ts
import { createPlatformExperience } from '@pocket/ui/platform-experience';
import { createPocketStreamAdapter } from '@pocket/ui/streams';

const experience = createPlatformExperience(host); // 不自动订阅链接
await experience.haptics.perform({ type: 'selection' });
await experience.systemUi.set({ statusBarIconBrightness: 'light' });
const streams = createPocketStreamAdapter(host, { maxActiveStreams: 4 });
const sensors = streams.open('hardware.sensors.watch', { samplingHz: 10 });
const remove = sensors.onData(sample => { /* 更新 JS 页面状态 */ });
// 离开页面时释放订阅；整个消费者退出时 dispose adapter。
remove();
sensors.cancel('page_left');
streams.dispose();
experience.dispose();
```

流复用现有 `stream.open/data/batch/end/cancel/error` 协议；原生 callback 推送数据，
不由 JS/Dart 定时查询。缓冲、活跃流、待处理读取均有上限。空闲 deadline 使用宿主已有的
Guest 虚拟时钟调度，调用者须像标准 Demo 一样为 HostBridge 提供 `scheduleTimeout`；
仅使用手动 `tick` 的外部桥不会自行唤醒停表 Guest。

类型生成也从真实注册表出发：将 `PocketPluginDescriptor.toJson()` 与
`PocketHost.capabilitiesJson()` 组合成数据导出，再执行：

```sh
bun /path/to/pocket/sdk/pocket.ts types plugins.json --out=plugin-types.ts
```

未注册的 capability 不生成客户端，缺失 schema 的旧能力保持 `unknown`，不猜测类型。
详见 [插件类型契约](PLUGIN_TYPES.md)、[平台体验](PLATFORM_EXPERIENCE.md)、
[JS 持续流](JS_HOST_STREAMS.md) 与 [硬件持续流/GATT](HARDWARE_STREAMS.md)。

生成的 `app.tsx` 直接使用公共适配器，不复制 showcase 的布局逻辑：

```tsx
const [dark, setDark] = createSignal(false);
return (
  <MobileThemeProvider theme={() => dark() ? MOBILE_THEME_DARK : MOBILE_THEME_LIGHT}>
    <SafeAreaScaffold>
      <View class={dark() ? 'flex-col gap-2 p-4 bg-[#0d1726]' : 'flex-col gap-2 p-4 bg-slate-50'}>
        <Text>Hello PocketJS</Text>
        <MobileButton label={dark() ? 'Light' : 'Dark'} onPress={() => setDark(!dark())} />
      </View>
    </SafeAreaScaffold>
  </MobileThemeProvider>
);
```

`SafeAreaScaffold` 订阅宿主的 `display.viewport`，并将 safe area 作为一次性
内容壳边距消费；`availableDisplayPanes` 仍处理 active division。嵌套在
Showcase root 下的页面应使用默认 `MobileScaffold`（`safeArea="none"`），不要
再次包裹安全壳。

独立 mini-app 若由宿主提供右上角关闭动作，应在同一个壳上声明
`reservedActions="mini-app"`。这会统一保留 60 logical px（44 按钮 + 8
右边距 + 8 间隔）；`MobileAppBar` 自动收缩并裁剪标题/副标题，背景仍铺满
viewport，页面不应再手写右侧 margin 或 body padding。

如果初始化环境没有 Flutter，JS 工程仍会生成；稍后在 `flutter/` 运行
`flutter pub get`，再用带 `--platform` 的 `pocket build` 应用 iOS 设置。

## Flutter 公共 API

独立壳只需一个入口：

```dart
import 'package:flutter/material.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

void main() => runApp(const PocketApp(
  config: PocketAppConfig(appId: 'com.example.myapp'),
));
```

`PocketApp` 和 `PocketSystemHost` 默认提供不透明黑色根底，可通过
`backgroundColor: const Color(0xFF000000)` 修改。独立使用 `PocketGuest` 或
`PocketView` 时可显式传同一参数；嵌入式 surface 默认保留透明。
背景只需配置在一个根边界，不必给每个 DrawOps 分块或滚动内容重复填色。
来源、消融验证与 macOS 窗口边界见 [SURFACE_BACKGROUND.md](SURFACE_BACKGROUND.md)。

已有 Flutter App 可将同一 guest 嵌入自己的 `MaterialApp`：

```dart
MaterialApp(
  home: Scaffold(
    body: PocketGuest(
      config: const PocketAppConfig(appId: 'com.example.myapp'),
    ),
  ),
);
```

`PocketApp` 是独立启动壳，`PocketGuest` 是嵌入入口；两者都使用同一个
`PocketSession` 生命周期，不需要在业务 Flutter 页面中另写 JS UI、bridge 或
frame loop。SDK 会从配置的 asset 加载真实 QuickJS Script bytecode、PAK、
bytecode metadata 和 guest manifest；字节码 ABI 不匹配时拒绝启动，不会回退到
解释执行 `app.js`。

常用配置（`PocketAppConfig`）：

| 字段 | 用途 |
| --- | --- |
| `appId` | 应用身份，也是更新存储和性能历史的命名空间。 |
| `bytecodeAsset` / `pakAsset` / `metadataAsset` / `manifestAsset` | 默认分别为 `assets/app.qjbc`、`assets/app.pak`、`assets/app.bytecode.json`、`assets/guest-manifest.json`，可按项目调整。 |
| `updates` | `PocketUpdateConfig` 签名更新源；客户端只放 Ed25519 公钥。 |
| `allowedPermissions` | 宿主允许的权限集合；guest manifest 只能进一步收窄。硬件通过独立包和 pluginFactories 显式注册。 |
| `memoryLimits` | 每个 realm 的 QuickJS 堆硬上限和 PAK 大小准入上限。 |
| `pluginFactories` | `PocketPlugin Function(PocketViewController)` 列表；每次验证通过的 guest generation 都创建新的插件实例。 |
| `additionalCapabilities` | 宿主明确增加的 capability 名称。 |
| `showFps` | 显示 FPS 诊断标签并采集有界性能窗口。 |

JS SystemUI catalog 用 `memory` / `memoryPolicy` 选择额度，Guest 只能在宿主
`PocketMemoryLimits` 批准范围内缩小预算。真实堆限制、旧 Demo 档位和录制回放配置见
[小程序内存限制](APP_MEMORY_LIMITS.md)。

可选硬件由消费工程显式依赖 `pocket_hardware`；核心 `pocket_sdk` 不依赖或导出该插件。
移除原 `enableHardware` 开关，统一使用已有插件工厂，避免两套注册状态：

```dart
import 'package:pocket_hardware/pocket_hardware.dart';

PocketPlugin hardwareProvider(PocketViewController controller) => HardwarePlugin(
  onTextureRegistered: controller.authorizePlatformTexture,
  onTextureReleased: controller.revokePlatformTexture,
);

const config = PocketAppConfig(
  appId: 'com.example.camera',
  pluginFactories: [hardwareProvider],
  allowedPermissions: {HardwarePermissions.camera},
);
```

底层绘制/运行时诊断接口从 `package:pocket_flutter/pocket_flutter.dart` 显式导入；
核心入口只导出应用集成与插件契约，不再全量透传底层内部类型。

直接管理运行期（例如已有路由/生命周期系统）时使用 `PocketSession`：

```dart
final session = PocketSession(
  config: const PocketAppConfig(appId: 'com.example.myapp'),
);
await session.initialize();
// session.controller 可交给 PocketView；session.status() 可读更新状态。
await session.close(); // 等待插件退出和性能历史落盘
```

普通应用不需要手写这个流程；`PocketApp` / `PocketGuest` 会在挂载和卸载时
创建、关闭 session。

## 更新、硬件和自定义插件

签名更新配置示例：

```dart
const updates = PocketUpdateConfig(
  url: 'https://updates.example.test/manifest.json',
  keyId: 'release-key-1',
  publicKey: 'BASE64_ED25519_PUBLIC_KEY',
  namespace: 'production',
);

const config = PocketAppConfig(
  appId: 'com.example.myapp',
  updates: updates,
);
```

也可用 `PocketUpdateConfig.fromEnvironment()`，并在构建时传入：

```sh
flutter run \
  --dart-define=POCKET_UPDATE_URL=https://updates.example.test/manifest.json \
  --dart-define=POCKET_UPDATE_KEY_ID=release-key-1 \
  --dart-define=POCKET_UPDATE_PUBLIC_KEY=BASE64_ED25519_PUBLIC_KEY \
  --dart-define=POCKET_STORE_NAMESPACE=production
```

更新包仍须是签名且 ABI 匹配的 qjbc/PAK/manifest；失败的 guest 不会提升为
active，session 会保留上一个健康版本。原生插件或硬件 provider 不能由 JS 热更
下载，必须重新编译宿主。启用硬件还需要在 `allowedPermissions` 中明确允许的
权限，系统权限请求由用户操作触发。`--hardware` 脚手架默认允许
`HardwarePermissions.all` 只是为了让示例能协商 provider；生产应用应按功能缩小
集合，并保留 manifest 的最小声明。

硬件 provider 通过同一个 `com.pocketnexus.host/hardware` MethodChannel 暴露
iOS/Android 对齐的 capability 协议。当前 provider 实现位于
`packages/pocket_hardware/ios` 与 `packages/pocket_hardware/android`；Android
实现使用 Android 原生权限与生命周期，但不会改变 JS capability 名称。iOS 需要在
`Info.plist` 声明实际使用的键：`NSCameraUsageDescription`、
`NSPhotoLibraryAddUsageDescription`、`NSPhotoLibraryUsageDescription`、
`NSMicrophoneUsageDescription`、`NSLocationWhenInUseUsageDescription`、
`NSBluetoothAlwaysUsageDescription`、`NSBluetoothPeripheralUsageDescription`、
`NSMotionUsageDescription` 和 `NSFaceIDUsageDescription`；CLI 的 `--hardware`
会生成这些说明。Android 的脚手架会声明 `CAMERA`、
Android 12+ 的 `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT`、旧版 Bluetooth 兼容声明、
位置和生物识别权限。传感器使用 `SensorManager` 的运动/气压传感器，不需要
`BODY_SENSORS`；照片保存在 app-private 目录，不申请外部媒体或存储权限；当前 provider
也没有录音 API，因此不声明 `RECORD_AUDIO`。声明不等于授权：Android 仍要求在运行时
由用户操作触发相机、BLE 或位置权限请求；生物识别使用 `BiometricPrompt`，不应把
manifest 声明当作成功。若设备
没有对应硬件，provider 返回结构化的 `hardware_unsupported`/`hardware_permission_denied`，
不会伪造照片、坐标、传感器或 Texture。`NSLocalNetworkUsageDescription` 属于应用自己
的网络/更新场景，不由硬件开关虚假添加。

### iOS Scene 生命周期自动适配

`pocket init`/`pocket build --platform=ios-sim|ios` 会对 Flutter 3.35 生成的默认
iOS 壳执行幂等的 Scene 适配（实现位于 `pocket.ts:patchIosSceneLifecycle`）：

- 默认生成的 `AppDelegate.swift` 增加 `FlutterPluginRegistrant`，将插件注册交给
  `FlutterSceneDelegate` 使用的 registry；
- `Runner/Info.plist` 增加单窗口 `UIApplicationSceneManifest`、`UIWindowScene`、
  `FlutterSceneDelegate` 和 `Main` storyboard 配置；
- 已有 Scene manifest 不会重复写入，重复执行也不会产生重复 Scene 配置。

如果工程已有自定义 `AppDelegate.swift`，CLI 不会覆盖业务代码：没有 Scene manifest
时会明确失败并要求工程手工加入 `FlutterSceneDelegate`/Scene 配置；已有 Scene manifest
时会原样保留自定义 delegate。因此自定义壳需要自行确认 `GeneratedPluginRegistrant`
仍通过 `FlutterPluginRegistrant` 注册，并保留 Scene 生命周期。该行为由
`scripts/tests/tooling_scene.test.ts` 覆盖（默认 delegate 生成、custom delegate
保护和幂等性）。

自定义插件从 `pocket_sdk.dart` 导出的 `pocket_services` 类型实现：

```dart
final class EchoPlugin extends PocketPlugin {
  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: 'example.echo',
    version: '1.0.0',
    capabilities: {
      'example.echo': PocketPluginCapability(
        name: 'example.echo',
        kind: PocketCapabilityKind.request,
      ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest('example.echo', (params) => params);
  }
}

PocketApp(
  config: PocketAppConfig(
    appId: 'com.example.myapp',
    pluginFactories: [(_) => EchoPlugin()],
  ),
);
```

插件经过 descriptor、guest manifest、权限和 quota 准入后才激活；guest 切换、
失败恢复和关闭时 SDK 会撤销 capability 并调用 deactivate/dispose。不要绕过
`PocketPluginContext` 直接暴露 native API。

## 构建真实字节码和原生库

```sh
cd /path/to/my-pocket-app
bun /Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts build . --sdk-root /Volumes/ORICO/Development/Github/pocket/sdk
```

构建流程复用 SDK 的 `scripts/build_guest.ts`、固定版本的 PocketJS compiler
和 `native/pocketjs_bytecode`，不会另造 compiler：

1. 解析外部工程的 `app.tsx` 和 `pocket.json`；
2. 用固定 compiler transform 预编译 vendored `@pocket/ui`（避免 compiler 对任意 `node_modules` 跳过 JSX transform）；
3. 生成诊断用 `build/pocket/app.js`、完整 PAK 和真实 `app.qjbc`；
4. 校验 `app.bytecode.json.entryFormat == quickjs-bytecode`、`runtimeAbi` 非空；
5. 写入 `guest-manifest.json`，并复制 qjbc/PAK/metadata/manifest 到 `flutter/assets/`。

`app.js` 仅用于诊断和复现，运行时只加载 qjbc，没有 source-eval fallback。

若要准备 Flutter FFI archive，显式选择平台：

```sh
bun /Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts build . --sdk-root /Volumes/ORICO/Development/Github/pocket/sdk --platform=ios-sim
# 设备：--platform=ios；macOS：--platform=macos
```

命令复用 `scripts/build_native.sh`，并在 SDK 的被忽略目录
`.pocket-build/sdk-native/<platform>.json` 记录平台、输入指纹和 archive。
simulator/device/Android 不会静默共用错误的 archive；首次 clean checkout
需要对应的 Xcode/Rust 工具链。
`--platform` 只准备库，不启动设备。

## Pocket Studio（外部工程）

```sh
bun /Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts editor /path/to/my-pocket-app \
  --port=8790
```

服务的 `--project-root` / `POCKET_EDITOR_PROJECT_ROOT` 可指定已有工程。页面和
接口支持项目列表、创建、读取/编辑 guest 源码、构建、发布和日志状态；外部工程
模式不会复制 showcase。GET/PUT 文件 API 仅允许安全的 guest 源文件扩展名，拒绝
路径越界和 symlink，不返回 qjbc、PAK、私钥、构建状态或更新产物。构建失败时保留
上一个成功 revision，不发布坏源码。签包流程仍使用真实
`scripts/package_update.ts`；Flutter 侧统一使用 SDK 的 `PocketSession`。

SDK 集成基线的 showcase 已通过该服务完成一次真实闭环：revision 17 生成
233,227-byte qjbc、333,536-byte PAK，并发布
`entryFormat=quickjs-bytecode`、runtime ABI
`quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021`。
`latest.json` 的 Ed25519 签名、qjbc/PAK 哈希与大小、20 个 content-addressed
blob，以及 blob 重建后的完整 PAK 均已独立校验；编辑器的 tar.gz 仅用于离线导出，
宿主仍按 `host.json` 的 URL/key 配置消费签名 manifest 和 blob。

## 当前限制

- CLI 当前支持固定版本的 Solid guest 编译路径，不承诺任意 Web/DOM 包。
- PAK 是一个完整的运行期资源包；更新服务可以发布 content-addressed ranges，
  但 `PocketSession` 消费前仍会验证并重建完整 PAK，而不是直接加载 tar.gz。
- 原生插件更新必须重新编译 Flutter 宿主，JS 热更不能下载 native binary。
- iOS 最低部署版本为 15.0；Android renderer 最低 API 24，当前 native archive 只有
  `arm64-v8a`；Duo 原生几何桥需要 Xcode / SDK 27.1+ 编译，旧 iOS 运行时返回空保留区域。
- Android provider 的真实相机/BLE/传感器/定位/生物识别仍需在实体 Android
  设备上验收；模拟器或未授权设备只能验证结构化 unsupported/denied 结果。

2026-11-02 输入修复版本：Editor revision 18 / version 0.1.1 / build 2，
235139-byte qjbc 与 333472-byte PAK。真实 Duo App 的 `Host → Updates → Check`
返回 `stage=verified`、`available=0.1.1`、`lastError=none`，普通 App 也已激活 0.1.1。
macOS 本地服务可用 `bash scripts/editor_service.sh start` 启动、`status` 检查、
`stop` 停止；服务独立于当前终端，退出登录或重启后需要重新 start。

以上服务命令从 `/Volumes/ORICO/Development/Github/pocket/sdk` 执行；它使用 SDK
目录下的 `editor/`、`packages/` 和编译工具。Showcase 的 `../demo` 不会被复制成
SDK 实现，也不会回到旧 `pocket_host` 路径。
