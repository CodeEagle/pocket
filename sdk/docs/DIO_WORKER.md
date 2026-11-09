# Dio 专用 IO Worker

## 使用与执行边界

`PocketDioPlugin` 默认将 Dio HTTP、响应流读取、JSON/text/bytes 解码和大小校验放入专用 Dart IO Worker isolate。首次实际请求按需创建，每个插件实例复用一个 Worker；调用方不需要额外开启线程。JS 仍使用 `createPocketDioClient(host).request()`，结果仍为 `{ statusCode, headers, data }`。

主 isolate 保留现有 capability/permission 准入、RPC 请求关联、并发预算和插件生命周期。请求、重试策略、鉴权业务状态和页面编排仍由 JS 控制；没有增加 Dart 业务状态机或重试层。

三种 Worker 各有职责：

| 执行方式 | 使用场景 | 配置与授权 |
| --- | --- | --- |
| 官方 JS 业务 Worker | 官方 `net.http`、JS 后台计算 | `domains.worker`、Worker QJBC/descriptor；HTTP 需 `workerHttpOrigins` |
| Dio IO Worker isolate | Flutter 原生宿主的 `dio.request` | 注册 `PocketDioPlugin`、`network` 权限、插件 `allowedOrigins`；自动使用 IO Worker |
| Web 渲染 Worker | 改变 UI/layout/raster 的执行位置 | `renderWorker`，默认关闭；与联网无关 |

纯 Dio 调用不要求创建 `domains.worker`，也不要求额外声明 `net.http`。独立 Web SDK 不包含 Dart Dio 插件，继续使用官方业务 Worker HTTP 路径；不伪造 Dio 响应。

## 接入与定制

原有接入不变，`--dio` 生成的插件工厂也会使用 IO Worker。来源白名单仍默认空，必须由可信宿主填写：

```dart
PocketDioPlugin(allowedOrigins: {'https://api.example.com'});
```

JS 用法及权限说明见 [可选插件](OPTIONAL_PLUGINS.md#dio-接入)。仅声明 capability 不等于网络授权，不开放通配来源，不自动跟随重定向。

定制客户端时在 Worker 内创建 Dio，使用顶层或静态 factory：

```dart
import 'package:dio/dio.dart';
import 'package:pocket_dio/pocket_dio.dart';

Dio createNetworkDio() => Dio();

final plugin = PocketDioPlugin(
  allowedOrigins: {'https://api.example.com'},
  dioFactory: createNetworkDio,
);
```

原来的 `dio: existingDio` 注入改为 `dioFactory`。Dio 实例、适配器和连接由 Worker 拥有；factory 不应捕获 widget、控制器、已有 socket 或其他不可跨 isolate 传递的资源。启动失败通过请求错误返回，不回到主 isolate 发送请求。

## 有界执行和生命周期

最多 8 个未完成 RPC 槽位，包含等待 Worker 启动和超时后尚待取消确认的请求；超额明确失败，不维护另一条无界队列。Future 超时不代表底层操作已结束，因此槽位保留到 Worker 回复；250ms 内未确认取消则回收 Worker，使后续请求可以重新启动。请求 deadline 包含 Worker 启动和等待过程，guest 超时只能缩短可信宿主上限。原有响应原始字节与 JSON 编码后结果的限制、HTTP 状态、精确 origin 检查与解码错误语义保持。

停用和销毁均取消已有请求并结束对应 Future；恢复后可再次发起请求，销毁后拒绝新请求。Worker 启动失败、异常退出和请求超时必须使 pending 请求失败，不依赖迟到响应清理。资源清理由唯一拥有 Dio 的 Worker 执行，销毁同时回收 isolate 和消息端口。

这次调整改变执行位置，不承诺所有请求耗时或 FPS 提升；IO Worker 的价值是将网络响应处理与解码移出主 isolate。

## 来源与消融

先检查保留父工程（排除 `pocket_host/`）：`lib/core/real_hardware_bridge.dart:390` 的天气请求有真实 HttpClient、超时和 JSON 解码，但没有 Dio Worker；`web_wasm_preview/index.html` 的 `wasmWorkerStepEcho` 是同步环形缓冲演示，也不是可复用的 Dart isolate 实现。

保留当前 `packages/pocket_dio/lib/src/dio_plugin.dart` 的有界 Dio 请求语义，适配为 Worker 拥有的唯一网络执行实现。复用既有 PocketPlugin/HostBridge/权限准入，不引入第二套 JS bridge、请求重试或应用状态。主线程直接 Dio 执行路径移除，避免出现两份网络实现。

## 验证

从仓库根目录运行：

```sh
cd sdk/packages/pocket_dio
dart test
dart analyze
```

真实 loopback HTTP 应覆盖 JSON、文本、字节、POST、非 2xx、禁止重定向、来源限制、超限、总超时与生命周期取消。执行位置通过在 Worker 内创建 Dio 的 factory/interceptor 标注 isolate 身份，再由真实服务器回显验证；不用模拟成功响应或文件存在代替线程验收。iOS/Android/macOS 实机联调与持续性能测量属于后续平台验收，不由本机 Dart 回归代替。

### 本轮验证结果

本机 `dart test` 19 项通过，`dart analyze` 无问题。JS bridge、Dio 脚手架及 CLI/Studio 模板回归共 12 项通过、59 断言。额外的背压回归在修复前失败：8 个已发送请求超时后，第 9 个请求仍被派发并最终超时；修复后它在取消未确认期间立即报告 `request_limit`，且 Worker 回收后新请求成功。
