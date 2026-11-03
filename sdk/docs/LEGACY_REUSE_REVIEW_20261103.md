# 旧 Demo 能力复核与待选迁移项

审查日期：2026-11-03。用途：供维护者选择后续 SDK 工作范围；本轮不实施功能迁移。

## 范围与结论口径

- 对照旧仓库 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`（HEAD `d95fdcd`），排除 `pocket_host/`；当前仓库基线为 `1b39b1a` **加当前工作区改动**，包括本轮 UI 与真实内存限制实现。
- 原 `pocket_flutter_poc/PocketJSKit` 已不在本机，无法重新核查其源码。不能据此声称已经对两个原 Demo 全量复核。
- 主代理与三个 Luna Max 子代理分别检查平台体验、native/资源、插件/硬件/更新、JS/UI/多应用/微信。结论来自实现、调用方和消费者的交叉比对，不把旧界面文案、声明文件或固定计数当作完整能力。
- 本次没有重跑设备、构建或性能实验。下文“已有实现”说明代码落点存在，不代表全部平台和设备已验收，也不代表性能收益已经测量。

**主要结论：仍有可提炼的真实旧代码，但不少看似丰富的旧能力实际只有声明、可选 hook 或模拟状态。应优先补平台入口、JS API 与真实 provider 之间的断点，不恢复第二套 runtime、Dart 业务 UI 或模拟底层。**

优先级：P1 为建议近期补齐的 SDK 入口；P2 按实际消费场景补；P3 暂缓。优先级是本次建议，不表示已获实施指令。

## A. 旧实现中确有价值、当前尚未完整继承的内容

| 编号 | 待审项 | 旧实现与当前差距 | 建议归属 / 优先级 |
| --- | --- | --- | --- |
| A1 | Deep Link 冷启动、热启动接收 | 旧 iOS 有真实 URL 事件入口、initial/latest 缓存和 MethodChannel 分发；当前没有统一 links capability、公开 JS API 或应用选择策略。旧工程证明的是 URL scheme 入口，不能扩称 Universal Links 全支持。 | 平台插件仅接收事件；JS SystemUI 解析、选择 App、分发。**P1，建议做**。 |
| A2 | 插件 JS/TS 类型生成 | 旧构建脚本实际生成 namespace、方法签名和 alias 的 `.d.ts`。当前有运行时 descriptor、方法权限与配额，但 descriptor 没有完整参数/返回值类型 schema，也没有对应 JS 插件类型生成工具。 | 构建期工具与 JS 类型包；从实际编译插件和明确 schema 生成。**P1，建议做**。 |
| A3 | 系统状态栏 / Android 导航栏样式 | 旧 Dart runner 实际应用 `SystemUiOverlayStyle`。当前 JS 深浅色 UI 没有配套的公开 OS chrome 控制入口；安全区几何适配已经存在，两者不能混为一项。 | JS 当前页面提供样式；薄宿主应用并在页面退出、App 切换后恢复。**P1，建议做**。 |
| A4 | 触觉反馈 | 旧按钮、触控板等真实调用 Flutter `HapticFeedback`。当前没有供 JS 组件调用的通用 haptics capability。 | 薄平台能力 + JS 组件按交互触发；可关闭、限频，无常驻轮询。**P2，建议随正式 App 体验补齐**。 |
| A5 | BLE 数据解析、气压高度等纯函数 | 旧 syslib 有包解析和公式，可提炼为 JS 工具。旧包格式、城市预置和天气 DTO 多为 Demo 专用；损坏包返回固定温湿度、失败返回模拟天气的分支不能保留。 | 可选 JS 数据工具，先明确协议、单位、长度和范围。**P2**。 |
| A6 | 粒子 / 轨道纯数学 | 旧 JS 确实计算粒子位置和六实体轨道。当前 `graphics.ts` **只导出 SVG specs**，相关数学函数没有保留。旧函数输出的 `line/arc` 对象没有当前消费者，单独恢复导出并不能形成绘制能力。 | 有需求时适配官方现有绘制 primitives / DrawOps，先证明真实消费链。**P2，按图形需求做**。 |

### A 类源码证据与验收边界

**A1 — Deep Link**

- 旧冷 / 热入口：[SceneDelegate.swift:14](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/ios/Runner/SceneDelegate.swift:14)、[SceneDelegate.swift:19](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/ios/Runner/SceneDelegate.swift:19)；缓存与推送：[AppDelegate.swift:186](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/ios/Runner/AppDelegate.swift:186)。
- 当前应用入口：[AppDelegate.swift](../../demo/ios/Runner/AppDelegate.swift)、[AndroidManifest.xml:36](../../demo/android/app/src/main/AndroidManifest.xml:36)；当前硬件 capability 表：[hardware_plugin.dart:36](../packages/pocket_hardware/lib/src/hardware_plugin.dart:36)。这些入口中没有通用链接接入。
- 验收应覆盖：进程未启动 / 已启动、JS 未就绪时暂存、重复 URI、非法目标、目标 App 未安装、页面返回、销毁后退订；Android 需新增真实入口，不能称为从旧 Android 继承。

**A2 — 插件类型生成**

- 旧生成器：[sync_pocket_plugins.py:256](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/tools/sync_pocket_plugins.py:256)；旧产物：[pocket_flutter_plugins.d.ts:1](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/pocket_flutter_plugins.d.ts:1)。
- 当前 descriptor：[pocket_plugin.dart:36](../packages/pocket_services/lib/src/pocket_plugin.dart:36)、[pocket_plugin.dart:100](../packages/pocket_services/lib/src/pocket_plugin.dart:100)。现有 capability 名、kind、权限信息不足以自动推导完整方法类型，需补 schema，而不是凭名称猜签名。
- 验收应覆盖：独立消费工程类型检查、错误参数编译失败、实际注册表与生成声明一致、平台不可用能力不冒充已实现；生成类型不能被当作运行时授权。

**A3 / A4 — 正式 App 平台体验**

- 旧 OS chrome：[pocketjs_bundle_runner.dart:322](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart:322)、[实际应用:349](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart:349)。
- 旧真实触觉调用：[pocket_ui_components.dart:779](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart:779)。
- 当前 SDK / Demo 的 Dart、公开 JS、Swift、Kotlin 中检索不到 `SystemChrome`、`SystemUiOverlayStyle` 或可供 JS 请求的 haptics 实现。统一请求入口已有：[host.ts:31](../packages/pocket_ui/src/host.ts:31)。
- 只提炼平台调用与 JS 契约；不搬入旧 Dart 页面状态和 preset 业务逻辑。验收包括暗色页面文字可读性、嵌套页面返回恢复、子 App 关闭恢复、后台无触觉、禁用按钮无触觉。

**A5 / A6 — 可选纯函数**

- 旧硬件工具：[pocket_syslib_hardware.js:22](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_hardware.js:22)。
- 旧轨道 / 粒子：[pocket_syslib_graphics.js:60](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_graphics.js:60)、[粒子:114](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_graphics.js:114)；当前明确边界：[graphics.ts:7](../packages/pocket_ui/src/graphics.ts:7)。
- 数学单测通过不能代替真实渲染、BLE 收包或性能验收；没有消费者的 producer 不应为“补齐目录”而恢复。

## B. 当前确有边界，但旧 Demo 也没有成熟闭环，不能算成可直接搬回的成品

| 编号 | 能力 | 当前状态与旧实现真实性 | 建议 |
| --- | --- | --- | --- |
| B1 | BLE / 传感器持续事件订阅 | Dart 已有有界 stream transport 与插件 stream 权限/配额；缺少对应公共 JS adapter 和硬件持续流 capability。上游另有 service/media stream wrapper，但它不自动接通 Flutter `PocketStreamBridge`。旧有 stream 类型声明、optional hook 和被动采样代码，未证明完整 Guest 订阅闭环。 | **P1，遥测场景优先**：接通 JS 订阅、真实事件生产、取消和前后台暂停；高频标量数据按需复用 duplex，不能靠页面定时 read 模拟事件流。 |
| B2 | BLE GATT 深度交互 | 当前真实 scan/connect/service discovery 已有；characteristic read/write/notify 没有公开闭环。旧接口清单不证明已实现真实 GATT provider。 | **P1，若要支持外设应用**：新增受控方法与事件流，处理断连、超时、权限撤销、重复完成和销毁。 |
| B3 | 发布期插件依赖锁 / ABI 兼容校验 | 当前已有 runtime 注册、协商、激活、方法权限；旧工具生成版本锁表，但方法使用检测是字符串搜索，体积节省是预设 sizeKB 估算。没有证据表明它完成真实原生二进制裁剪。 | **P2**：借鉴依赖约束和可复现清单；不用旧脚本的百分比当优化收益，不承诺动态安装 native 插件。 |
| B4 | JS 插件启停管理界面 | 旧 bundle 提供注册、启停、tree-shake 的 shim 名称；当前可信宿主能注册/激活插件，Guest 没有等价公开管理 API。旧 shim 不代表 native 动态装载。 | **P2，按平台管理需求做**：JS 可以请求可信政策允许的启停，不能自行增加原生代码或授予权限。无需恢复伪 tree-shake API。 |
| B5 | 微信目标的多应用 / SystemUI / Worker | 当前微信目标已执行真实 QuickJS 字节码、PAK、绘制和触摸，**明确只支持一个 Guest、一个主 surface**；构建器拒绝 PocketSystem 和 Worker 项目。旧微信 host 是简化节点树 / helper，并没有完整多 realm 引擎。 | **P2，若要求微信目标与 Flutter 平台对齐则提升优先级**：新接真实多 Guest / compositor / Worker，不能回退 `setData` 第二渲染树。 |
| B6 | 独立 syslib 模块热更 | 当前更新单位是完整签名 Guest package。旧 `hotUpdatable` 清单和元数据 manager 没有独立模块的完整验签、加载、健康晋升和回退链。 | **P3**：只有确需独立系统库发布时再设计依赖、签名、兼容与原子回退，避免第二 OTA 状态机。 |
| B7 | 文件 VFS / 沙盒文件 API | 当前 PAK、应用存储和共享命名空间已有；没有统一的可写虚拟路径 resolver。旧 C / 微信 helper 主要拼接字符串，不能作为安全 VFS 复用。 | **P2，按文件型应用需求**：需新做路径规范化、符号链接防护、命名空间、权限和真实磁盘配额。 |
| B8 | 3D Scene / Rapier / HDR 等高级图形 | 当前没有旧 `Scene.loadNode/getSharedTransformArray/onCollision` 那一套完整公开链；旧 C 的 transform 数组、碰撞 pair 队列、视频帧序号和“VRAM”计数也不是完整引擎。当前纹理 / surface 机制不能因此被视为不存在。 | **P2，按游戏需求**：采用官方实际支持的机制；不恢复第二 scene ABI，不把粒子公式或假计数包装成 GPU / 物理支持。 |
| B9 | 全 App 总资源预算 | 当前已限制真实 QuickJS heap 和 PAK 入场，Worker 有独立 realm 上限；这不是整个 App 的 RSS、GPU 纹理、解码帧、全部 Worker 合计内存硬上限。旧内存 tier / VRAM trim 主要是计数模拟。 | **P2**：如需要平台级资源保障，另做跨资源记账与驱逐政策；旧模拟计数不迁回。 |
| B10 | Android 麦克风能力 | 当前可声明 microphone 权限，但 Android provider 明确返回 unsupported；旧声明同样不能证明真实跨平台采集。权限、录音、音频流应分别定义。 | 若 SDK 承诺该能力则 **P1**，否则明确平台矩阵；不能用旧授权 fallback 标记支持。 |
| B11 | DeepZoom 等稳定公共组合 API | pinned framework 已有 Gallery / Lazy / Portal / DeepZoom 等 primitives；当前没有完整旧目录的兼容包装。DeepZoom 的稳定 `@pocket/ui` 适配与设备视觉验收仍可补，不能称为底层完全不支持。 | **P2**：围绕真实场景补小型 JS 组合组件；不照搬全部旧 38 项 `View.*` 目录。 |
| B12 | 同 App 页面 Navigator Promise / 页面生命周期 | 当前跨 App `openApp/result` 已有真实实现；Demo 内部也有页面栈，但没有公共的同 App `push()->Promise / pop(result)` API。旧同 App wrapper 依赖 optional router globals，排除旧 `pocket_host/` 后不足以证明真实 host 闭环。 | **P2**：若需要稳定页内路由库，以纯 JS 组合实现页面栈、取消 / 返回值与页面 hook；不与已完成的跨 App runtime 生命周期混报。 |

### B 类定位

- stream 底座：[pocket_stream.dart:19](../packages/pocket_services/lib/src/pocket_stream.dart:19)、[插件 stream guard:301](../packages/pocket_services/lib/src/pocket_plugin.dart:301)；JS 入口：[host.ts:31](../packages/pocket_ui/src/host.ts:31)；硬件方法表：[hardware_plugin.dart:36](../packages/pocket_hardware/lib/src/hardware_plugin.dart:36)。
- GATT 当前路径：[iOS BLE:913](../packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift:913)、[Android BLE:545](../packages/pocket_hardware/android/src/main/kotlin/dev/pocketjs/pocket_hardware/PocketHardwarePlugin.kt:545)。
- 旧锁表 / 伪体积报告：[sync_pocket_plugins.py:219](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/tools/sync_pocket_plugins.py:219)；旧动态插件 shim：[pocketjs_runtime_bundle.js:83](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/pocketjs_runtime_bundle.js:83)。
- 微信明确拒绝多应用 / Worker：[build_wechat.ts:580](../scripts/build_wechat.ts:580)；[已实现边界](WECHAT_HOST_IMPLEMENTATION.md)。
- 旧独立 syslib 声明：[pocket_syslib_manifest.json:19](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/pocket_syslib_manifest.json:19)；当前发布：[package_update.ts](../scripts/package_update.ts)。
- 旧 VFS / KV：[pocket_runtime_multi.c:519](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/native/pocket_runtime_multi.c:519)；旧游戏调用需求：[app_game_detail/main.js:5](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/app_game_detail/main.js:5)。
- 真实内存限制与非覆盖项：[APP_MEMORY_LIMITS.md](APP_MEMORY_LIMITS.md)。
- Android 明确不支持 microphone：[PocketHardwarePlugin.kt:283](../packages/pocket_hardware/android/src/main/kotlin/dev/pocketjs/pocket_hardware/PocketHardwarePlugin.kt:283)。
- 同 App 旧 optional wrapper：[pocketjs_runtime_bundle.js:43](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/pocketjs_runtime_bundle.js:43)；当前跨 App 公共 API：[platform.ts:68](../packages/pocket_ui/src/platform.ts:68)。

## C. 已接入或有更强替代，不应再列成“旧 Demo 没迁”

| 能力 | 当前落点 / 边界 |
| --- | --- |
| 真实 QuickJS 预编译字节码、PAK、签名更新、版本 / 健康提交 / 回退 | `sdk/native`、`pocket_services` 与当前发布工具；不采用旧 `.pjc` 的源码加头格式。 |
| JS 多应用注册、SystemUI、跨 App 打开 / 返回结果、生命周期、消息 / 存储、预热 / LRU | [MULTI_APP_IMPLEMENTATION.md](MULTI_APP_IMPLEMENTATION.md)、[system.ts](../packages/pocket_ui/src/system.ts)、[platform.ts](../packages/pocket_ui/src/platform.ts)。背景策略当前是 suspend，不冒充任意后台持续执行。 |
| 官方 System 子应用合成 | [SYSTEM_COMPOSITOR_IMPLEMENTATION.md](SYSTEM_COMPOSITOR_IMPLEMENTATION.md)。Flutter 目标的支持不能直接外推到微信目标。 |
| 双向 lock-free 通讯 | [DUPLEX_TRANSPORT.md](DUPLEX_TRANSPORT.md)、`native/src/duplex.rs`。当前是 atomic SPSC 和真实 QuickJS 消费，不是旧 C echo。高频标量与低频控制按用途分工，不能宣称所有 JS 值都端到端零拷贝。 |
| Worker / IO / offload 与录制 facts | [WORKER_IO_IMPLEMENTATION.md](WORKER_IO_IMPLEMENTATION.md)、[RECORDING_REPLAY.md](RECORDING_REPLAY.md)。已存在实现，仍需按目标与 fixture 检查实际覆盖。 |
| 每 realm 真实内存限制 | [APP_MEMORY_LIMITS.md](APP_MEMORY_LIMITS.md)；不能再用旧静态 tier 文案说“内存限制尚未迁移”。 |
| Flutter 原生输入、JS 移动组件与转场 | `pocket_flutter` 的输入适配、`pocket_ui/src/mobile.tsx`、`flutter-widgets.tsx`、`legacy.ts`。旧 Dart 业务组件解释器不恢复。 |
| Liquid Glass SDK 组件 / surface | `mobile.tsx` 与 Flutter surface；Showcase 移除入口是用户要求的暂缓，不属于遗漏。性能与视觉质量仍不能凭“有组件”判定完成。 |
| 视频解码 / 显示与相机 Texture | `pocket_flutter` 已依赖 `video_player`，`PocketVideoOp` 由 `PocketView` 创建实际 VideoPlayerController 并显示 Texture；相机也有真实 platformTexture provider。不能把旧 HDR / 视频帧计数页面当作当前没有视频能力的依据；官方 companion `.pkst` / media service provider 则是另一项可选接入。 |
| iOS / Android 硬件 provider | `pocket_hardware` 的真实平台代码；具体平台支持范围和真机验收单列，不迁失败伪装成功的数据。 |
| 独立 Flutter FPS、历史 / 卡顿观测、按需调度 | 当前独立 Flutter engine 指标与 SDK 指标；不迁旧预填 60 FPS、固定耗时或手动驱动假 tick。存在指标不等于已达到高刷新率 / 低功耗目标。 |

## D. 明确不建议恢复的冗余设计

1. 旧 C sandbox / 内存 / watchdog / VRAM / 3D / video / OTA 的模拟状态不能替换当前真实 Rust / QuickJS 实现。
2. 旧 Dart 持有页面业务状态、旧 `{tag, props, children}` 解释器，以及微信递归 WXML 节点树会形成第二套 UI / 布局状态；保留 JS + 官方 primitives。
3. 旧 `.pjc`、剥注释源码加二进制头、Node 生成 VDOM JSON 不能接入真实 QJBC 管线。
4. 旧 plugin 字符串扫描、固定 sizeKB、伪 SHA / ABI hash 不能用于宣称可靠裁剪、供应链校验或性能收益。
5. 旧 BLE、定位、天气、照片等错误分支返回演示成功数据，不能进入 SDK provider。
6. 登录大厅交互、天气页面、城市预设、图形演示资源主要属于 Demo；它们不能作为 SDK 平台能力的迁移完成证据。

这是基于实现与消费者的静态取舍；本轮未做运行时消融实验。后续若涉及性能方案，应在同设备、同负载、profile/release 下比较 CPU、分配量、FFI 次数、p95 / p99、长帧与空闲耗能，再决定是否保留。

## E. 建议审阅顺序与待验收项

建议先选 **A1 Deep Link → A2 类型生成 → A3 系统栏 → A4 触觉**，补齐外部接入和正式 App 体验；需要真实外设应用时，再将 **B1 持续流 + B2 GATT** 作为同一条闭环推进。其他项按产品需要选择，避免把“旧 Demo 出现过一个名字”变成必须新增的 SDK 子系统。

另外三类工作是“已有实现的验收”，不应写成“旧代码未迁”：

- 高刷新率真机：实际 90 / 120 / 更高刷新率的输入延迟、长帧、idle CPU / 能耗；模拟器 60 FPS 不能代替。
- iOS / Android 真机硬件：首次权限、拒绝、永久拒绝、后台恢复、取消 / 超时、BLE 断连、相机 / 照片 / 定位的资源释放。
- 微信开发者工具与真机：实际加载、触摸、输入、存储、包限制和低端机性能；主机 WASM 测试不能当成微信真机通过。

旧 [LEGACY_SDK_REUSE.md](LEGACY_SDK_REUSE.md)、[LEGACY_NATIVE_AUDIT.md](LEGACY_NATIVE_AUDIT.md) 等记录属于历史基线，其中“图形数学已迁”“多应用尚缺”“内存仍是未来项”等描述不能作为当前状态。返回值还要区分跨 App 与同 App 页面栈。以本次源码复核和对应最新实现文档为准。

## 本轮核查记录

- 使用 `git rev-parse --short HEAD`、限定范围的 `git status` 确认两个仓库基线与当前工作区；没有清理或覆盖并行改动。
- 用 `rg` 定位旧实现、当前公开导出、平台 provider、调用方与消费者；用带行号源码逐项比对。
- 检查了 Deep Link 的 iOS cold / hot 入口、当前 capability 表、当前 iOS / Android runner；检查了真实 SystemChrome / haptic 调用和当前缺失的公开入口。
- 核对了插件类型生成、锁表算法、当前 descriptor、stream 底座、微信构建器限制及 graphics.ts 实际导出。
- `python3 sdk/scripts/check_architecture.py`：通过；文档本地链接存在性检查：通过。没有以此替代功能或性能测试。
- 只新增本报告并在旧复用文档增加历史基线提示；不运行旧工程，不生成旧缓存，不修改功能源码。
