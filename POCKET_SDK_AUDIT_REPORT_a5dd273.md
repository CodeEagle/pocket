# Pocket SDK 完整代码与运行证据审核报告（目标版本：`a5dd273`）

- **被审仓库**：`/Volumes/ORICO/Development/Github/pocket`（目标提交：`a5dd273`，工作区干净，全程只读审核，未修改/删除任何文件或缓存）
- **对照旧工程**：`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`（已明确排除 `pocket_host/`，仅做源码调用链对照，未运行或重建）
- **审核时间**：2026-11-02

---

## 总体判断

在 `a5dd273` 版本上，Pocket 已经确立了正确的核心底座：**Flutter 薄宿主 + Rust `rquickjs` 真实预编译字节码（`PJSB` v2 envelope + SHA-256 + QuickJS engine ABI 校验）+ `@pocket/ui` Solid/PocketJS primitives + Ed25519 签名热更新 + 平台原生硬件插件（iOS/Android）**，并且没有回退到旧工程的第二套 Dart VDOM 或伪 `.pjc` 源码打包。

但从**生产实际调用链**而非孤立单元测试来看，`a5dd273` 仍存在 **2 项 P0（生产调用链未接通 / 权限隔离失效与整包误杀）**、**5 项 P1（内嵌版本 build 恒为 0、Ticker 休眠冻结 JS 定时器、每帧全量 JSON 序列化、Editor 无 Origin CSRF 绕过、iOS 单架构产物覆盖）** 和 **4 项 P2 问题**：
1. **双向 Lock-Free SPSC 通道（`duplex.rs` / `pocket_duplex.dart`）虽已实现并通过独立测试，但未接入 `PocketView` / `PocketSession` / Showcase 的生产输入与事件主循环**——线上指针、文本输入、安全区和宿主消息仍 100% 走 JSON（`jsonEncode` -> `pocket_send`）。
2. **插件权限模型按“整插件聚合”而非“按方法隔离”，且 `hardware.permissions.request` 声明了空权限集 `{}`**——既会导致可选硬件能力未声明权限时将整个 `HardwarePlugin` 连坐吊销（甚至炸穿 guest 启动），又允许未获授权的 guest 直接调用 `hardware.permissions.request` 弹出系统权限框，或通过 `hardware.weather.current` 绕过 `hardware.location` 权限读取真实 GPS。
3. **构建链从 `guest-manifest.json` 读取 `build`/`version`，但该文件只存协议与权限，`build` 实际存在 `editor.json`**——导致 `demo/assets/app.bytecode.json` 及所有 CLI/Editor 产物的 `embeddedBuild` 在运行时恒为 `0`。

---

## 1. 按 P0 / P1 / P2 排序的实际问题

### P0-1：双向 Lock-Free SPSC 通道仅停留在 Runtime/测试层，未接入 `PocketView` 生产输入与事件链路

- **文件与行号**：
  - `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:204-214`（`PocketViewController.send`）
  - `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:1246-1275`（`_PocketViewState._reportSafeArea`）
  - `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:2349-2378`（`_PocketViewState._sendPointer`）
  - `sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart:273-306`（`FfiPocketRuntime._lookupDuplexBindings`）
  - `sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart:365-375`（`FfiPocketRuntime.openDuplex`）
  - `sdk/native/src/lib.rs:1491-1498`（`build_frame` 中的 `drain_duplex`）
- **触发条件**：运行任何基于 `PocketApp` / `PocketSession` / `PocketView` 的应用（包括 `demo/` Showcase），进行触控拖拽、手势滚动、窗口尺寸更新或宿主消息交互。
- **影响**：
  1. 虽然 `sdk/native/src/duplex.rs:1-489`、`sdk/native/src/lib.rs:3276-3544` 和 `sdk/packages/pocket_flutter/lib/src/pocket_duplex.dart:1-435` 完整实现了 ABI v2 的 `CachePadded<AtomicU32>` 单生产者/单消费者无锁环形队列、世代隔离（generation）和 `NativeFinalizer`，但全仓库没有任何生产代码调用 `runtime.openDuplex()`。
  2. 所有高频指针事件（`_sendPointer`）和视口事件仍逐条经过 `Map` 分配 -> `jsonEncode` -> UTF-8 拷贝 -> `pocket_send` -> Rust `serde_json::from_str`。
  3. 次要 FFI 一致性缺陷：`_lookupDuplexEndpointBindings`（`pocket_runtime.dart:838-872`）正确标注了 `isLeaf: true`，但 `FfiPocketRuntime._lookupDuplexBindings`（`pocket_runtime.dart:273-306`）中的 `pocket_duplex_abi_version`、`pocket_duplex_message_size`、`pocket_duplex_capacity` 漏掉了 `isLeaf: true`。
- **验证证据**：在 `sdk/` 与 `demo/` 中检索 `openDuplex` / `PocketDuplexChannel`，调用点仅存在于 `pocket_duplex_test.dart:15-180` 与 `pocket_duplex_ffi_test.dart:55-115`。
- **最小修复建议**：
  1. 在 `_PocketViewState._boot`（`pocket_view.dart:828-855`）及 reload 成功后调用 `_runtime.openDuplex()` 获取 `PocketDuplexEndpoint`，并在 `_PocketViewState.dispose` / reload 前 `close()`。
  2. 将高频数值型消息（如指针移动/按下/抬起或专用数值信令）优先通过 `PocketDuplexEndpoint.publishIngress` 写入无锁通道，并在每帧 tick 后调用 `drainEgress` 分发 guest 侧 `__pocketEmitDuplex` 消息；在 `_lookupDuplexBindings` 中补齐 `isLeaf: true`。

---

### P0-2：插件权限按“整插件聚合”而非“按方法校验”，且 `hardware.permissions.request` 与 `weather.current` 可绕过权限声明与宿主准入

- **文件与行号**：
  - `sdk/packages/pocket_services/lib/src/pocket_plugin.dart:484-568`（`PocketPluginManager.activate`）
  - `sdk/packages/pocket_services/lib/src/pocket_host.dart:164-221`（`PocketHost.guestAvailability`、`revokeCapabilities`）
  - `sdk/lib/src/pocket_session.dart:188-243`（`PocketSession._configureBridge`）
  - `sdk/packages/pocket_hardware/lib/src/hardware_plugin.dart:136-271`（`HardwarePlugin`）
  - `sdk/packages/pocket_hardware/lib/src/hardware_plugin.dart:602-609`（`HardwarePlugin.weatherCurrent`）
