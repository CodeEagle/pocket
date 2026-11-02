# Pocket Showcase Demo

这是 SDK 的唯一示例应用。Demo 第一层就是 Flutter 工程；所有 JS/TS 代码集中在 [`js/`](js/) 中。

先看两个入口：

- [`lib/main.dart`](lib/main.dart)：最薄 Flutter host，只配置并启动 `PocketApp`。
- [`js/app.tsx`](js/app.tsx)：Showcase 的 JS 入口，负责页面、状态、路由、移动 UI、转场、Liquid Glass 和硬件能力演示。

运行 Demo：

```sh
cd /Volumes/ORICO/Development/Github/pocket/demo
flutter pub get
flutter run -d 4D366210-290E-46DB-8BC6-3C5233700409
```

Android 同样从 `demo/` 运行：

```sh
flutter run -d <android-device-id>
# 构建可安装 APK
flutter build apk --debug
```

当前 Android 原生运行库提供 arm64，最低 API 24。相机、BLE、运动传感器、定位和
生物识别通过 SDK 的 Android provider 接入，页面继续使用同一份 JS；系统权限由
页面操作触发。硬件支持和实测边界见 [硬件复用记录](../sdk/docs/HARDWARE_REUSE.md)
与 [验证记录](../sdk/docs/VALIDATION.md)。

只改 JS 时：

```sh
cd /Volumes/ORICO/Development/Github/pocket/demo/js
bun install
bun run build
```

Flutter 产物和平台工程在 `demo/` 第一层；JS 测试和更新脚本放在 `js/` 下，设备截图与测试产物放在 `artifacts/`。要开发可复用能力，请返回 [`../sdk/README.md`](../sdk/README.md)，不要在 Demo 里复制 SDK 实现。

要启用本机 Editor 热更（已有本机签名配置时）：

```sh
# 从 demo/ 执行
bash ../sdk/scripts/editor_service.sh start
flutter run --dart-define-from-file=../sdk/.pocket-build/editor-host.json
```
