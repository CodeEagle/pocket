# 旧小程序平台与微信 Host 接入核查

核查日期：2026-11-03。来源为保留的 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`，明确排除 `pocket_host/`；目标为当前 `pocket/sdk` 工作区。代码存在、manifest 字段或截图都不能作为真实 Guest 已运行的证明。

下文“当前平台内核”记录的是本轮实现前的核查基线。用户随后要求补全，新增 JS SystemUI 内核、薄实例通道、可见性与 JS 客户端的实施/验收以 [MULTI_APP_IMPLEMENTATION.md](MULTI_APP_IMPLEMENTATION.md) 为准；微信 Host 的结论仍有效。

## 当前平台内核的实际覆盖

**运行一个 App 所需的基础设施已部分具备，多应用平台架构没有完整接回。** 当前允许消费工程创建多个独立 Session/QuickJS realm，但没有统一的 app registry、应用栈、跨 App 返回值或资源治理层。

| 能力 | 当前代码证据 | 状态 |
| --- | --- | --- |
| 单 App 入口与独立 JS 状态 | `lib/src/pocket_app.dart` 的 PocketGuestSession、`lib/src/pocket_session.dart`、`native/src/lib.rs` 的 create_host/HostState | 已有；每个 Session 创建独立 runtime、节点/资源和通道 generation。同进程 realm 隔离不等于 OS 安全沙盒。 |
| 签名包、版本与更新 | `packages/pocket_services/lib/src/pocket_package.dart`、`pocket_update.dart`，Session 的加载/晋升/回退链 | 已有真实 QJBC/PAK 链；签名 OTA manifest 校验期望 appId。不能用旧源码容器替代。 |
| 方法级原生能力与权限 | `PocketHostRegistry`、`PocketPluginManager`、消费工程 pluginFactories | 已有；注册/权限/流和清理绑定单 Session。不是跨 App broker。 |
| 多 App 安装目录和 registry | 当前 PocketAppConfig 由消费工程显式提供 | 未提供统一的安装/查找/打开/关闭 API；不能以 Demo 的页面列表代替。 |
| 跨 App 导航与返回值 | Demo 的 `js/state.ts` routeStack、`js/app.tsx` 转场；SDK 提供 UI/转场计算 | 未提供 App A 打开 App B 并 await result 的 SDK 契约；页面业务仍应留在 JS。 |
| 应用级前后台生命周期 | `PocketView.didChangeAppLifecycleState` 处理整个 Flutter 宿主 pause/resume | 部分；尚无多 Session 的 active/hidden/suspended 调度政策。Flutter App 前后台不等于小程序栈切换。 |
| 共享存储、跨 App 消息 | duplex 绑定单 runtime generation，stream bridge 绑定 Session | 未提供；性能历史文件不是 Guest storage。不能将 SPSC ring 当成全局广播总线。 |
| 资源治理 | QuickJS 单 realm heap/执行预算，Session close 与资源释放 | 部分；没有统一预热池、冻结/恢复、总内存预算或淘汰。当前没有 Worker realm，重计算不能据此转入后台。 |

### 身份与目录边界

当前 store 实际位于 `ApplicationSupport/pocket-packages/<appId>/<namespace>/apps/<safeAppId>/...`：Session 先选择 app 专属根，Coordinator 又调用 store.scoped(appId)。它保留了通用 Store 的作用域能力，但消费路径重复编码 appId；若消融，只能在明确根目录归属并提供旧路径迁移后进行，不能直接改路径使已有 OTA 丢失。

签名 OTA 包会检查 appId；embedded guest manifest 尚无 appId，身份由可信宿主 PocketAppConfig 指定。因此同一内置模板可以使用不同 appId。它不等于跨 App 安全逃逸，但未来若要求“已安装包不能冒用另一应用身份”，需要在构建 manifest 与安装准入中增加明确身份绑定，并保留通用 starter 的配置流程。当前 external identity 测试只证明 plugin context 收到配置的 appId，没有证明包身份强绑定。

### 对高 FPS、低能耗、响应的约束

多 App 层应复用现有 Session、包状态机、capability 与按需调度，不能恢复第二个 C runtime 或 Dart 业务页面解释器。仅可见且确有工作的小程序推进帧；隐藏 App 的 timer、订阅与后台权限要有明确政策。预热需有容量上限和取消，不能为缩短一次打开时间而让所有 Guest 常驻 tick。跨 App 消息需要 source/target appId、ACL、限流、背压和取消，默认复用现有控制消息，不能直接混用所有 App 的 duplex 队列。

## 旧平台架构中真正可以保留的部分

以下是代码调用链核查，未运行旧 Flutter 工程或 C 架构测试。旧测试会编译 C 状态模拟库，其通过不能证明 QuickJS 执行。

| 旧来源 | 真实实现与未完成边界 | 复用方式 |
| --- | --- | --- |
| `lib/core/pocketjs_bundle_runner.dart:401–447,641–726` | rootTabs、appId→ctx 和 Tab 实例表存在；Dart 持有业务/节点状态。C 的固定 sandbox 槽位不是 QuickJS realm。 | 提取应用注册、实例 key、切换/关闭契约，实例改为真实 PocketSession；不能整体迁入 Dart 页面解释器。 |
| 同文件 `:806–990`、`mini_apps/pocketjs_runtime_bundle.js:43–77` | 页面栈、Completer 和 pop result 是同 ctx、同 App 子页行为；pushPageForResult 继承 activeSandbox.appId，不是跨 App 导航。 | 同 App 导航与生命周期语义适合 JS 公共库；另行定义跨 App 请求、token、结果/取消契约。 |
| `native/pocket_runtime_multi.c:135–148,519–555` | SharedStore 为进程内静态 KV，初始化清零；notify 仅累计次数，无 watcher 投递或磁盘持久化。`tests/verify_architecture.py:226–238` 只测 set/get。 | 复用键值/订阅的需求，补真实存储、退订、app ACL 与重启恢复。不能宣称继承了持久共享总线。 |
| `native/pocket_runtime_multi.c:161–204,276–304,357–365,876–927`；Dart runner `:670–726` | prewarm 是整数队列/静态 VDOM；freeze/thaw 改状态位；evict 减 VRAM 计数。`lib/render/pocket_ui_components.dart:585–620` 有真实 subtree cache 清理，但没有 QuickJS realm 可暂停或释放。 | 保留有界缓存和懒加载原则；在真实 Session 上验证 counter/timer 暂停、恢复、generation 销毁和资源释放。 |
| `mini_apps/syslib/pocket_syslib_ota.js:132–199`、C `:1215–1343` | 旧 OTA 为内存 Map/版本字符串等状态，runner 按钮更新 UI；不是当前签名字节码链。 | 继续用现有 Store/Coordinator，不并入第二个 OTA manager。 |
| `lib/core/ffi_bridge.dart:1994–2035` | fallback 明写模拟 Wasm/JS worker，不能提供真实并行执行。 | 复用上游真实 Worker 构建和执行契约，见能力覆盖服务审查；不能把 echo 当 Worker。 |

旧 runner 通过内嵌 JSON hydrate 节点（`pocketjs_bundle_runner.dart:2301–2308,2465–2497`），旧 CMake 仅构建 `pocket_runtime_multi.c`。当前 SDK 的真实 QuickJS 字节码执行比旧状态模拟更完整；缺失的是把这套真实基础设施组织成多应用平台。

### 平台内核的最小接入顺序

1. 使用官方 PocketSystemV1 在 JS SystemUI 建立安装描述、registry 与策略；Flutter 只提供 opaque runtime 实例通道，复用 PocketSession。明确 package/appId、instanceId 与 generation；Flutter 不持有应用栈或生成大厅。
2. 提供应用可见/隐藏/关闭状态和真实调度控制。先验证 A/B 两个不同字节码、状态隔离、只有可见 App 推进，以及关闭后迟到消息不可触达新实例。
3. 提炼纯 JS 页面栈与 appear/disappear、push/result/cancel；跨 App broker 仅传请求和结果，不持有业务页面树。验证返回、取消、超时和调用方被关闭。
4. 按实际消费者增加 app-scoped storage 及显式授权的共享区/消息。先定义限额、取消和背压，再做持久化/重启与跨 App 拒绝测试。
5. 最后加入有上限的预热/淘汰；与完全关闭预热的基线消融，比较打开延迟、后台 CPU/唤醒、峰值内存和长帧。没有净收益的缓存或管理层不保留。

## 微信 Host 的结论

**没有迁入当前 SDK；旧实现本身也不是完整的 PocketJS 微信运行宿主。** 它是能在微信页面环境中展示本地节点树的 JS/WXML 示例。它既没有执行 PocketJS Guest，也没有实现让 Flutter 运行微信小程序包的兼容层。两种目标需要区分。

| 旧实现 | 实际行为 | 当前状态 / 可保留价值 |
| --- | --- | --- |
| `wechat_host/pages/index/index.js` | `onLoad()` 手写 Screen/View/Text/FocusGrid/Modal；点击修改本地 count/modal，调用 setData。没有 manifest、QJBC、PAK 或 WASM 加载入口。 | 未迁移该展示页；节点、点击与模态交互需求可以成为新 Host 的验收场景。 |
| `wechat_host/core/wx_pocket_host.js:50–112,143–155` | 保留节点 map；修改节点后将整个 root tree 传给 setData。`insertBefore` 实际为 append；缺少布局和正式 Guest 执行。 | 不引入第二套 WXML 布局和每帧全树同步；当前保留 PocketJS core 布局与 DrawList。 |
| 同文件 `:115–130` | Canvas 仅实现 fillRect、arc；未知命令被忽略，却仍返回输入命令数量。 | 不能作为正式 DrawOps renderer 迁入。文字、图像、clip、glyph、资源生命周期等均需适配。 |
| 同文件 `:7–27` SharedStore | 内存值、同步 watcher、可选 setStorageSync；get 不恢复持久化值，watch 无取消。 | 可复用需求和测试向量，不能作为跨 Guest、限额和生命周期已完成的依据。 |
| 同文件 `:29–48` BLE | 连接状态及手工 packet 分发；没有公开订阅、扫描、通知、写入或会话清理链。 | 当前原生 hardware provider 继续承担真实能力；未来微信 adapter 应复用 capability 语义。 |
| 同文件 `:133–140` VFS | 拒绝部分路径后拼接 USER_DATA_PATH 字符串；没有文件 IO、appId 校验、包准入或容量限制。 | 可保留路径逃逸测试需求，不能作为隔离文件系统迁入。 |

文件开头的 `WXWebAssembly` 注释不对应任何 WASM 实例化代码。当前 QJBC 是 QuickJS 序列化字节码，微信 JS 引擎不能直接执行它；保留其真实字节码目标，需要先验证微信环境中的 QuickJS/WASM 运行方案。当前 SDK 提供 capability/RPC 协议与 Flutter/native 实现，没有独立可插入微信的 HostPort adapter。

## 实际执行证据

本轮在 Node 中 mock `Page`、`wx`，导入并执行旧页面与 Host 的真实 JS。它验证本地逻辑，**不代表微信 DevTools/真机或 PocketJS Guest 运行通过**。临时复现脚本 `/tmp/pocket-wechat-host-audit.cjs`，命令 `node /tmp/pocket-wechat-host-audit.cjs`。主代理复跑得到：

- 页面 count 变为 1、modal 打开；Guest loader 为 undefined。
- 输入四条 Canvas 命令，只发生 fillRect 和 arc 的绘制调用，其余未实现。
- SharedStore 内存 get 为 2、watcher 调用 1 次、持久化调用 1 次；不证明恢复能力。
- BLE 断开时 packet 长度返回 0，连接后返回 2，没有 subscribe 方法。
- VFS 字符串解析为 `wxfile://usr/mini_apps/app-1/level1.bin`；已测 traversal 被拒绝。

## 微信适配的最小顺序

1. 验证真实 Guest 执行：在微信环境加载固定版本运行时，执行真实构建产物，pointer 能改变下一帧。先过这个门槛再抽象 HostPort，避免只增加接口。
2. 复用包格式和安全契约：签名/hash、ABI/版本、PAK、独立 app 文件区。不能把旧 `.pjc` 源码容器当成当前字节码。
3. 适配正式 DrawList、资源和输入：沿用 core 布局，补 glyph/clip/纹理、pointer phases 与系统输入；复用按需调度，不做每帧全树 setData。
4. 以现有 capability 语义接微信存储、BLE、文件等能力；明确权限、取消、超时、背压和关闭，不复制旧 stub。
5. 微信 DevTools 与真机分别验收画面、输入、后台/恢复、释放和持续负载。以长帧、输入到帧、空闲唤醒和内存衡量高 FPS/低能耗/响应，不能用本地 Node 结果声称微信性能。

本轮微信与平台核查使用两个 GPT-5.6-Luna / max 子代理，分别只读负责微信 Host、平台内核；主代理复跑证据并整合。代理没有再派生任务。