- **触发条件**：
  1. Guest 在 `guest-manifest.json` 中将 `hardware.permissions` 设为 `required`，将 `hardware.camera.capture` 设为 `optional`，但仅声明了部分权限（或宿主通过 `PocketAppConfig.allowedPermissions` 仅允许定位而不允许相机）；
  2. Guest 调用 `hardware.permissions.request({ permission: "hardware.camera" })` 或不带经纬度调用 `hardware.weather.current({})`。
- **影响**：
  1. **整插件连坐失败/吊销**：`PocketPluginManager.activate`（`pocket_plugin.dart:492-543`）将插件下所有 `grantedMethods` 的 `permissions` 合并成单一集合 `requiredPermissions`，并用 `requiredCapability = names.any(availability.required.contains)` 判断。只要 `HardwarePlugin` 中有任意一个 `required` 能力（如无需权限的 `hardware.permissions`），而另一个 `optional` 能力（如相机）缺少权限，整个 guest 会直接因 `permission_not_declared` / `plugin_permission_denied` 启动失败；若全部是 `optional`，则会执行 `granted.removeAll(names); host.revokeCapabilities(names)`，把已获权限的其它硬件能力一并吊销。
  2. **越权弹窗与越权定位**：`HardwareCapabilities.requestPermission`（`hardware_plugin.dart:187-190`）的 `permissions` 声明为 `const <String>{}`，且 `requestPermission`（`hardware_plugin.dart:264-271`）不调用 `_checkPermission(permission)`；同时 `PocketSession._configureBridge`（`pocket_session.dart:188-192`）构造 `HardwarePlugin` 时根本未传入 `grantedPermissions`，导致 `_grantedPermissions` 为 `null`、`_checkPermission`（`hardware_plugin.dart:159-166`）在生产环境中形同虚设。此外 `weatherCurrent`（`hardware_plugin.dart:251-255`）仅声明 `HardwarePermissions.network`，但在未传 `latitude`/`longitude` 时直接调用 `_native('getCurrentLocation')`（`hardware_plugin.dart:602-609`），绕过了 `hardware.location` 权限检查。
  3. **能力快照失真**：`PocketHost.revokeCapabilities`（`pocket_host.dart:217-221`）只从 `_handlers` 移除处理器，未更新 `_availability`，导致 `host.capabilitiesJson()` 仍向 guest 报告已被吊销的能力为 `granted`。
- **验证证据**：阅读 `pocket_plugin.dart:489-559` 与 `pocket_session.dart:188-204` 可直接确认调用链。
- **最小修复建议**：
  1. 在 `PocketPluginManager.activate` 中按**单个 `PocketPluginMethod`（capability）**独立校验 `method.permissions ?? descriptor.permissions`：未声明或未被宿主允许的 `optional` capability 仅吊销该 capability 本身，只有当全部 capability 均被吊销时才跳过插件 `onActivate`。
  2. 在 `PocketHost.revokeCapabilities` 中同步更新 `_availability`。
  3. 在 `PocketSession._configureBridge` 将经 manifest 声明与 `config.allowedPermissions` 交集后的权限集合传给 `HardwarePlugin(grantedPermissions: ...)`；在 `requestPermission` 中校验目标 `permission` 属于已准入集合，在 `weatherCurrent` 未传坐标分支中校验 `HardwarePermissions.location`。

---

### P1-1：构建链未将项目 `version`/`build` 写入 `app.bytecode.json`，导致运行时 `embeddedBuild` 恒为 `0`

- **文件与行号**：
  - `sdk/scripts/build_guest.ts:404-424`
  - `sdk/pocket.ts:505-521`
  - `demo/assets/app.bytecode.json:1-13`
  - `demo/assets/guest-manifest.json:1-44`
  - `sdk/lib/src/pocket_session.dart:88-92`
  - `sdk/lib/src/pocket_session.dart:165-173`
- **触发条件**：使用 `bun sdk/pocket.ts build`、`sdk/scripts/build_guest.ts` 或 Editor 构建任何工程（包括 `demo/`），随后启动 `PocketSession` 并检查 `runtime.info` 或执行热更新最低构建号准入（`minimumBuild`）。
- **影响**：
  1. `build_guest.ts:404-424` 只尝试从 `manifest.json`（即 `guest-manifest.json`）读取 `version` 和 `build`，但 `guest-manifest.json` 仅包含 `protocolVersion`、`capabilities` 和 `permissions`（项目版本与构建号实际存放在 `editor.json` / `pocket.json`）。
  2. 因此实际生成的 `demo/assets/app.bytecode.json` 完全不包含 `version` 与 `build` 字段。
  3. `PocketSession._initialize`（`pocket_session.dart:88-92`）解析出的 `embeddedBuild` 恒为 `0`，导致新装 App 首次热更新时 `minimumBuild == 0`，无法拦截低于内置包真实构建号的旧热更新包；且 `PocketSession.status()`（`pocket_session.dart:168-171`）仍硬编码 `'activeBuild': active?.build ?? 0` 和 `'build': 0`。
- **验证证据**：查看 `demo/assets/app.bytecode.json:1-13`，仅含 `entryFormat`、`kind`、`runtimeAbi`、`bindingGeneration`、`tickHz`、`bytecodeBytes`、`bytecodeSha256`、`pakBytes`、`pakSha256`、`contractSha256`、`envelopeVersion`，无 `build` 或 `version`。
- **最小修复建议**：在 `build_guest.ts:404-424` 中当 `manifest.json` 未包含 `version`/`build` 时回退读取同目录的 `editor.json` / `pocket.json` 并写入 `app.bytecode.json`；在 `PocketSession` 中保存 `_embeddedBuild` 并在 `status()` 中返回 `active?.build ?? _embeddedBuild`。

---

### P1-2：`PocketView` 在连续 6 帧无变化后停止 `Ticker`，导致 QuickJS 定时器（`setTimeout`）与延迟动画冻结

