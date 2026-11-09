# SDK 内置与可选插件

插件由可信 Flutter 宿主编译、注册；JS manifest 只能申请已注册能力，不能安装原生代码。

| 包 / 插件 | 启用方式 | 当前能力 |
| --- | --- | --- |
| `PackageInfoPlugin` / `flutter.package_info_plus` | `pocket_sdk` 默认注册 | `plugins.packageInfo`，宿主应用元信息 |
| `pocket_hardware` / `flutter.hardware` | 兼容聚合入口；CLI `--hardware` | 全部硬件能力；新消费者可按下述独立包选择 |
| `pocket_permissions` / `flutter.permission_handler` | 显式注册 `PocketPermissionsPlugin` | 复用 Flutter permission_handler 的系统权限查询、申请与打开设置 |
| `pocket_camera`、`pocket_bluetooth`、`pocket_sensors`、`pocket_location`、`pocket_biometrics`、`pocket_weather` | 分别注册 `PocketCameraPlugin` 等 | 仅相应领域的能力；独立原生包不依赖其余硬件包 |
| `pocket_platform` / `flutter.platform` | 显式依赖并注册 `PocketPlatformPlugin`；CLI `--platform-experience` | `platform.systemUi.set`、`platform.haptics.perform` |
| `pocket_platform` / `flutter.links` | 注册带 scheme 的 `PocketDeepLinkPlugin` 并配置原生 scheme；CLI `--deep-link-scheme=...` | `platform.links.initial/latest/events` |
| `pocket_dio` / `dart.dio` | 显式依赖并注册 `PocketDioPlugin`；CLI `--dio` | `dio.request`，独立 IO Worker isolate 中的有界 HTTP 请求 |

系统运行时、平台代理与调试录制还使用内部插件。OTA 下载使用 `pocket_services` 的 `http`；Worker 的 `net.http` 使用原有 Worker IO 通道。这两者不要求安装 Dio。Dio 不替换这两个已工作的实现。

硬件拆分、权限边界与接入示例见 [HARDWARE_MODULES.md](HARDWARE_MODULES.md)。

## Dio 接入

Dio 的请求、响应读流和 JSON/text/bytes 解码默认在插件自己的持久 IO Worker isolate 中执行；主 isolate 只保留能力准入、请求关联与生命周期边界。首次请求按需启动，后续复用，调用方无需打开 Worker 开关。JS 的 `createPocketDioClient(host).request()` 和响应格式不变。

这个 IO Worker 与官方 `domains.worker` 的 JS 业务 Worker、Web 的 `renderWorker` 各自独立。仅使用 Dio 不必新增 `domains.worker` / `net.http` 声明；继续声明 `dio.request`、授予 `network` 并配置插件的 `allowedOrigins`。Web 渲染 Worker 仍默认关闭。详见 [Dio Worker 实现](DIO_WORKER.md)。

消费者 `pubspec.yaml` 添加 `pocket_dio` 的 path 依赖，指向 `sdk/packages/pocket_dio`。`pocket_sdk` 自身不依赖这个包。新工程也可以使用 `bun pocket.ts init /path/to/app --dio`；生成的 origin 白名单为空，需自行填写。

```dart
import 'package:pocket_dio/pocket_dio.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

PocketPlugin createDioPlugin(PocketViewController controller) =>
    PocketDioPlugin(allowedOrigins: {'https://api.example.com'});

final config = PocketAppConfig(
  appId: 'dev.example.app',
  allowedPermissions: {'network'},
  pluginFactories: [createDioPlugin],
);
```

guest `manifest.json`：

```json
{
  "protocolVersion": 1,
  "capabilities": { "requires": [], "optional": ["dio.request"] },
  "permissions": { "optional": ["network"] }
}
```

业务页面使用已有 `HostBridge`，不需要创建第二个事件分发器：

```ts
import { createPocketDioClient } from '@pocket/ui/dio';

const dio = createPocketDioClient(host);
const response = await dio.request({
  url: 'https://api.example.com/items',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  queryParameters: { page: 1 },
  data: { name: 'Pocket' },
  responseType: 'json', // json | text | bytes
  timeoutMs: 2000,
});
// response: { statusCode, headers, data }
```

非 2xx 状态仍返回 HTTP 响应；网络错误、未授权、超限、生命周期取消通过现有 bridge 错误返回。白名单按 origin 精确匹配；不自动跟随重定向。切后台和销毁时取消正在执行的请求；销毁同时释放 IO Worker，恢复前台后可再次按需发起请求。重试、鉴权业务策略、状态和页面编排由 JS 管理。

宿主默认总超时 30 秒，guest 的 `timeoutMs` 只能缩短它。已有 HostBridge 的帧超时也独立生效；长请求需由消费者配置相应的 bridge deadline。响应原始字节与编码后的返回值都受大小限制，默认上限 256 KiB（bytes 数组会因 JSON 编码更早触及限制）。

默认 `json` 模式按响应 Content-Type 解码 JSON，其他 MIME 返回文本；声明为 JSON 的无效响应会报解码错误。`text` 始终返回文本，`bytes` 返回整数数组。

此接口不是完整 Dart Dio 对象的远程映射：不暴露文件系统路径、multipart 文件上传、下载落盘或进度流。Editor 预览不伪造原生 Dio 响应；未注册插件时按能力不可用处理。

Android 宿主主 manifest 需要 `android.permission.INTERNET`（`--dio` 脚手架会加入）。手动嵌入时需自行声明。macOS 沙箱宿主需在所用构建配置的 entitlements 中开启 `com.apple.security.network.client`。iOS/Android 的明文 HTTP 仍受平台传输策略约束；origin 白名单不会绕过这些策略，生产接口应使用 HTTPS。

## 来源、适配与消融

实现前检查 retained parent（排除 `pocket_host/`）：

- `pocketjs_flutter_demo/pubspec.yaml` 与 `mini_apps/pocket_plugins.json`：未声明 Dio。
- `mini_apps/pocket_plugins.lock.json`、`pocket_flutter_plugins.d.ts`、`tools/sync_pocket_plugins.py`：保留显式选择与能力契约思路，不复用字符串扫描的裁剪/体积估算。
- `lib/core/real_hardware_bridge.dart:390` 起的天气 HTTP：保留真实异步网络与超时语义；固定天气请求无法提供通用 Dio 能力，是新增可选 IO 适配的证据。没有迁移旧天气实现中的缺省成功数据。

复用当前 SDK 的 `PocketPlugin`、权限准入、请求预算和 `HostBridge`。未增加第二套插件注册表、轮询器、网络状态机、GET/POST 别名包装或重试层。关闭 `--dio` 后，生成工程不包含 Dio 包依赖、工厂、权限或能力；开启后只增加必要的可选适配。

## 验证

- `sdk/packages/pocket_dio`：真实 loopback HTTP、响应格式、状态码、origin 限制、重定向、超限和生命周期回收测试。
- `sdk/packages/pocket_ui/test/dio.test.ts`：实际 HostBridge 的请求关联、HTTP 错误状态和插件缺失错误传播。
- `sdk/packages/pocket_ui/test/dio_native.test.ts`：使用同一 pinned `buildGuest` 编译链与真实 QuickJS/native probe，指针点击触发 `dio.request`，注入宿主响应后验证 Loading → HTTP 结果/Unavailable 的绘制帧变化。这里的宿主响应用于验证传输边界；真实网络由 Dart loopback 测试覆盖，不声称已经运行 iOS/Android 设备端联调。
- `sdk/scripts/tests/dio_scaffold.test.ts`：默认关闭及与其他可选插件组合。
