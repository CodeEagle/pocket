   Pocket SDK 完整代码与运行证据审核报告（目标版本：a5dd273）

  • 被审仓库：/Volumes/ORICO/Development/Github/pocket（当前
  HEAD：a5dd273，工作区干净，全程只读审核，未修改/删除任何文件或缓存）
  • 对照旧工程：/Volumes/ORICO/Development/Github/pocketjs_flutter_demo（已明确排除
  pocket_host/，仅做源码调用链对照，未运行或重建）
  ──────
  ## 总体判断

  在 a5dd273 版本上，Pocket 已经确立了正确的核心底座：Flutter 薄宿主 + Rust rquickjs
  真实预编译字节码（PJSB v2 envelope + SHA-256 + QuickJS engine ABI 校验）+ @pocket/ui
  Solid/PocketJS primitives + Ed25519 签名热更新 +
  平台原生硬件插件（iOS/Android），并且没有回退到旧工程的第二套 Dart VDOM 或伪 .pjc 源码打包。

  但从生产实际调用链而非孤立单元测试来看，a5dd273 仍存在 2 项 P0（生产调用链未接通 /
  权限隔离失效与整包误杀）、5 项 P1（内嵌版本 build 恒为 0、Ticker 休眠冻结 JS 定时器、每帧全量
  JSON 序列化、Editor 无 Origin CSRF 绕过、iOS 单架构产物覆盖） 和 4 项 P2 问题：

  1. 双向 Lock-Free SPSC 通道（duplex.rs / pocket_duplex.dart）虽已实现并通过独立测试，但未接入
  PocketView / PocketSession / Showcase
  的生产输入与事件主循环——线上指针、文本输入、安全区和宿主消息仍 100% 走 JSON（jsonEncode ->
  pocket_send）。
  2. 插件权限模型按“整插件聚合”而非“按方法隔离”，且 hardware.permissions.request 声明了空权限集
  {}——既会导致可选硬件能力未声明权限时将整个 HardwarePlugin 连坐吊销（甚至炸穿 guest
  启动），又允许未获授权的 guest 直接调用 hardware.permissions.request 弹出系统权限框，或通过
  hardware.weather.current 绕过 hardware.location 权限读取真实 GPS。
  3. 构建链从 guest-manifest.json 读取 build/version，但该文件只存协议与权限，build 实际存在
  editor.json——导致 demo/assets/app.bytecode.json 及所有 CLI/Editor 产物的 embeddedBuild
  在运行时恒为 0。
  ──────
  ## 1. 按 P0 / P1 / P2 排序的实际问题

  ### P0-1：双向 Lock-Free SPSC 通道仅停留在 Runtime/测试层，未接入 PocketView
  生产输入与事件链路

  • 文件与行号：
      • pocket_view.dart:204-214（PocketViewController.send）
      • pocket_view.dart:1246-1275（_PocketViewState._reportSafeArea）
      • pocket_view.dart:2349-2378（_PocketViewState._sendPointer）
      • pocket_runtime.dart:273-306（FfiPocketRuntime._lookupDuplexBindings）
      • pocket_runtime.dart:365-375（FfiPocketRuntime.openDuplex）
      • lib.rs:1491-1498（build_frame 中的 drain_duplex）
  • 触发条件：运行任何基于 PocketApp / PocketSession / PocketView 的应用（包括 demo/
  Showcase），进行触控拖拽、手势滚动、窗口尺寸更新或宿主消息交互。
  • 影响：
      1. 虽然 duplex.rs:1-489、lib.rs:3276-3544 和 pocket_duplex.dart:1-435 完整实现了 ABI v2 的
      CachePadded<AtomicU32> 单生产者/单消费者无锁环形队列、世代隔离（generation）和
      NativeFinalizer，但全仓库没有任何生产代码调用 runtime.openDuplex()。
      2. 所有高频指针事件（_sendPointer）和视口事件仍逐条经过 Map 分配 -> jsonEncode -> UTF-8
      拷贝 -> pocket_send -> Rust serde_json::from_str。
      3. 次要 FFI 一致性缺陷：_lookupDuplexEndpointBindings 正确标注了 isLeaf: true，但
      FfiPocketRuntime._lookupDuplexBindings 中的
      pocket_duplex_abi_version、pocket_duplex_message_size、pocket_duplex_capacity 漏掉了
      isLeaf: true。
  • 验证证据：在 sdk/ 与 demo/ 中检索 openDuplex / PocketDuplexChannel，调用点仅存在于
  pocket_duplex_test.dart:15-180 与 pocket_duplex_ffi_test.dart:55-115。
  • 最小修复建议：
      1. 在 _PocketViewState._boot 及 reload 成功后调用 _runtime.openDuplex() 获取
      PocketDuplexEndpoint，并在 _PocketViewState.dispose / reload 前 close()。
      2. 将高频数值型消息（如指针移动/按下/抬起或专用数值信令）优先通过 PocketDuplexEndpoint.publishIngress 写入无锁通道，并在每帧 tick 后调用 drainEgress 分发 guest 侧
      __pocketEmitDuplex 消息；在 _lookupDuplexBindings 中补齐 isLeaf: true。

  ──────
  ### P0-2：插件权限按“整插件聚合”而非“按方法校验”，且 hardware.permissions.request 与
  weather.current 可绕过权限声明与宿主准入

  • 文件与行号：
      • pocket_plugin.dart:484-568（PocketPluginManager.activate）
      • pocket_host.dart:164-221（PocketHost.guestAvailability、revokeCapabilities）
      • pocket_session.dart:188-243（PocketSession._configureBridge）
      • hardware_plugin.dart:136-271（HardwarePlugin）
      • hardware_plugin.dart:602-609（HardwarePlugin.weatherCurrent）
  • 触发条件：
      1. Guest 在 guest-manifest.json 中将 hardware.permissions 设为 required，将 hardware.camera.capture 设为 optional，但仅声明了部分权限（或宿主通过 PocketAppConfig.allowedPermissions 仅允许定位而不允许相机）；
      2. Guest 调用 hardware.permissions.request({ permission: "hardware.camera" })
      或不带经纬度调用 hardware.weather.current({})。
  • 影响：
      1. 整插件连坐失败/吊销：PocketPluginManager.activate 将插件下所有 grantedMethods 的
      permissions 合并成单一集合 requiredPermissions，并用 requiredCapability = names.any(availability.required.contains) 判断。只要 HardwarePlugin 中有任意一个 required
      能力（如无需权限的 hardware.permissions），而另一个 optional 能力（如相机）缺少权限，整个
      guest 会直接因 permission_not_declared / plugin_permission_denied 启动失败；若全部是
      optional，则会执行 granted.removeAll(names); host.revokeCapabilities(names)，把已获权限的其它硬件能力一并吊销。
      2. 越权弹窗与越权定位：HardwareCapabilities.requestPermission 的 permissions 声明为 const <String>{}，且 requestPermission 不调用 _checkPermission(permission)；同时
      PocketSession._configureBridge 构造 HardwarePlugin 时根本未传入 grantedPermissions，导致
      _grantedPermissions 为 null、_checkPermission 在生产环境中形同虚设。此外 weatherCurrent
      仅声明 HardwarePermissions.network，但在未传 latitude/longitude 时直接调用
      _native('getCurrentLocation')（第 602-609 行），绕过了 hardware.location 权限检查。
      3. 能力快照失真：PocketHost.revokeCapabilities 只从 _handlers 移除处理器，未更新
      _availability，导致 host.capabilitiesJson() 仍向 guest 报告已被吊销的能力为 granted。
  • 验证证据：阅读 pocket_plugin.dart:489-559 与 pocket_session.dart:188-204 可直接确认调用链。
  • 最小修复建议：
      1. 在 PocketPluginManager.activate 中按**单个 PocketPluginMethod（capability）**独立校验
      method.permissions ?? descriptor.permissions：未声明或未被宿主允许的 optional capability
      仅吊销该 capability 本身，只有当全部 capability 均被吊销时才跳过插件 onActivate。
      2. 在 PocketHost.revokeCapabilities 中同步更新 _availability。
      3. 在 PocketSession._configureBridge 将经 manifest 声明与 config.allowedPermissions
      交集后的权限集合传给 HardwarePlugin(grantedPermissions: ...)；在 requestPermission
      中校验目标 permission 属于已准入集合，在 weatherCurrent 未传坐标分支中校验
      HardwarePermissions.location。

  ──────
  ### P1-1：构建链未将项目 version/build 写入 app.bytecode.json，导致运行时 embeddedBuild 恒为 0

  • 文件与行号：
      • build_guest.ts:404-424
      • pocket.ts:505-521
      • app.bytecode.json:1-13
      • guest-manifest.json:1-44
      • pocket_session.dart:88-92
      • pocket_session.dart:165-173
  • 触发条件：使用 bun sdk/pocket.ts build、sdk/scripts/build_guest.ts 或 Editor
  构建任何工程（包括 demo/），随后启动 PocketSession 并检查 runtime.info
  或执行热更新最低构建号准入（minimumBuild）。
  • 影响：
      1. build_guest.ts:404-424 只尝试从 manifest.json（即 guest-manifest.json）读取 version 和
      build，但 guest-manifest.json 仅包含 protocolVersion、capabilities 和
      permissions（项目版本与构建号实际存放在 editor.json / pocket.json）。
      2. 因此实际生成的 app.bytecode.json:1-13 完全不包含 version 与 build 字段。
      3. PocketSession._initialize 解析出的 embeddedBuild 恒为 0，导致新装 App 首次热更新时
      minimumBuild == 0，无法拦截低于内置包真实构建号的旧热更新包；且 PocketSession.status()
      仍硬编码 'activeBuild': active?.build ?? 0 和 'build': 0。
  • 验证证据：查看 app.bytecode.json:1-13，仅含
  entryFormat、kind、runtimeAbi、bindingGeneration、tickHz、bytecodeBytes、bytecodeSha256、pakBytes、pakSha256、contractSha256、envelopeVersion，无 build 或 version。
  • 最小修复建议：在 build_guest.ts:404-424 中当 manifest.json 未包含 version/build
  时回退读取同目录的 editor.json / pocket.json 并写入 app.bytecode.json；在 PocketSession 中保存
  _embeddedBuild 并在 status() 中返回 active?.build ?? _embeddedBuild。
  ──────
  ### P1-2：PocketView 在连续 6 帧无变化后停止 Ticker，导致 QuickJS
  定时器（setTimeout）与延迟动画冻结

  • 文件与行号：
      • pocket_view.dart:324-336（_wakeTicker）
      • pocket_view.dart:886-891（_onTick）
      • lib.rs:1483-1522（build_frame 推进 __pocketAdvanceTime）
  • 触发条件：Guest 在交互或宿主响应后设置了超过 ~100ms（6 帧 @ 60Hz）才触发的 setTimeout /
  setInterval、防抖状态更新，或通过独立 PocketDuplexEndpoint 推入消息而未经过
  PocketViewController.send。
  • 影响：
      • QuickJS 的虚拟时钟与定时器完全依赖每帧调用 pocket_frame_delta 内的
      __pocketAdvanceTime(dt) 驱动。
      • 当画面连续 6 帧无 DrawList 变化（idleFrames >= 6）时，_onTick 直接执行 _ticker?.stop()。在用户下一次触摸屏幕或宿主主动发送 bridge 消息之前，pocket_frame_delta
      不再被调用，所有大于 100ms 的 JS setTimeout / 轮询 / 延迟动画永久挂起。
  • 验证证据：检查 pocket_view.dart:886-891 与 lib.rs:1483-1522，Rust
  端未向宿主暴露“下一个待执行 timer 到期时间（next timer deadline）”或“是否有活跃动画/timer”。
  • 最小修复建议：在 Rust FrameResult / delta 响应或轻量级 FFI 查询中返回 guest
  是否存在活跃动画或最近一个 timer 的剩余毫秒数 nextTimerMs；若存在活跃动画则保持
  Ticker，若仅有延迟 timer 则在 _ticker?.stop() 时挂载一次性 Dart Timer(Duration(milliseconds: nextTimerMs), _wakeTicker)。
  ──────
  ### P1-3：所有发生变化的帧仍通过 FFI 序列化完整 DrawList 与 RGBA 像素数组为 UTF-8 JSON

  • 文件与行号：
      • lib.rs:1649-1696（FrameResult 与 FrameResource）
      • lib.rs:3219-3251（frame_delta_json_for_host）
      • pocket_runtime.dart:195-210（FfiPocketRuntime.frameDeltaAt）
      • pocket_model.dart:168-185（PocketFrameResource.fromJson）
  • 触发条件：页面滚动、路由转场动画（60fps）、Stress 节点压测（500 节点产生 1761 条
  DrawOp）或首次加载含字体/图集纹理资源的帧。
  • 影响：
      • pocket_frame_delta 仅在 DrawList 与上一帧完全字节一致且无事件/无新资源时返回
      {"unchanged":true}。
      • 一旦帧内有任何一个数字或坐标变化（例如滚动或转场），Rust 就会把整帧全部 DrawOp
      重新序列化为 JSON 字符串（分配 String -> CString），Dart UI 线程再 toDartString() +
      jsonDecode 生成数千个 Map 对象。
      • 更严重的是，FrameResource.pixels: Vec<u8> 被 serde_json 序列化为十进制数字数组 [255,0,128,...]，Dart 侧再逐个 (item as num).toInt() 转回 Uint8List。
  • 验证证据：native_guest_probe.ts:500-530 实测 500 节点时单帧产生 1761 个 JSON DrawOp；查看
  lib.rs:1669-1677 与 pocket_model.dart:175-182 可确认像素资源按 JSON 数组编码。
  • 最小修复建议：至少将 FrameResource.pixels 改为直接通过 FFI 二进制指针/长度借用（或
  base64），并将 DrawOp 列表迁移为紧凑二进制 buffer（TypedData Float32List/Uint32List
  视图）读取，仅保留 events 走 JSON 或 duplex 通道。
  ──────
  ### P1-4：Editor 本地服务在请求未携带 Origin 头时可绕过构建/发布/上传接口的 CSRF 校验

  • 文件与行号：
      • server.ts:732-748（validateRequestSecurity）
      • server.ts:931-965（POST /api/projects/:id/assets、/build、/publish）
  • 触发条件：本地 127.0.0.1:4680 Editor 服务运行期间，攻击者页面通过不发送 Origin
  头的上下文（例如 <meta name="referrer" content="no-referrer"> 配合 <form method="POST" enctype="multipart/form-data"> 或 data/sandboxed iframe）向 http://127.0.0.1:4680/api/projects/:id/build、/publish 或 /assets 发起跨站请求。
  • 影响：
      • validateRequestSecurity 仅在 if (originHeader) 非空时校验 Origin。
      • 对于 /api/projects/:id/build 和 /api/projects/:id/publish，路由不调用
      readJson()（因此不触发 Content-Type: application/json 校验）；对于
      /api/projects/:id/assets，其本身接受表单 multipart/form-data。当 Origin
      头缺失时，这三个状态变更接口会直接执行构建、使用本地开发私钥签名发布热更新包或上传资源文件
      。
  • 验证证据：阅读 server.ts:738-744 与 server.ts:931-965。
  • 最小修复建议：对所有非 GET/HEAD 的变更请求，强制要求存在且合法的 Origin
  头，或者要求自定义请求头（如 X-Pocket-Editor: 1，迫使浏览器必须发起 CORS 预检并携带 Origin）。
  ──────
  ### P1-5：SDK 强绑定 pocket_hardware，且 iOS 真机与模拟器共用单一路径 libpocket_flutter.a
  互相覆盖

  • 文件与行号：
      • pubspec.yaml:11-16
      • pocket_sdk.dart:1-21
      • build_native.sh:33-50
      • pocket.ts:409-432
  • 触发条件：
      1. 外部 Flutter 工程集成 pocket_sdk 但设置 enableHardware: false（不需要相机/蓝牙/定位/生物识别原生库）；
      2. 开发者在真机（ios）与 iOS 模拟器（ios-sim）之间切换运行，或多个消费工程共用同一份 sdk/
      目录。
  • 影响：
      1. pubspec.yaml:11-16 无条件依赖 pocket_hardware，导致 Flutter
      插件注册表在编译期强制将相机、BLE、定位、传感器等原生代码链接进所有宿主 App。
      2. build_native.sh:33-50 将 aarch64-apple-ios 和 aarch64-apple-ios-sim
      的静态库输出到同一个文件路径 packages/pocket_flutter/ios/Frameworks/libpocket_flutter.a，未使用 .xcframework，切换目标时必覆盖。
      3. pocket.ts:414 将构建印记写入共享 SDK 目录下的 sdk/.pocket-build/sdk-native/current.json。
  • 验证证据：检查 build_native.sh:33-50 与 pubspec.yaml:11-16。
  • 最小修复建议：将 pocket_hardware 从 pocket_sdk 核心包拆分为可选扩展（或保留 pocket_sdk
  仅依赖 pocket_flutter + pocket_services）；iOS 原生构建改为生成 pocket_flutter.xcframework（同时包含 ios-arm64 与 ios-arm64_x86_64-simulator）。
  ──────
  ### P2-1：直接运行 cargo test 或 bun test 会因缺少环境变量前置条件而失败

  • 文件与行号：
      • lib.rs:3978-3992（smoke_tests 要求 POCKET_TEST_ASSETS 与 POCKET_TEST_SOURCE）
      • flutter_widgets_native.test.ts:22-26（要求 POCKET_WIDGET_FIXTURE_DIR）
      • package.json:13-21（缺少顶层 "test" 脚本）
  • 触发条件：在 sdk/native 下直接运行 cargo test，或在 sdk/ 下直接运行 bun test / bun run test。
  • 影响：cargo test 默认因 NotPresent panic 失败 3 个测试；bun test 因
  POCKET_WIDGET_FIXTURE_DIR 未设置抛错失败 1 个测试；bun run test 因缺少 "test" script
  直接报错退出。
  • 验证证据：见本文第 5 节实际运行输出。
  • 最小修复建议：在 flutter_widgets_native.test.ts 未传 POCKET_WIDGET_FIXTURE_DIR 时自动调用
  build_guest.ts 编译 test/fixture 到临时目录；在 sdk/package.json 增加串联全套测试的 "test"
  脚本。
  ──────
  ### P2-2：@pocket/ui 中的 graphics.ts 仅产出脱离真实渲染链的旧算子（line / arc）

  • 文件与行号：
      • graphics.ts:1-200
      • index.ts:29-37
  • 触发条件：消费方从 @pocket/ui 导入并调用 compute3dMechaFrame 或 compute2dParticleFrame。
  • 影响：这两个函数返回 { op: "line", ... } 和 { op: "arc", ... }，对应旧工程 C 沙盒里的
  OP_LINE / OP_ARC，但当前 SDK 的 Rust 渲染器（DrawOp）与 Flutter PocketCanvasPainter 根本不存在
  line 或 arc 原语，无法进入真实渲染链。
  • 验证证据：在 sdk/native 与 sdk/packages/pocket_flutter 中搜索 "line" / "arc"
  绘制分支，结果为 0；demo/js/ 也未使用该文件。
  • 最小修复建议：从 @pocket/ui 移除 compute3dMechaFrame 与
  compute2dParticleFrame（或将其改造为生成 @pocket/ui 支持的 View / CanvasBlock
  节点），仅保留有实际用途的图标规格。
  ──────
  ### P2-3：相机预览 hostSurface 在部分遮挡（如 BottomSheet / 模态卡片覆盖）时仅支持矩形
  Clip，不支持被上层普通 View 局部遮挡合成

  • 文件与行号：
      • pocket_view.dart:1185-1203（_buildSurfaceOverlay）
      • pocket_view.dart:2762-2794（_splitCanvasBlocks）
  • 触发条件：在开启相机预览（hostSurface -> Flutter Texture widget）时，后续 DrawOp
  按绘制顺序通过 _splitCanvasBlocks 拆分为覆盖在 Texture 之上的 CustomPaint 层。
  • 影响：_splitCanvasBlocks 能正确保證 hostSurface 之后的 DrawOp 绘制在 Texture
  之上（解决了层级顺序问题），但每个 hostSurface 都会把 CustomPaint 切分成独立的 _CanvasBlock
  widget。若页面存在多个 hostSurface，会创建多个全尺寸 CustomPaint 实例；且 hostSurface 自身的
  clipRect 仅支持直角矩形（ClipRect），不支持圆角裁剪（ClipRRect）。
  • 验证证据：查看 pocket_view.dart:1187-1203，仅使用了 ClipRect 而非带圆角的裁剪。
  • 最小修复建议：在 hostSurface DrawOp 中透传容器 radius 并在 _buildSurfaceOverlay 中当 radius > 0 时使用 ClipRRect。
  ──────
  ### P2-4：iOS Deep Link 依赖 pocket.ts 向宿主 SceneDelegate.swift 注入代码，未通过 Flutter
  Plugin 生命周期自动挂载

  • 文件与行号：
      • pocket.ts:238-320（patchIosSceneDelegate）
      • PocketHardwarePlugin.swift:1-35
  • 触发条件：第三方已有 Flutter 工程仅通过 flutter pub add / pubspec.yaml 引入
  pocket_sdk，而未对其 ios/Runner/SceneDelegate.swift 执行 bun pocket.ts init/build 的源码补丁。
  • 影响：iOS 端 Deep Link 捕获依赖 SceneDelegate.swift 显式调用 PocketHardwareManager.shared.handleIncomingDeepLink(url)，若宿主工程未运行 pocket.ts 补丁脚本，则 iOS Deep Link 不会触发。
  • 验证证据：查看 PocketHardwarePlugin.swift:1-35 与 pocket.ts:238-320。
  • 最小修复建议：在 PocketHardwarePlugin.swift:1-35 中实现 FlutterApplicationLifeCycleDelegate
  的 application(_:open:options:) 与 Universal Links 回调， via registrar.addApplicationDelegate(instance) 自动挂载，将 SceneDelegate 补丁降级为可选增强。
  ──────
  ## 2. 能力矩阵（Capability Matrix）

   能力领域   │ 公开入口   │ 生产调用链 │ iOS 状态    │ Android 状… │ 测试证据    │ 剩余缺口
  ────────────┼────────────┼────────────┼─────────────┼─────────────┼─────────────┼─────────────
   1. SDK     │ pocket_sdk │ PocketApp  │ 已验证（Pod │ 已验证（And │ check_archi │ pocket_sdk
   集成与脚手 │ .dart:1-21 │ ->         │ file /      │ roidManifes │ tecture.py  │ 强依赖
   架         │ (PocketApp │ PocketSess │ Info.plist  │ t 权限与    │ 通过；tooli │ pocket_hard
              │ ,          │ ion ->     │ /           │ minSdk      │ ng_scene.te │ ware（P1-
              │ PocketGues │ PocketView │ SceneDelega │ 幂等补丁）  │ st.ts、andr │ 5）；iOS
              │ t,         │ +          │ te          │             │ oid_scaffol │ 静态库未打
              │ PocketSess │ PocketHost │ 自动幂等补  │             │ d.test.ts、 │ 包为
              │ ion)；CLI  │ +          │ 丁）        │             │ session_int │ .xcframewor
              │ pocket.ts: │ PocketPlug │             │             │ egration_te │ k（P1-5）
              │ 1-600      │ inManager  │             │             │ st.dart     │
              │ (init,     │ +          │             │             │ 通过        │
              │ build)     │ PocketUpda │             │             │             │
              │            │ teCoordina │             │             │             │
              │            │ tor        │             │             │             │
   2. QuickJS │ build_gues │ TS/TSX ->  │ 真实        │ 真实        │ cargo test  │ build_guest
   预编译字节 │ t.ts:1-457 │ PocketJS   │ QuickJS     │ QuickJS     │ 字节码篡改/ │ .ts 未从
   码与 PAK   │ ；pocketjs │ 两阶段编译 │ 字节码（非  │ 字节码（非  │ 截断/ABI    │ editor.json
              │ _bytecode. │ -> app.pak │ 机器码      │ 机器码      │ 拒绝测试通  │ 提取
              │ rs:1-165； │ + app.js - │ AOT，亦非源 │ AOT，亦非源 │ 过；guest_a │ version/bui
              │ PocketByte │ > rquickjs │ 码加头）    │ 码加头）    │ blation.ts  │ ld 写入
              │ codeArtifa │ Context::c │             │             │ 证明修改字  │ app.bytecod
              │ ct         │ ompile     │             │             │ 节码直接改  │ e.json（P1-
              │            │ 产出 PJSB  │             │             │ 变首帧输出  │ 1）
              │            │ v2 字节码  │             │             │             │
              │            │ (app.qjbc) │             │             │             │
              │            │ -> 运行时  │             │             │             │
              │            │ pocket_loa │             │             │             │
              │            │ d_bytecode │             │             │             │
              │            │ _files     │             │             │             │
              │            │ 校验魔数/S │             │             │             │
              │            │ HA-        │             │             │             │
              │            │ 256/Engine │             │             │             │
              │            │ ABI        │             │             │             │
              │            │ 后执行（无 │             │             │             │
              │            │ 源码回退） │             │             │             │
   3.         │ PocketUpda │ checkAndDo │ 完整支持    │ 完整支持    │ package_upd │ 因 P1-
   热更新与版 │ teCoordina │ wnload ->  │             │             │ ate.test.ts │ 1，初始内置
   本控制     │ tor；Pocke │ Ed25519    │             │             │ (10         │ 包
              │ tPackageSt │ 验签 +     │             │             │ 项)、securi │ embeddedBui
              │ ore；serve │ AppId/Chan │             │             │ ty_and_plug │ ld 为
              │ _updates.t │ nel/ABI/Bu │             │             │ ins_test.da │ 0，首次更新
              │ s:1-120    │ ild 准入 - │             │             │ rt、plugin_ │ 前
              │            │ >          │             │             │ admission_t │ minimumBuil
              │            │ 下载并校验 │             │             │ est.dart    │ d 为 0
              │            │ 逐条目     │             │             │ 全部通过    │
              │            │ SHA-256 -> │             │             │             │
              │            │ 重建 PAK - │             │             │             │
              │            │ >          │             │             │             │
              │            │ 原子指针切 │             │             │             │
              │            │ 换         │             │             │             │
              │            │ (current.j │             │             │             │
              │            │ son/previo │             │             │             │
              │            │ us.json) - │             │             │             │
              │            │ >          │             │             │             │
              │            │ reloadGues │             │             │             │
              │            │ t ->       │             │             │             │
              │            │ 首帧成功后 │             │             │             │
              │            │ commitHeal │             │             │             │
              │            │ thy（失败  │             │             │             │
              │            │ 则         │             │             │             │
              │            │ rollback   │             │             │             │
              │            │ 并拉黑坏   │             │             │             │
              │            │ build）    │             │             │             │
   4.         │ PocketPlug │ PocketAppC │ 完整支持    │ 完整支持    │ plugin_admi │ 权限按整插
   外部插件注 │ in；Pocket │ onfig.plug │             │             │ ssion_test. │ 件合并而非
   册与权限准 │ PluginMana │ ins ->     │             │             │ dart、sessi │ 按方法隔离
   入         │ ger        │ PocketPlug │             │             │ on_integrat │ ；revokeCap
              │            │ inManager. │             │             │ ion_test.da │ abilities
              │            │ activate - │             │             │ rt 通过     │ 未同步更新
              │            │ > 校验     │             │             │             │ host.guestA
              │            │ guest-     │             │             │             │ vailability
              │            │ manifest.j │             │             │             │ （P0-2）
              │            │ son 的     │             │             │             │
              │            │ capabiliti │             │             │             │
              │            │ es/permiss │             │             │             │
              │            │ ions       │             │             │             │
              │            │ 与宿主     │             │             │             │
              │            │ allowedPer │             │             │             │
              │            │ missions - │             │             │             │
              │            │ > 注册     │             │             │             │
              │            │ PocketHost │             │             │             │
              │            │ handler    │             │             │             │
   5.         │ JS:        │ JS         │ 真实实现（P │ 真实实现（C │ hardware_pl │ 真机相机纹
   相机、相册 │ hardware.c │ requestHos │ ocketHardwa │ ameraHardwa │ ugin_test.d │ 理与权限弹
   与二维码   │ amera.prev │ t ->       │ reManager.s │ re.kt:1-695 │ art (12     │ 窗需在物理
              │ iewStart / │ HardwarePl │ wift:240-62 │ ：Camera2 + │ 项)、pocket │ iPhone/Andr
              │ Stop /     │ ugin ->    │ 0：AVCaptur │ SurfaceText │ _surface_te │ oid
              │ SwitchLens │ MethodChan │ eSession +  │ ureEntry +  │ st.dart     │ 设备验证；h
              │ / Capture  │ nel        │ FlutterText │ MLKit/ZXing │ 通过（含停  │ ostSurface
              │ /          │ pocket.dev │ ure +       │ 扫码 +      │ 用后异步晚  │ 仅支持直角
              │ QrScan、ha │ /hardware  │ VNDetectBar │ MediaStore  │ 到纹理拦截  │ ClipRect（P
              │ rdware.pho │ -> 原生    │ codesReques │ +           │ ）          │ 2-3）
              │ tos.save、 │ Texture    │ t +         │ ActivityRes │             │
              │ hardware.m │ 注册 +     │ PHPhotoLibr │ ultContract │             │
              │ edia.pickI │ authorizeS │ ary +       │ s.PickMulti │             │
              │ mages      │ urface("ha │ PHPickerVie │ pleVisualMe │             │
              │            │ rdware.cam │ wController │ dia）       │             │
              │            │ era",      │ ）          │             │             │
              │            │ textureId) │             │             │             │
              │            │ ->         │             │             │             │
              │            │ PocketView │             │             │             │
              │            │ Texture    │             │             │             │
              │            │ 渲染       │             │             │             │
   6.         │ JS:        │ JS         │ 真实实现（C │ 真实实现（L │ hardware_pl │ hardware.pe
   定位、天气 │ hardware.l │ requestHos │ LLocationMa │ ocationMana │ ugin_test.d │ rmissions.r
   、传感器、 │ ocation.cu │ t ->       │ nager、CMMo │ ger、Sensor │ art、hardwa │ equest
   BLE、生物  │ rrent、har │ HardwarePl │ tionManager │ Manager、Bl │ re_platform │ 缺少权限声
   识别、安全 │ dware.weat │ ugin ->    │ /CMAltimete │ uetoothLeSc │ .test.ts    │ 明校验，wea
   存储、音频 │ her.curren │ MethodChan │ r、CBCentra │ anner、Biom │ 通过        │ ther.curren
              │ t、hardwar │ nel        │ lManager、L │ etricPrompt │             │ t
              │ e.sensors. │ pocket.dev │ AContext、K │ 、Encrypted │             │ 缺省坐标分
              │ sample、ha │ /hardware  │ eychain、AV │ SharedPrefe │             │ 支未校验定
              │ rdware.ble │ （天气由   │ AudioRecord │ rences/Keys │             │ 位权限（P0-
              │ .scan、har │ Dart       │ er；不可用  │ tore、Audio │             │ 2）
              │ dware.biom │ HttpClient │ 时返回结构  │ Record；不  │             │
              │ etrics.aut │ 请求 Open- │ 化错误而非  │ 可用时返回  │             │
              │ henticate  │ Meteo      │ 假成功）    │ 结构化错误  │             │
              │ 、hardware │ 真实接口并 │             │ ）          │             │
              │ .storage.* │ 结合原生   │             │             │             │
              │ 、hardware │ GPS/气压计 │             │             │             │
              │ .audio.rec │ ）         │             │             │             │
              │ ordSample  │            │             │             │             │
   7. JS UI   │ @pocket/ui │ Solid JSX  │ 完整支持（  │ 完整支持（  │ mobile_ui.t │ graphics.ts
   组件库与   │ （mobile.t │ ->         │ 无第二套    │ 无第二套    │ est.ts、flu │ 中的 3D
   Liquid     │ sx 38      │ @pocketjs/ │ Dart VDOM） │ Dart VDOM） │ tter_widget │ 机甲/粒子函
   Glass 渲染 │ 个移动组件 │ framework  │             │             │ s.test.ts、 │ 数产出孤立
              │ + flutter- │ 布局引擎 - │             │             │ flutter_wid │ 算子未接入
              │ widgets.ts │ > Rust     │             │             │ gets_native │ 渲染器（P2-
              │ x +        │ DrawOp     │             │             │ .test.ts、p │ 2）
              │ theme.ts） │ (rect,     │             │             │ ocket_rende │
              │            │ text,      │             │             │ rer_test.da │
              │            │ image,     │             │             │ rt 通过     │
              │            │ tileset,   │             │             │             │
              │            │ texQuad,   │             │             │             │
              │            │ filter,    │             │             │             │
              │            │ hostSurfac │             │             │             │
              │            │ e,         │             │             │             │
              │            │ textInput) │             │             │             │
              │            │ -> Flutter │             │             │             │
              │            │ PocketCanv │             │             │             │
              │            │ asPainter  │             │             │             │
   8.         │ <Input>    │ Rust 汇总  │ 完整支持（  │ 完整支持（  │ pocket_view │ 实机旋转与
   系统输入（ │ (textInput │ textInput  │ 含键盘避让  │ 支持折叠屏  │ _test.dart  │ 双屏开合动
   键盘/IME/  │ DrawOp) -> │ 几何与样式 │ 与          │ hinge       │ (8 项，含   │ 画流畅度需
   焦点/选区  │ _PocketVie │ -> Flutter │ composing   │ 双栏自适应  │ UTF-        │ 真机进一步
   ）与自适应 │ wState；Di │ 透明       │ 保护，不因  │ ）          │ 16、upstrea │ 压测
   （Duo/折叠 │ splayGeome │ TextField  │ 键盘弹出丢  │             │ m           │
   屏/安全区  │ try        │ 覆盖层承接 │ 失焦点）    │             │ 亲和性、com │
   ）         │ (viewport. │ 系统       │             │             │ posing、键  │
              │ safeArea)  │ IME/中文   │             │             │ 盘弹出不失  │
              │            │ composing/ │             │             │ 焦)、mobile │
              │            │ 选区/剪贴  │             │             │ _ui.test.ts │
              │            │ 板 ->      │             │             │ 通过        │
              │            │ input.chan │             │             │             │
              │            │ ge/input.s │             │             │             │
              │            │ ubmit 回传 │             │             │             │
              │            │ JS；MediaQ │             │             │             │
              │            │ uery       │             │             │             │
              │            │ safeArea/h │             │             │             │
              │            │ inge/displ │             │             │             │
              │            │ ayFeatures │             │             │             │
              │            │ ->         │             │             │             │
              │            │ viewport.s │             │             │             │
              │            │ afeArea    │             │             │             │
              │            │ 增量合并   │             │             │             │
   9.         │ PocketPerf │ Flutter    │ 支持        │ 支持        │ pocket_perf │ 停表后无 JS
   调度与性能 │ ormanceTra │ Ticker ->  │             │             │ ormance_tes │ timer
   统计       │ cker；pock │ pocket_fra │             │             │ t.dart、per │ 唤醒机制（P
              │ et_frame_d │ me_delta（ │             │             │ formance_hi │ 1-
              │ elta       │ 连续 6 帧  │             │             │ story_test. │ 2）；变化帧
              │            │ unchanged  │             │             │ dart 通过   │ 仍全量 JSON
              │            │ 自动停表） │             │             │             │ 序列化
              │            │ +          │             │             │             │ DrawList
              │            │ SchedulerB │             │             │             │ 与像素（P1-
              │            │ inding.add │             │             │             │ 3）
              │            │ TimingsCal │             │             │             │
              │            │ lback      │             │             │             │
              │            │ 真实采样（ │             │             │             │
              │            │ 区分 idle  │             │             │             │
              │            │ gap        │             │             │             │
              │            │ 与真实掉帧 │             │             │             │
              │            │ ）         │             │             │             │
   10. 双向   │ Rust:      │ PocketDupl │ 原生层与    │ 原生层与    │ duplex_layo │ 尚未接入
   Lock-Free  │ duplex.rs: │ exEndpoint │ FFI         │ FFI         │ ut.rs (6    │ PocketView
   SPSC 通道  │ 1-489；Dar │ -> FFI     │ 已就绪，生  │ 已就绪，生  │ 项并发/回绕 │ 生产输入与
              │ t:         │ isLeaf:    │ 产 UI       │ 产 UI       │ /竞态测试)  │ 事件循环（P
              │ PocketDupl │ true       │ 未调用      │ 未调用      │ 、lib.rs (5 │ 0-1）
              │ exChannel  │ reserve/co │             │             │ 项 duplex   │
              │ 、runtime. │ mmit       │             │             │ 集成测试)、 │
              │ openDuplex │ (Acquire/R │             │             │ pocket_dupl │
              │ ()；JS:    │ elease     │             │             │ ex_test.dar │
              │ __pocketOn │ 原子序 +   │             │             │ t、pocket_d │
              │ Duplex /   │ Arc 保活 + │             │             │ uplex_ffi_t │
              │ __pocketEm │ generation │             │             │ est.dart    │
              │ itDuplex   │ 隔离) ->   │             │             │ 全部通过    │
              │            │ build_fram │             │             │             │
              │            │ e 内       │             │             │             │
              │            │ drain_dupl │             │             │             │
              │            │ ex ->      │             │             │             │
              │            │ QuickJS    │             │             │             │
              │            │ 回调       │             │             │             │
   11. Editor │ server.ts: │ Loopback   │ 开发宿主机  │ 开发宿主机  │ editor_serv │ 请求省略
   与热更新发 │ 1-1007     │ HTTP 服务  │ 服务已闭环  │ 服务已闭环  │ er.test.ts  │ Origin 头时
   布台       │            │ ->         │             │             │ (4          │ /build、/pu
              │            │ 项目创建/  │             │             │ 项端到端测  │ blish、/ass
              │            │ 外部项目挂 │             │             │ 试) 通过    │ ets
              │            │ 载 ->      │             │             │             │ 可被跨站触
              │            │ 真实调用   │             │             │             │ 发（P1-4）
              │            │ build_gues │             │             │             │
              │            │ t.ts 编译  │             │             │             │
              │            │ .qjbc ->   │             │             │             │
              │            │ 调用       │             │             │             │
              │            │ package_up │             │             │             │
              │            │ date.ts    │             │             │             │
              │            │ Ed25519    │             │             │             │
              │            │ 签名发布 - │             │             │             │
              │            │ > 托管     │             │             │             │
              │            │ /updates/: │             │             │             │
              │            │ channel/la │             │             │             │
              │            │ test.json  │             │             │             │
              │            │ 与         │             │             │             │
              │            │ /blobs/:sh │             │             │             │
              │            │ a256       │             │             │             │
  ──────
  ## 3. 旧项目技术复用与遗漏清单（对照
  /Volumes/ORICO/Development/Github/pocketjs_flutter_demo，排除 pocket_host/）

  ### 3.1 已完整继承并升级为真实生产实现的技术

  1. iOS 原生硬件能力桥（PocketRealHardwareManager -> PocketHardwareManager.swift:1-1103 +
  Android 对齐实现）：
      • 旧工程仅在 AppDelegate.swift 与 real_hardware_bridge.dart:68-549 中实现了 iOS
      单端硬件调用，且失败时会静默回退到假权限通过（如 real_hardware_bridge.dart:119
      hwRequestPermission(..., grant: true)）。
      • 当前 SDK 完整复用了相机（AVCaptureSession +
      FlutterTexture）、扫码、相册、CoreLocation、CoreMotion/气压计、CoreBluetooth、LocalAuthent
      ication、Keychain、AVAudioRecorder 与 Open-Meteo 实时天气，补齐了 Android
      Camera2/BLE/传感器/生物识别对等实现，并消除了静默伪造成功的 fallback。
  2. 移动端设计系统、Liquid Glass 材质配方与 4 种转场数学模型（pocketjs_uikit.js /
  pocket_syslib_router.js -> mobile.tsx:1-501）：
      • 继承了旧工程的明暗主题 token、Liquid Glass 高光/折射参数及 4
      种页面转场曲线（ios_spring_parallax、shared_axis_z、liquid_glass_morph、portal_expand），
      但改为在 JS 侧直接驱动真实 PocketJS 节点树，不再依赖 Dart 侧组件解释器。
  3. 按需渲染与真实帧耗时监控思想（perf_monitor.dart:29-130 -> pocket_performance.dart:1-210）：
      • 继承了 SchedulerBinding.addTimingsCallback
      帧耗时采样与静止休眠思想，并去除了旧工程里写死在代码中的宣传文案与初始固定 60.0
      假历史数组。


  ### 3.2 仅迁入接口/模块、但尚未接通生产调用链的能力

  1. 双向 Lock-Free SPSC 环形通道（旧 pocket_runtime_multi.h:78-97 -> 新 duplex.rs:1-489 +
  pocket_duplex.dart:1-435）：
      • 旧工程的 PocketSharedDuplexChannel 只是普通非原子结构体拷贝；当前 SDK 用 Rust
      真正实现了带 CachePadded<AtomicU32>、Acquire/Release 内存序、SPSC 角色独占与 Arc
      生命周期保护的无锁通道，并接通了 rquickjs 的 __pocketOnDuplex / __pocketEmitDuplex。
      • 未接通处：如 P0-1 所述，PocketView 与 Showcase 尚未调用 runtime.openDuplex()，生产事件仍走 JSON。
  2. 图形辅助函数与 SVG 规格（旧 pocket_syslib_graphics.js -> 新 graphics.ts:1-200）：
      • 如 P2-2 所述，compute3dMechaFrame 与 compute2dParticleFrame 仅被单元测试调用，其产出的
      line/arc 算子在当前 Rust/Flutter 渲染器中无对应消费端。


  ### 3.3 旧项目中值得参考但当前仍缺失（或未完成闭环）的技术

  1. 紧凑二进制 DrawList 传输协议（参考旧 pocket_runtime_multi.c:8-17 BinaryDrawCmd 思想）：
      • 旧工程虽然没有真实 JS 引擎，但其 C -> Dart 绘制指令采用了定长二进制 buffer 而非大体积
      JSON 字符串。当前 SDK 在变化帧上仍将全部 DrawOp 和纹理 pixels 序列化为 UTF-8 JSON（见 P1-
      3），在复杂动态页面上应引入二进制 DrawList / 像素零拷贝视图。
  2. 页面栈后台冻结（Freeze-on-Push）与滚动位置保持的框架级封装：
      • 旧工程在宿主层维护了页面栈冻结与滚动偏移恢复概念；当前 SDK 已将路由交还给 JS，但
      @pocket/ui 尚未提供开箱即用的多级页面栈 keep-alive（保留后台页面子树布局与 ScrollView
      偏移而不重复参与每帧 diff）组件封装。


  ### 3.4 已正确排除的旧项目模拟实现与重复方案（严禁回迁）

  1. 伪 .pjc 字节码编译器（compile_pocket_syslib_aot.py:41-125）：旧工程仅用正则去掉 JS
  注释后拼上 52 字节 PJCA 头部冒充 AOT 字节码，并在构建期用宿主机 Node.js 预跑出静态 VDOM
  JSON（syslib_flutter_ui_vdom.aot.json）。当前 SDK 已彻底替换为真实 QuickJS PJSB 字节码编译。
  2. 不含 JS 引擎的 C 状态数组沙盒（pocket_runtime_multi.c:19-142）：旧工程 C 库根本没有链接
  QuickJS，只用 C 全局数组模拟节点和沙盒状态。当前 SDK 已彻底排除。
  3. 第二套 Dart 侧 VDOM 与 4000
  行宿主业务渲染器（pocket_ui_components.dart:1-120、pocketjs_bundle_runner.dart:1-120）：旧工程
  在 Dart 侧硬编码了页面蓝图与 Flutter Widget 映射树，违背了“Flutter
  仅作最薄绘制宿主”的架构目标。当前 SDK 已完全清除（由 check_architecture.py 守卫）。
  4.
  失败时自动伪造成功的硬件/权限兜底（real_hardware_bridge.dart:119）：旧工程在异常或模拟器不支持
  时强制返回 grant: true 和模拟硬件数据。当前 SDK 已改为严格返回结构化错误码。
  ──────
  ## 4. 可删除或合并的冗余设计及验证方式

   序号 │ 冗余位置            │ 冗余原因            │ 消融/合并方案       │ 验证方式与判定标准
  ──────┼─────────────────────┼─────────────────────┼─────────────────────┼─────────────────────
   1    │ graphics.ts:88-200  │ 从旧工程            │ 删除                │ 删除后运行 bun
        │ 中的                │ pocket_syslib_graph │ compute3dMechaFrame │ sdk/scripts/build_g
        │ compute3dMechaFrame │ ics.js              │ 、compute2dParticle │ uest.ts 编译
        │ 与                  │ 机械迁入；产出的 {  │ Frame               │ demo/js、bun test
        │ compute2dParticleFr │ op: "line" } / {    │ 及相关类型导出（或  │ 与
        │ ame（及             │ op: "arc" } 在 Rust │ 仅保留              │ native_guest_probe.
        │ graphics.test.ts:1- │ 渲染器与            │ POCKET_SVG_ICON_SPE │ ts --
        │ 40 对应断言）       │ PocketCanvasPainter │ CS）。              │ required，构建产物
        │                     │ 中无任何消费逻辑，d │                     │ 与渲染帧 100%
        │                     │ emo/js 亦未使用。   │                     │ 不变。
   2    │ FfiPocketRuntime    │ PocketView._onTick  │ 将 frameAt          │ 移除独立
        │ 中的全量 frameAt /  │ 在生产环境中只调用  │ 合并为基于          │ pocket_frame FFI
        │ pocket_frame 路径与 │ pocketFrameDeltaAt  │ frameDeltaAt        │ 绑定后运行 flutter
        │ frameDeltaAt /      │ ；pocket_frame 与   │ 的薄包装（或在 FFI  │ test（pocket_flutte
        │ pocket_frame_delta  │ pocket_frame_delta  │ 层仅保留单一帧拉取  │ r、sdk、demo）全部
        │ 并存                │ 在帧发生变化时返回  │ 入口并通过参数控制  │ 通过。
        │                     │ 完全相同的全量      │ 是否跳过未变化帧）  │
        │                     │ JSON。              │ 。                  │
   3    │ pocket.ts:505-521   │ 职责分裂且字段不一  │ 允许 guest-         │ 合并后运行 bun test
        │ 生成的双份配置文件  │ 致：version/build/a │ manifest.json（或统 │ scripts/tests/packa
        │ ：editor.json 与    │ ppId/channel 在     │ 一的                │ ge_update.test.ts
        │ guest-manifest.json │ editor.json，而     │ pocket.json）作为单 │ 与
        │                     │ capabilities/permis │ 一真实数据源承载    │ editor/test/editor_
        │                     │ sions 在 guest-     │ version/build 与    │ server.test.ts，并
        │                     │ manifest.json，直接 │ capabilities/permis │ 验证产出的
        │                     │ 诱发了 P1-          │ sions，build_guest. │ app.bytecode.json
        │                     │ 1（build_guest.ts   │ ts 与               │ 内含正确的非零
        │                     │ 找不到 build 号）。 │ package_update.ts   │ build 与 version。
        │                     │                     │ 统一从中读取。      │
  ──────
  ## 5. 实际运行的检查、结果和未覆盖范围

  本次审核在
  /Volumes/ORICO/Development/Github/pocket（a5dd273）上实际执行了以下只读检查与测试（严格区分默
  认执行、带环境变量执行与 skipped，未将任何 skipped 计为通过）：

  ### 5.1 实际执行的命令与结果汇总

   检查项               │ 执行命令              │ 实际结果              │ 备注 / 发现
  ──────────────────────┼───────────────────────┼───────────────────────┼───────────────────────
   架构边界静态守卫     │ cd sdk && python3     │ PASS (exit 0)         │ 确认 SDK 无反向依赖
                        │ scripts/check_archite │                       │ demo/，无遗留业务渲染
                        │ cture.py              │                       │ 器。
   Rust                 │ cargo test --locked - │ 11 passed, 3 FAILED   │ 3 个 smoke test
   原生层单元测试（默认 │ -manifest-path        │ (exit 101)            │ 因未设置
   无环境变量）         │ sdk/native/Cargo.toml │                       │ POCKET_TEST_ASSETS 和
                        │                       │                       │ POCKET_TEST_SOURCE
                        │                       │                       │ 直接 panic（见 P2-
                        │                       │                       │ 1）。
   Rust                 │ POCKET_TEST_ASSETS=$P │ 20 passed, 0 failed,  │ lib.rs 14
   原生层完整测试（传入 │ WD/demo/assets        │ 1 ignored (exit 0)    │ 项全部通过（含字节码
   真实产物路径）       │ POCKET_TEST_SOURCE=$P │                       │ 防篡改、无源码回退、d
                        │ WD/demo/js/.pocket-   │                       │ uplex 5
                        │ build/app.js cargo    │                       │ 项测试）；duplex_layo
                        │ test --locked --      │                       │ ut.rs 6 项通过，1
                        │ manifest-path         │                       │ 项手工吞吐基准（throu
                        │ sdk/native/Cargo.toml │                       │ ghput_report_lock_fre
                        │                       │                       │ e_vs_mutex_baseline）
                        │                       │                       │ 为 ignored。
   SDK TS/Bun           │ cd sdk && bun test    │ 16 pass, 1 FAIL (exit │ build_guest.test.ts
   测试套件（默认直接运 │                       │ 1)                    │ (2)、tooling_scene.te
   行）                 │                       │                       │ st.ts、android_scaffo
                        │                       │                       │ ld.test.ts、package_u
                        │                       │                       │ pdate.test.ts
                        │                       │                       │ (10)、editor_server.t
                        │                       │                       │ est.ts
                        │                       │                       │ (4)、flutter_widgets.
                        │                       │                       │ test.ts、graphics.tes
                        │                       │                       │ t.ts
                        │                       │                       │ 通过；flutter_widgets
                        │                       │                       │ _native.test.ts
                        │                       │                       │ 因缺少
                        │                       │                       │ POCKET_WIDGET_FIXTURE
                        │                       │                       │ _DIR 报错失败（见 P2-
                        │                       │                       │ 1）。
   SDK @pocket/ui 原生  │ POCKET_WIDGET_FIXTURE │ PASS (exit 0)         │ 通过 pocket_probe
   Widget               │ _OUTDIR=$TMP bun      │                       │ 真实执行 QuickJS
   探针测试（带临时构建 │ packages/pocket_ui/te │                       │ 字节码验证了 pointer
   目录）               │ st/flutter_widgets.te │                       │ 回调、disabled
                        │ st.ts &&              │                       │ 拦截与选中样式。
                        │ POCKET_WIDGET_FIXTURE │                       │
                        │ _DIR=$TMP bun test    │                       │
                        │ packages/pocket_ui/te │                       │
                        │ st/flutter_widgets_na │                       │
                        │ tive.test.ts          │                       │
   Showcase JS 单元测试 │ cd demo/js && bun     │ 11 pass, 0 fail (exit │ 覆盖
                        │ test                  │ 0)                    │ mobile_ui.test.ts
                        │                       │                       │ (4)、hardware_platfor
                        │                       │                       │ m.test.ts
                        │                       │                       │ (2)、guest_state.test
                        │                       │                       │ .ts (5)。
   Showcase 原生        │ cd demo/js && bun     │ PASS (exit 0)         │ 真实加载
   QuickJS              │ tests/native_guest_pr │                       │ demo/assets/app.qjbc
   字节码探针与消融测试 │ obe.ts --required &&  │                       │ + app.pak
                        │ bun                   │                       │ 跑通首帧、指针、输入
                        │ tests/guest_ablation. │                       │ 、100/500
                        │ ts --required         │                       │ 节点压测，并通过修改
                        │                       │                       │ 字节码消融验证首帧输
                        │                       │                       │ 出随之改变。
   pocket_flutter       │ cd                    │ 36 passed, 1 SKIPPED  │ 注意：默认未设置
   测试（默认运行）     │ sdk/packages/pocket_f │ (exit 0)              │ POCKET_NATIVE_LIBRARY
                        │ lutter && flutter     │                       │ 时，pocket_duplex_ffi
                        │ test                  │                       │ _test.dart 被
                        │                       │                       │ SKIP，不能算通过。
   pocket_flutter 原生  │ cd                    │ 1 passed, 0 skipped   │ 真实加载
   Duplex FFI           │ sdk/packages/pocket_f │ (exit 0)              │ libpocket_flutter.dyl
   测试（显式指定       │ lutter &&             │                       │ ib，验证了 Dart FFI
   dylib）              │ POCKET_NATIVE_LIBRARY │                       │ leaf 调用与 Rust ABI
                        │ =/Volumes/ORICO/Devel │                       │ v2 SPSC
                        │ opment/Github/pocket/ │                       │ 环形通道的端到端发布
                        │ sdk/native/target/deb │                       │ 、消费与关闭。
                        │ ug/libpocket_flutter. │                       │
                        │ dylib flutter test    │                       │
                        │ test/pocket_duplex_ff │                       │
                        │ i_test.dart           │                       │
   pocket_services      │ cd                    │ 18 passed, 0 skipped  │ 覆盖签名校验、并发
   单元测试             │ sdk/packages/pocket_s │ (exit 0)              │ prepare、降级拦截、坏
                        │ ervices && flutter    │                       │ 包拉黑回滚、路径穿越
                        │ test                  │                       │ 拦截、插件准入。
   sdk 顶层会话集成测试 │ cd sdk && flutter     │ 4 passed, 0 skipped   │ 覆盖 PocketSession
                        │ test                  │ (exit 0)              │ 外部插件接入、生命周
                        │                       │                       │ 期关闭与组件重建保持
                        │                       │                       │ 。
   demo                 │ cd demo && flutter    │ 17 passed, 0 skipped  │ 覆盖
   宿主与硬件插件测试   │ test                  │ (exit 0)              │ hardware_plugin_test.
                        │                       │                       │ dart (12 项) 与
                        │                       │                       │ performance_history_t
                        │                       │                       │ est.dart (5 项)。

  ### 5.2 未覆盖范围与剩余不确定性

  1. iOS / Android 物理真机端到端验证未在本次只读命令行审核中执行：
      • 虽然已通过源码核实了 PocketHardwareManager.swift:1-1103、PocketHardwarePlugin.kt:1-1106
      和 CameraHardware.kt:1-695 的真实系统 API 调用链，但相机 FlutterTexture /
      SurfaceTextureEntry 帧率、CoreBluetooth/Android BLE 扫描广播、FaceID/BiometricPrompt
      系统弹窗及 iPhone 物理键盘弹出动画仍需在连接的 iOS/Android 真机上做最终验收。
  2. macOS 桌面宿主全量热更新集成测试（demo/integration_test/update_lifecycle_test.dart）：
      • test_updates.ts:38-52 会执行 dev_updates.ts setup 并在 demo/.pocket-updates
      下重写构建产物并拉起 flutter test -d macos。为严格遵守本次审核“不修改文件、不清缓存、不覆盖其他改动”的只读约束，未运行该会写入
      工作区的脚本；热更新核心状态机与本地 HTTP 更新服务已通过无副作用的 package_update.test.ts
      与 plugin_admission_test.dart 完整验证。
  3. 手工吞吐基准测试：
      • duplex_layout.rs:216-218 中的 throughput_report_lock_free_vs_mutex_baseline 标记为
      #[ignore = "manual throughput comparison"]，默认未运行。