- **文件与行号**：
  - `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:324-336`（`_wakeTicker`）
  - `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:886-891`（`_onTick`）
  - `sdk/native/src/lib.rs:1483-1522`（`build_frame` 推进 `__pocketAdvanceTime`）
- **触发条件**：Guest 在交互或宿主响应后设置了超过 ~100ms（6 帧 @ 60Hz）才触发的 `setTimeout` / `setInterval`、防抖状态更新，或通过独立 `PocketDuplexEndpoint` 推入消息而未经过 `PocketViewController.send`。
- **影响**：
  - QuickJS 的虚拟时钟与定时器完全依赖每帧调用 `pocket_frame_delta` 内的 `__pocketAdvanceTime(dt)` 驱动。
  - 当画面连续 6 帧无 DrawList 变化（`idleFrames >= 6`）时，`_onTick`（`pocket_view.dart:886-891`）直接执行 `_ticker?.stop()`。在用户下一次触摸屏幕或宿主主动发送 bridge 消息之前，`pocket_frame_delta` 不再被调用，所有大于 100ms 的 JS `setTimeout` / 轮询 / 延迟动画永久挂起。
- **验证证据**：检查 `pocket_view.dart:886-891` 与 `lib.rs:1483-1522`，Rust 端未向宿主暴露“下一个待执行 timer 到期时间（next timer deadline）”或“是否有活跃动画/timer”。
- **最小修复建议**：在 Rust `FrameResult` / delta 响应或轻量级 FFI 查询中返回 guest 是否存在活跃动画或最近一个 timer 的剩余毫秒数 `nextTimerMs`；若存在活跃动画则保持 `Ticker`，若仅有延迟 timer 则在 `_ticker?.stop()` 时挂载一次性 Dart `Timer(Duration(milliseconds: nextTimerMs), _wakeTicker)`。

---

### P1-3：所有发生变化的帧仍通过 FFI 序列化完整 DrawList 与 RGBA 像素数组为 UTF-8 JSON

- **文件与行号**：
  - `sdk/native/src/lib.rs:1649-1696`（`FrameResult` 与 `FrameResource`）
  - `sdk/native/src/lib.rs:3219-3251`（`frame_delta_json_for_host`）
  - `sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart:195-210`（`FfiPocketRuntime.frameDeltaAt`）
  - `sdk/packages/pocket_flutter/lib/src/pocket_model.dart:168-185`（`PocketFrameResource.fromJson`）
- **触发条件**：页面滚动、路由转场动画（60fps）、Stress 节点压测（500 节点产生 1761 条 DrawOp）或首次加载含字体/图集纹理资源的帧。
- **影响**：
  - `pocket_frame_delta` 仅在 DrawList 与上一帧**完全字节一致且无事件/无新资源**时返回 `{"unchanged":true}`。
  - 一旦帧内有任何一个数字或坐标变化（例如滚动或转场），Rust 就会把整帧全部 `DrawOp` 重新序列化为 JSON 字符串（分配 `String` -> `CString`），Dart UI 线程再 `toDartString()` + `jsonDecode` 生成数千个 `Map` 对象。
  - 更严重的是，`FrameResource.pixels: Vec<u8>`（`lib.rs:1676`）被 `serde_json` 序列化为十进制数字数组 `[255,0,128,...]`，Dart 侧再逐个 `(item as num).toInt()` 转回 `Uint8List`。
- **验证证据**：`native_guest_probe.ts:500-530` 实测 500 节点时单帧产生 `1761` 个 JSON `DrawOp`；查看 `lib.rs:1669-1677` 与 `pocket_model.dart:175-182` 可确认像素资源按 JSON 数组编码。
- **最小修复建议**：至少将 `FrameResource.pixels` 改为直接通过 FFI 二进制指针/长度借用（或 base64），并将 `DrawOp` 列表迁移为紧凑二进制 buffer（TypedData `Float32List`/`Uint32List` 视图）读取，仅保留 `events` 走 JSON 或 duplex 通道。

---

### P1-4：Editor 本地服务在请求未携带 `Origin` 头时可绕过构建/发布/上传接口的 CSRF 校验

- **文件与行号**：
  - `sdk/editor/server.ts:732-748`（`validateRequestSecurity`）
  - `sdk/editor/server.ts:931-965`（`POST /api/projects/:id/assets`、`/build`、`/publish`）
- **触发条件**：本地 `127.0.0.1:4680` Editor 服务运行期间，攻击者页面通过不发送 `Origin` 头的上下文（例如 `<meta name="referrer" content="no-referrer">` 配合 `<form method="POST" enctype="multipart/form-data">` 或 data/sandboxed iframe）向 `http://127.0.0.1:4680/api/projects/:id/build`、`/publish` 或 `/assets` 发起跨站请求。
- **影响**：
  - `validateRequestSecurity`（`server.ts:738-744`）仅在 `if (originHeader)` 非空时校验 `Origin`。
  - 对于 `/api/projects/:id/build` 和 `/api/projects/:id/publish`，路由不调用 `readJson()`（因此不触发 `Content-Type: application/json` 校验）；对于 `/api/projects/:id/assets`，其本身接受表单 `multipart/form-data`。当 `Origin` 头缺失时，这三个状态变更接口会直接执行构建、使用本地开发私钥签名发布热更新包或上传资源文件。
- **验证证据**：阅读 `server.ts:738-744` 与 `server.ts:931-965`。
- **最小修复建议**：对所有非 `GET`/`HEAD` 的变更请求，强制要求存在且合法的 `Origin` 头，或者要求自定义请求头（如 `X-Pocket-Editor: 1`，迫使浏览器必须发起 CORS 预检并携带 `Origin`）。

---

### P1-5：SDK 强绑定 `pocket_hardware`，且 iOS 真机与模拟器共用单一路径 `libpocket_flutter.a` 互相覆盖

- **文件与行号**：
  - `sdk/pubspec.yaml:11-16`
  - `sdk/lib/pocket_sdk.dart:1-21`
  - `sdk/scripts/build_native.sh:33-50`
  - `sdk/pocket.ts:409-432`
- **触发条件**：
  1. 外部 Flutter 工程集成 `pocket_sdk` 但设置 `enableHardware: false`（不需要相机/蓝牙/定位/生物识别原生库）；
  2. 开发者在真机（`ios`）与 iOS 模拟器（`ios-sim`）之间切换运行，或多个消费工程共用同一份 `sdk/` 目录。
- **影响**：
  1. `sdk/pubspec.yaml:11-16` 无条件依赖 `pocket_hardware`，导致 Flutter 插件注册表在编译期强制将相机、BLE、定位、传感器等原生代码链接进所有宿主 App。
  2. `build_native.sh:33-50` 将 `aarch64-apple-ios` 和 `aarch64-apple-ios-sim` 的静态库输出到同一个文件路径 `packages/pocket_flutter/ios/Frameworks/libpocket_flutter.a`，未使用 `.xcframework`，切换目标时必覆盖。
  3. `pocket.ts:414` 将构建印记写入共享 SDK 目录下的 `sdk/.pocket-build/sdk-native/current.json`。
- **验证证据**：检查 `build_native.sh:33-50` 与 `sdk/pubspec.yaml:11-16`。
- **最小修复建议**：将 `pocket_hardware` 从 `pocket_sdk` 核心包拆分为可选扩展（或保留 `pocket_sdk` 仅依赖 `pocket_flutter` + `pocket_services`）；iOS 原生构建改为生成 `pocket_flutter.xcframework`（同时包含 `ios-arm64` 与 `ios-arm64_x86_64-simulator`）。

---

### P2-1：直接运行 `cargo test` 或 `bun test` 会因缺少环境变量前置条件而失败

- **文件与行号**：
  - `sdk/native/src/lib.rs:3978-3992`（`smoke_tests` 要求 `POCKET_TEST_ASSETS` 与 `POCKET_TEST_SOURCE`）
  - `sdk/packages/pocket_ui/test/flutter_widgets_native.test.ts:22-26`（要求 `POCKET_WIDGET_FIXTURE_DIR`）
  - `sdk/package.json:13-21`（缺少顶层 `"test"` 脚本）
- **触发条件**：在 `sdk/native` 下直接运行 `cargo test`，或在 `sdk/` 下直接运行 `bun test` / `bun run test`。
- **影响**：`cargo test` 默认因 `NotPresent` panic 失败 3 个测试；`bun test` 因 `POCKET_WIDGET_FIXTURE_DIR` 未设置抛错失败 1 个测试；`bun run test` 因缺少 `"test"` script 直接报错退出。
- **验证证据**：见本文第 5 节实际运行输出。
- **最小修复建议**：在 `flutter_widgets_native.test.ts` 未传 `POCKET_WIDGET_FIXTURE_DIR` 时自动调用 `build_guest.ts` 编译 `test/fixture` 到临时目录；在 `sdk/package.json` 增加串联全套测试的 `"test"` 脚本。

---

### P2-2：`@pocket/ui` 中的 `graphics.ts` 仅产出脱离真实渲染链的旧算子（`line` / `arc`）

- **文件与行号**：
  - `sdk/packages/pocket_ui/src/graphics.ts:1-200`
  - `sdk/packages/pocket_ui/src/index.ts:29-37`
- **触发条件**：消费方从 `@pocket/ui` 导入并调用 `compute3dMechaFrame` 或 `compute2dParticleFrame`。
- **影响**：这两个函数返回 `{ op: "line", ... }` 和 `{ op: "arc", ... }`，对应旧工程 C 沙盒里的 `OP_LINE` / `OP_ARC`，但当前 SDK 的 Rust 渲染器（`DrawOp`）与 Flutter `PocketCanvasPainter`（`pocket_view.dart:2796-3150`）根本不存在 `line` 或 `arc` 原语，无法进入真实渲染链。
- **验证证据**：在 `sdk/native` 与 `sdk/packages/pocket_flutter` 中搜索 `"line"` / `"arc"` 绘制分支，结果为 0；`demo/js/` 也未使用该文件。
- **最小修复建议**：从 `@pocket/ui` 移除 `compute3dMechaFrame` 与 `compute2dParticleFrame`（或将其改造为生成 `@pocket/ui` 支持的 `View` / `CanvasBlock` 节点），仅保留有实际用途的图标规格。

---

### P2-3：相机预览 `hostSurface` 仅支持直角矩形 `ClipRect`，不支持圆角裁剪

- **文件与行号**：
  - `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:1185-1203`（`_buildSurfaceOverlay`）
  - `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:2762-2794`（`_splitCanvasBlocks`）
- **触发条件**：开启相机预览（`hostSurface` -> Flutter `Texture` widget）并为预览容器设置圆角或放置多个 `hostSurface`。
- **影响**：`_splitCanvasBlocks` 能正确保证 `hostSurface` 之后的 `DrawOp` 绘制在 `Texture` 之上，但每个 `hostSurface` 都会把 `CustomPaint` 切分成独立的 `_CanvasBlock` widget；且 `hostSurface` 自身的 `clipRect` 仅使用直角 `ClipRect`，未应用容器圆角。
- **验证证据**：查看 `pocket_view.dart:1187-1203`，仅使用了 `ClipRect` 而非带圆角的裁剪。
- **最小修复建议**：在 `hostSurface` DrawOp 中透传容器 `radius` 并在 `_buildSurfaceOverlay` 中当 `radius > 0` 时使用 `ClipRRect`。

---

### P2-4：iOS Deep Link 依赖 `pocket.ts` 向宿主 `SceneDelegate.swift` 注入代码，未通过 Flutter Plugin 生命周期自动挂载

- **文件与行号**：
  - `sdk/pocket.ts:238-320`（`patchIosSceneDelegate`）
  - `sdk/packages/pocket_hardware/ios/Classes/PocketHardwarePlugin.swift:1-35`
- **触发条件**：第三方已有 Flutter 工程仅通过 `flutter pub add` / `pubspec.yaml` 引入 `pocket_sdk`，而未对其 `ios/Runner/SceneDelegate.swift` 执行 `bun pocket.ts init/build` 的源码补丁。
- **影响**：iOS 端 Deep Link 捕获依赖 `SceneDelegate.swift` 显式调用 `PocketHardwareManager.shared.handleIncomingDeepLink(url)`，若宿主工程未运行 `pocket.ts` 补丁脚本，则 iOS Deep Link 不会触发。
- **验证证据**：查看 `PocketHardwarePlugin.swift:1-35` 与 `pocket.ts:238-320`。
- **最小修复建议**：在 `PocketHardwarePlugin.swift` 中实现 `FlutterApplicationLifeCycleDelegate` 的 `application(_:open:options:)` 与 Universal Links 回调，通过 `registrar.addApplicationDelegate(instance)` 自动挂载，将 `SceneDelegate` 补丁降级为可选增强。

---

## 2. 能力矩阵（Capability Matrix）

| 能力领域 | 公开入口 | 生产调用链 | iOS 状态 | Android 状态 | 测试证据 | 剩余缺口 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1. SDK 集成与脚手架** | `sdk/lib/pocket_sdk.dart` (`PocketApp`, `PocketGuest`, `PocketSession`)；CLI `sdk/pocket.ts` (`init`, `build`) | `PocketApp` -> `PocketSession` -> `PocketView` + `PocketHost` + `PocketPluginManager` + `PocketUpdateCoordinator` | 已验证（Podfile / Info.plist / SceneDelegate 自动幂等补丁） | 已验证（AndroidManifest 权限与 `minSdk` 幂等补丁） | `check_architecture.py` 通过；`tooling_scene.test.ts`、`android_scaffold.test.ts`、`session_integration_test.dart` 通过 | `pocket_sdk` 强依赖 `pocket_hardware`（P1-5）；iOS 静态库未打包为 `.xcframework`（P1-5） |
| **2. QuickJS 预编译字节码与 PAK** | `sdk/scripts/build_guest.ts`；`sdk/native/src/bin/pocketjs_bytecode.rs`；`PocketBytecodeArtifact` | TS/TSX -> PocketJS 两阶段编译 -> `app.pak` + `app.js` -> `rquickjs` `Context::compile` 产出 `PJSB` v2 字节码 (`app.qjbc`) -> 运行时 `pocket_load_bytecode_files` 校验魔数/SHA-256/Engine ABI 后执行（无源码回退） | 真实 QuickJS 字节码（非机器码 AOT，亦非源码加头） | 真实 QuickJS 字节码（非机器码 AOT，亦非源码加头） | `cargo test` 字节码篡改/截断/ABI 拒绝测试通过；`guest_ablation.ts` 证明修改字节码直接改变首帧输出 | `build_guest.ts` 未从 `editor.json` 提取 `version`/`build` 写入 `app.bytecode.json`（P1-1） |
| **3. 热更新与版本控制** | `PocketUpdateCoordinator`；`PocketPackageStore`；`sdk/scripts/serve_updates.ts` | `checkAndDownload` -> Ed25519 验签 + AppId/Channel/ABI/Build 准入 -> 下载并校验逐条目 SHA-256 -> 重建 PAK -> 原子指针切换 (`current.json`/`previous.json`) -> `reloadGuest` -> 首帧成功后 `commitHealthy`（失败则 `rollback` 并拉黑坏 build） | 完整支持 | 完整支持 | `package_update.test.ts` (10 项)、`security_and_plugins_test.dart`、`plugin_admission_test.dart` 全部通过 | 因 P1-1，初始内置包 `embeddedBuild` 为 `0`，首次更新前 `minimumBuild` 为 `0` |
| **4. 外部插件注册与权限准入** | `PocketPlugin`；`PocketPluginManager` | `PocketAppConfig.plugins` -> `PocketPluginManager.activate` -> 校验 `guest-manifest.json` 的 capabilities/permissions 与宿主 `allowedPermissions` -> 注册 `PocketHost` handler | 完整支持 | 完整支持 | `plugin_admission_test.dart`、`session_integration_test.dart` 通过 | 权限按整插件合并而非按方法隔离；`revokeCapabilities` 未同步更新 `host.guestAvailability`（P0-2） |
| **5. 相机、相册与二维码** | JS: `hardware.camera.previewStart` / `Stop` / `SwitchLens` / `Capture` / `QrScan`、`hardware.photos.save`、`hardware.media.pickImages` | JS `requestHost` -> `HardwarePlugin` -> MethodChannel `pocket.dev/hardware` -> 原生 Texture 注册 + `authorizeSurface("hardware.camera", textureId)` -> `PocketView` `Texture` 渲染 | 真实实现（`PocketHardwareManager.swift`：`AVCaptureSession` + `FlutterTexture` + `VNDetectBarcodesRequest` + `PHPhotoLibrary` + `PHPickerViewController`） | 真实实现（`CameraHardware.kt`：`Camera2` + `SurfaceTextureEntry` + MLKit/ZXing 扫码 + `MediaStore` + `PickMultipleVisualMedia`） | `hardware_plugin_test.dart` (12 项)、`pocket_surface_test.dart` 通过（含停用后异步晚到纹理拦截） | 真机相机纹理与权限弹窗需在物理 iPhone/Android 设备验证；`hostSurface` 仅支持直角 `ClipRect`（P2-3） |
| **6. 定位、天气、传感器、BLE、生物识别、安全存储、音频** | JS: `hardware.location.current`、`hardware.weather.current`、`hardware.sensors.sample`、`hardware.ble.scan`、`hardware.biometrics.authenticate`、`hardware.storage.*`、`hardware.audio.recordSample` | JS `requestHost` -> `HardwarePlugin` -> MethodChannel `pocket.dev/hardware`（天气由 Dart `HttpClient` 请求 Open-Meteo 真实接口并结合原生 GPS/气压计） | 真实实现（`CLLocationManager`、`CMMotionManager`/`CMAltimeter`、`CBCentralManager`、`LAContext`、Keychain、`AVAudioRecorder`；不可用时返回结构化错误而非假成功） | 真实实现（`LocationManager`、`SensorManager`、`BluetoothLeScanner`、`BiometricPrompt`、`EncryptedSharedPreferences`/Keystore、`AudioRecord`；不可用时返回结构化错误） | `hardware_plugin_test.dart`、`hardware_platform.test.ts` 通过 | `hardware.permissions.request` 缺少权限声明校验，`weather.current` 缺省坐标分支未校验定位权限（P0-2） |
| **7. JS UI 组件库与 Liquid Glass 渲染** | `@pocket/ui`（`mobile.tsx` 38 个移动组件 + `flutter-widgets.tsx` + `theme.ts`） | Solid JSX -> `@pocketjs/framework` 布局引擎 -> Rust `DrawOp` (`rect`, `text`, `image`, `tileset`, `texQuad`, `filter`, `hostSurface`, `textInput`) -> Flutter `PocketCanvasPainter` | 完整支持（无第二套 Dart VDOM） | 完整支持（无第二套 Dart VDOM） | `mobile_ui.test.ts`、`flutter_widgets.test.ts`、`flutter_widgets_native.test.ts`、`pocket_renderer_test.dart` 通过 | `graphics.ts` 中的 3D 机甲/粒子函数产出孤立算子未接入渲染器（P2-2） |
| **8. 系统输入（键盘/IME/焦点/选区）与自适应（Duo/折叠屏/安全区）** | `<Input>` (`textInput` DrawOp) -> `_PocketViewState`；`DisplayGeometry` (`viewport.safeArea`) | Rust 汇总 `textInput` 几何与样式 -> Flutter 透明 `TextField` 覆盖层承接系统 IME/中文 composing/选区/剪贴板 -> `input.change`/`input.submit` 回传 JS；`MediaQuery` safeArea/hinge/displayFeatures -> `viewport.safeArea` 增量合并 | 完整支持（含键盘避让与 composing 保护，不因键盘弹出丢失焦点） | 完整支持（支持折叠屏 hinge 双栏自适应） | `pocket_view_test.dart` (8 项，含 UTF-16、upstream 亲和性、composing、键盘弹出不失焦)、`mobile_ui.test.ts` 通过 | 实机旋转与双屏开合动画流畅度需真机进一步压测 |
| **9. 调度与性能统计** | `PocketPerformanceTracker`；`pocket_frame_delta` | Flutter `Ticker` -> `pocket_frame_delta`（连续 6 帧 `unchanged` 自动停表）+ `SchedulerBinding.addTimingsCallback` 真实采样（区分 idle gap 与真实掉帧） | 支持 | 支持 | `pocket_performance_test.dart`、`performance_history_test.dart` 通过 | 停表后无 JS timer 唤醒机制（P1-2）；变化帧仍全量 JSON 序列化 DrawList 与像素（P1-3） |
| **10. 双向 Lock-Free SPSC 通道** | Rust: `duplex.rs`；Dart: `PocketDuplexChannel`、`runtime.openDuplex()`；JS: `__pocketOnDuplex` / `__pocketEmitDuplex` | `PocketDuplexEndpoint` -> FFI `isLeaf: true` `reserve`/`commit` (`Acquire`/`Release` 原子序 + `Arc` 保活 + generation 隔离) -> `build_frame` 内 `drain_duplex` -> QuickJS 回调 | 原生层与 FFI 已就绪，**生产 UI 未调用** | 原生层与 FFI 已就绪，**生产 UI 未调用** | `duplex_layout.rs` (6 项并发/回绕/竞态测试)、`lib.rs` (5 项 duplex 集成测试)、`pocket_duplex_test.dart`、`pocket_duplex_ffi_test.dart` 全部通过 | **尚未接入 `PocketView` 生产输入与事件循环（P0-1）** |
| **11. Editor 与热更新发布台** | `sdk/editor/server.ts` | Loopback HTTP 服务 -> 项目创建/外部项目挂载 -> 真实调用 `build_guest.ts` 编译 `.qjbc` -> 调用 `package_update.ts` Ed25519 签名发布 -> 托管 `/updates/:channel/latest.json` 与 `/blobs/:sha256` | 开发宿主机服务已闭环 | 开发宿主机服务已闭环 | `editor_server.test.ts` (4 项端到端测试) 通过 | 请求省略 `Origin` 头时 `/build`、`/publish`、`/assets` 可被跨站触发（P1-4） |

---

## 3. 旧项目技术复用与遗漏清单（对照 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`，排除 `pocket_host/`）

### 3.1 已完整继承并升级为真实生产实现的技术
1. **iOS 原生硬件能力桥（`PocketRealHardwareManager` -> `PocketHardwareManager.swift` + Android 对齐实现）**：
   - 旧工程仅在 `ios/Runner/AppDelegate.swift` 与 `lib/core/real_hardware_bridge.dart:68-549` 中实现了 iOS 单端硬件调用，且失败时会静默回退到假权限通过（如 `real_hardware_bridge.dart:119` `hwRequestPermission(..., grant: true)`）。
   - 当前 SDK 完整复用了相机（`AVCaptureSession` + `FlutterTexture`）、扫码、相册、CoreLocation、CoreMotion/气压计、CoreBluetooth、LocalAuthentication、Keychain、AVAudioRecorder 与 Open-Meteo 实时天气，**补齐了 Android `Camera2`/BLE/传感器/生物识别对等实现**，并消除了静默伪造成功的 fallback。
2. **移动端设计系统、Liquid Glass 材质配方与 4 种转场数学模型（`pocketjs_uikit.js` / `pocket_syslib_router.js` -> `sdk/packages/pocket_ui/src/mobile.tsx`）**：
   - 继承了旧工程的明暗主题 token、Liquid Glass 高光/折射参数及 4 种页面转场曲线（`ios_spring_parallax`、`shared_axis_z`、`liquid_glass_morph`、`portal_expand`），但改为在 JS 侧直接驱动真实 PocketJS 节点树，不再依赖 Dart 侧组件解释器。
3. **按需渲染与真实帧耗时监控思想（`perf_monitor.dart:29-130` -> `pocket_performance.dart:1-210`）**：
   - 继承了 `SchedulerBinding.addTimingsCallback` 帧耗时采样与静止休眠思想，并去除了旧工程里写死在代码中的宣传文案与初始固定 60.0 假历史数组。

### 3.2 仅迁入接口/模块、但尚未接通生产调用链的能力
1. **双向 Lock-Free SPSC 环形通道（旧 `pocket_runtime_multi.h:78-97` -> 新 `duplex.rs` + `pocket_duplex.dart`）**：
   - 旧工程的 `PocketSharedDuplexChannel` 只是普通非原子结构体拷贝；当前 SDK 用 Rust 真正实现了带 `CachePadded<AtomicU32>`、`Acquire`/`Release` 内存序、SPSC 角色独占与 `Arc` 生命周期保护的无锁通道，并接通了 `rquickjs` 的 `__pocketOnDuplex` / `__pocketEmitDuplex`。
   - **未接通处**：如 **P0-1** 所述，`PocketView` 与 Showcase 尚未调用 `runtime.openDuplex()`，生产事件仍走 JSON。
2. **图形辅助函数与 SVG 规格（旧 `pocket_syslib_graphics.js` -> 新 `sdk/packages/pocket_ui/src/graphics.ts`）**：
   - 如 **P2-2** 所述，`compute3dMechaFrame` 与 `compute2dParticleFrame` 仅被单元测试调用，其产出的 `line`/`arc` 算子在当前 Rust/Flutter 渲染器中无对应消费端。

### 3.3 旧项目中值得参考但当前仍缺失（或未完成闭环）的技术
1. **紧凑二进制 DrawList 传输协议（参考旧 `pocket_runtime_multi.c:8-17` `BinaryDrawCmd` 思想）**：
   - 旧工程虽然没有真实 JS 引擎，但其 C -> Dart 绘制指令采用了定长二进制 buffer 而非大体积 JSON 字符串。当前 SDK 在变化帧上仍将全部 `DrawOp` 和纹理 `pixels` 序列化为 UTF-8 JSON（见 **P1-3**），在复杂动态页面上应引入二进制 DrawList / 像素零拷贝视图。
2. **页面栈后台冻结（Freeze-on-Push）与滚动位置保持的框架级封装**：
   - 旧工程在宿主层维护了页面栈冻结与滚动偏移恢复概念；当前 SDK 已将路由交还给 JS，但 `@pocket/ui` 尚未提供开箱即用的多级页面栈 keep-alive（保留后台页面子树布局与 `ScrollView` 偏移而不重复参与每帧 diff）组件封装。

### 3.4 已正确排除的旧项目模拟实现与重复方案（严禁回迁）
1. **伪 `.pjc` 字节码编译器（`tools/compile_pocket_syslib_aot.py:41-125`）**：旧工程仅用正则去掉 JS 注释后拼上 52 字节 `PJCA` 头部冒充 AOT 字节码，并在构建期用宿主机 Node.js 预跑出静态 VDOM JSON（`syslib_flutter_ui_vdom.aot.json`）。当前 SDK 已彻底替换为真实 QuickJS `PJSB` 字节码编译。
2. **不含 JS 引擎的 C 状态数组沙盒（`native/pocket_runtime_multi.c:19-142`）**：旧工程 C 库根本没有链接 QuickJS，只用 C 全局数组模拟节点和沙盒状态。当前 SDK 已彻底排除。
3. **第二套 Dart 侧 VDOM 与 4000 行宿主业务渲染器（`lib/render/pocket_ui_components.dart`、`lib/core/pocketjs_bundle_runner.dart`）**：旧工程在 Dart 侧硬编码了页面蓝图与 Flutter Widget 映射树，违背了“Flutter 仅作最薄绘制宿主”的架构目标。当前 SDK 已完全清除（由 `check_architecture.py` 守卫）。
4. **失败时自动伪造成功的硬件/权限兜底（`lib/core/real_hardware_bridge.dart:119`）**：旧工程在异常或模拟器不支持时强制返回 `grant: true` 和模拟硬件数据。当前 SDK 已改为严格返回结构化错误码。

---

## 4. 可删除或合并的冗余设计及验证方式

| 序号 | 冗余位置 | 冗余原因 | 消融/合并方案 | 验证方式与判定标准 |
| :--- | :--- | :--- | :--- | :--- |
| **1** | `sdk/packages/pocket_ui/src/graphics.ts:88-200` 中的 `compute3dMechaFrame` 与 `compute2dParticleFrame`（及 `graphics.test.ts` 对应断言） | 从旧工程 `pocket_syslib_graphics.js` 机械迁入；产出的 `{ op: "line" }` / `{ op: "arc" }` 在 Rust 渲染器与 `PocketCanvasPainter` 中无任何消费逻辑，`demo/js` 亦未使用。 | 删除 `compute3dMechaFrame`、`compute2dParticleFrame` 及相关类型导出（或仅保留 `POCKET_SVG_ICON_SPECS`）。 | 删除后运行 `bun sdk/scripts/build_guest.ts` 编译 `demo/js`、`bun test` 与 `native_guest_probe.ts --required`，构建产物与渲染帧 100% 不变。 |
| **2** | `FfiPocketRuntime`（`pocket_runtime.dart:186-194`）中的全量 `frameAt` / `pocket_frame` 路径与 `frameDeltaAt` / `pocket_frame_delta` 并存 | `PocketView._onTick`（`pocket_view.dart:868`）在生产环境中只调用 `pocketFrameDeltaAt`；`pocket_frame` 与 `pocket_frame_delta` 在帧发生变化时返回完全相同的全量 JSON。 | 将 `frameAt` 合并为基于 `frameDeltaAt` 的薄包装（或在 FFI 层仅保留单一帧拉取入口并通过参数控制是否跳过未变化帧）。 | 移除独立 `pocket_frame` FFI 绑定后运行 `flutter test`（`pocket_flutter`、`sdk`、`demo`）全部通过。 |
| **3** | `sdk/pocket.ts:505-521` 生成的双份配置文件：`editor.json` 与 `guest-manifest.json` | 职责分裂且字段不一致：`version`/`build`/`appId`/`channel` 在 `editor.json`，而 `capabilities`/`permissions` 在 `guest-manifest.json`，直接诱发了 **P1-1**（`build_guest.ts` 找不到 `build` 号）。 | 允许 `guest-manifest.json`（或统一的 `pocket.json`）作为单一真实数据源承载 `version`/`build` 与 `capabilities`/`permissions`，`build_guest.ts` 与 `package_update.ts` 统一从中读取。 | 合并后运行 `bun test scripts/tests/package_update.test.ts` 与 `editor/test/editor_server.test.ts`，并验证产出的 `app.bytecode.json` 内含正确的非零 `build` 与 `version`。 |

---

## 5. 实际运行的检查、结果和未覆盖范围

本次审核在 `/Volumes/ORICO/Development/Github/pocket`（`a5dd273`）上实际执行了以下只读检查与测试（**严格区分默认执行、带环境变量执行与 skipped，未将任何 skipped 计为通过**）：

### 5.1 实际执行的命令与结果汇总

| 检查项 | 执行命令 | 实际结果 | 备注 / 发现 |
| :--- | :--- | :--- | :--- |
| **架构边界静态守卫** | `cd sdk && python3 scripts/check_architecture.py` | **PASS** (exit 0) | 确认 SDK 无反向依赖 `demo/`，无遗留业务渲染器。 |
| **Rust 原生层单元测试（默认无环境变量）** | `cargo test --locked --manifest-path sdk/native/Cargo.toml` | **11 passed, 3 FAILED** (exit 101) | 3 个 smoke test 因未设置 `POCKET_TEST_ASSETS` 和 `POCKET_TEST_SOURCE` 直接 panic（见 **P2-1**）。 |
| **Rust 原生层完整测试（传入真实产物路径）** | `POCKET_TEST_ASSETS=$PWD/demo/assets POCKET_TEST_SOURCE=$PWD/demo/js/.pocket-build/app.js cargo test --locked --manifest-path sdk/native/Cargo.toml` | **20 passed, 0 failed, 1 ignored** (exit 0) | `lib.rs` 14 项全部通过（含字节码防篡改、无源码回退、duplex 5 项测试）；`duplex_layout.rs` 6 项通过，1 项手工吞吐基准（`throughput_report_lock_free_vs_mutex_baseline`）为 `ignored`。 |
| **SDK TS/Bun 测试套件（默认直接运行）** | `cd sdk && bun test` | **16 pass, 1 FAIL** (exit 1) | `build_guest.test.ts` (2)、`tooling_scene.test.ts`、`android_scaffold.test.ts`、`package_update.test.ts` (10)、`editor_server.test.ts` (4)、`flutter_widgets.test.ts`、`graphics.test.ts` 通过；`flutter_widgets_native.test.ts` 因缺少 `POCKET_WIDGET_FIXTURE_DIR` 报错失败（见 **P2-1**）。 |
| **SDK `@pocket/ui` 原生 Widget 探针测试（带临时构建目录）** | `POCKET_WIDGET_FIXTURE_OUTDIR=$TMP bun packages/pocket_ui/test/flutter_widgets.test.ts && POCKET_WIDGET_FIXTURE_DIR=$TMP bun test packages/pocket_ui/test/flutter_widgets_native.test.ts` | **PASS** (exit 0) | 通过 `pocket_probe` 真实执行 QuickJS 字节码验证了 pointer 回调、disabled 拦截与选中样式。 |
| **Showcase JS 单元测试** | `cd demo/js && bun test` | **11 pass, 0 fail** (exit 0) | 覆盖 `mobile_ui.test.ts` (4)、`hardware_platform.test.ts` (2)、`guest_state.test.ts` (5)。 |
| **Showcase 原生 QuickJS 字节码探针与消融测试** | `cd demo/js && bun tests/native_guest_probe.ts --required && bun tests/guest_ablation.ts --required` | **PASS** (exit 0) | 真实加载 `demo/assets/app.qjbc` + `app.pak` 跑通首帧、指针、输入、100/500 节点压测，并通过修改字节码消融验证首帧输出随之改变。 |
| **`pocket_flutter` 测试（默认运行）** | `cd sdk/packages/pocket_flutter && flutter test` | **36 passed, 1 SKIPPED** (exit 0) | **注意**：默认未设置 `POCKET_NATIVE_LIBRARY` 时，`pocket_duplex_ffi_test.dart` 被 **SKIP**，不能算通过。 |
| **`pocket_flutter` 原生 Duplex FFI 测试（显式指定 dylib）** | `cd sdk/packages/pocket_flutter && POCKET_NATIVE_LIBRARY=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/debug/libpocket_flutter.dylib flutter test test/pocket_duplex_ffi_test.dart` | **1 passed, 0 skipped** (exit 0) | 真实加载 `libpocket_flutter.dylib`，验证了 Dart FFI leaf 调用与 Rust ABI v2 SPSC 环形通道的端到端发布、消费与关闭。 |
| **`pocket_services` 单元测试** | `cd sdk/packages/pocket_services && flutter test` | **18 passed, 0 skipped** (exit 0) | 覆盖签名校验、并发 `prepare`、降级拦截、坏包拉黑回滚、路径穿越拦截、插件准入。 |
| **`sdk` 顶层会话集成测试** | `cd sdk && flutter test` | **4 passed, 0 skipped** (exit 0) | 覆盖 `PocketSession` 外部插件接入、生命周期关闭与组件重建保持。 |
| **`demo` 宿主与硬件插件测试** | `cd demo && flutter test` | **17 passed, 0 skipped** (exit 0) | 覆盖 `hardware_plugin_test.dart` (12 项) 与 `performance_history_test.dart` (5 项)。 |

### 5.2 未覆盖范围与剩余不确定性

1. **iOS / Android 物理真机端到端验证未在本次只读命令行审核中执行**：
   - 虽然已通过源码核实了 `PocketHardwareManager.swift`、`PocketHardwarePlugin.kt` 和 `CameraHardware.kt` 的真实系统 API 调用链，但相机 `FlutterTexture` / `SurfaceTextureEntry` 帧率、CoreBluetooth/Android BLE 扫描广播、FaceID/BiometricPrompt 系统弹窗及 iPhone 物理键盘弹出动画仍需在连接的 iOS/Android 真机上做最终验收。
2. **macOS 桌面宿主全量热更新集成测试（`demo/integration_test/update_lifecycle_test.dart`）**：
   - `demo/js/scripts/test_updates.ts` 会执行 `dev_updates.ts setup` 并在 `demo/.pocket-updates` 下重写构建产物并拉起 `flutter test -d macos`。为严格遵守本次审核“不修改文件、不清缓存、不覆盖其他改动”的只读约束，未运行该会写入工作区的脚本；热更新核心状态机与本地 HTTP 更新服务已通过无副作用的 `package_update.test.ts` 与 `plugin_admission_test.dart` 完整验证。
3. **手工吞吐基准测试**：
   - `sdk/native/tests/duplex_layout.rs:216-218` 中的 `throughput_report_lock_free_vs_mutex_baseline` 标记为 `#[ignore = "manual throughput comparison"]`，默认未运行。
