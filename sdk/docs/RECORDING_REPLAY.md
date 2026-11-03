# 宿主事务录制与确定性回放

基于固定 PocketJS revision `99924de47c62fa36f526a8791055d91cbbdb3836`。研究来源与契约见 [DETERMINISTIC_FRAMES.md](DETERMINISTIC_FRAMES.md)。JS 控制面复用既有 recording SDK；native 是 Worker/offload facts 的记录与注入权威；Dart 只负责必要的 FFI 编组、归档 IO 和旧格式兼容。

## 录制边界

从一个全新 native runtime 加载代码前开始，直到显式 stop 或 runtime dispose。录制窗口没有内存快照：不能在已经运行的 JS 堆中途开启后，声称可从任意状态恢复。重新挂载或热更新创建的新 runtime 使用新的 recorder，归档按 app/generation 分开保存。

捕获已有宿主与 PocketJS 之间的真实事务：

- JS / QJBC / PAK 加载、引擎 ABI、内容 SHA-256、viewport、density、tickHz。
- full / delta / PFB1 frame 请求的精确 delta；输出 DrawOps、事件、资源内容和释放记录的稳定摘要。
- `send` 中的 host.response、JS 事件、文本值、selection/composing、视口、安全区和生命周期消息。
- live resize、auxiliary surface、scheduler pause/resume。
- SPSC duplex 的实际 ingress payload、step，以及 egress peek/consume。录制时在借用失效前复制诊断数据，继续使用原来的 native 原子发布路径。
- native `before_external` 真正使用的每一段 idle elapsed，以及 JS `Date.now`、`Math.random`、已有 `performance.now` 的调用顺序和值。
- Worker 配置事务绑定真实 QJBC SHA-256、声明、ABI、tickHz、limits 与 grants；native 记录 Worker turn、channel、timer、IO facts 和 UI latch。
- `io.offload` 配置事务及原生 broker 的 submit、provider completion、timeout/cancel 与 Guest reply 消费 facts。回放 broker 不调用真实 Dart provider。
- Worker 与 offload 的跨线程唤醒也有 `externalWork` 宿主事务；录制中的 runtime dispose 通过 `asyncStop` 收口 native Worker/offload 后再关闭 provider 和销毁 realm。

回放用新的真实 QuickJS/PocketJS 实例，不安装网络、硬件、OTA 或平台管理 provider。原始请求仍由 guest 执行和输出；外部结果按录制事务顺序送回。它验证 guest 在相同外部输入下的状态/绘制行为，不会再次拍照、写业务存储或实际下载更新。

这不是操作系统录像或 Flutter VM 快照。系统键盘的可见性和布局仍需设备测试；回放记录其进入 JS 的协议和 guest 输出。视频、相机 live texture 的外部像素不由 DrawOps 摘要保证。不同字体/GPU/renderer 的逐像素一致性仍需单独基线。Worker/offload 的配额边界、背压、流式多请求和全部取消竞态尚未完整验收，不能据目前的事实子集声称这些场景已覆盖。

## 复用上游而非第二个运行时

`@pocket/ui/recording` 直接使用上游 `__pocketDevtools.dumpTape/replay` 和 `clock/effects`：

- `captureUpstreamTape()` / `dumpCurrentInputTape()` 导出既有 flight recorder。
- `create/installEffectRecordingDriver()` 记录 command、payload、结果/错误和实际 delivery 帧。
- `create/installEffectReplayDriver()` 通过上游 effect drain 投递，检查命令和帧顺序、重复完成、取消及迟到结果。
- `exportRecording()` / `replayRecording()` 校验 build metadata 与输入/effect tape。

官方 input tape 不含 IME 和全部 host result，因此 Flutter 的事务记录是必要的补充 lane。不要再用另一套 JS tick、setInterval 或 input recorder 重复录制相同轨迹。headless sim 和 tape CLI 仍可用于上游 renderer 的独立基线；Flutter 原生回放使用当前 QJBC/FFI 路径。

归档中的 `upstreamInputTape` 是给官方 devtools 使用的诊断附件。native 回放只消费宿主事务 trace，不再次灌入该 tape，避免同一次指针输入被投递两遍；导入结果以 `hasUpstreamInputTape` 标识附件存在。JS 入口复用上游契约验证，Dart 只校验附件是有界 JSON 对象，不再维护另一套上游 Tape parser。

旧 demo 的 `lib/core/perf_monitor.dart` 只有性能历史采样，`mini_apps/app_canvas_lab/main.js` 只有画布指令记录示例；没有可直接迁入的完整确定性会话回放。当前实现复用上游 effect/input 契约，并在宿主缺失的 trace/IO 边界接入 native facts。

## 时钟如何保持一致

生产默认 mode 0 保持原来的 live 行为。mode 1 的录制仍使用原来的 `Instant` 结算，不改变 idle 之后输入注册 timer 的语义。旧纯 UI 事务保留 v1 envelope `{idleMs, scalars}`。新增 v2 envelope 为 `{version:2, idleMs, scalars, workerEvents?, offloadEvents?}`；两个数组中的 event 共用一个 native trace 和全局递增 `seq`，单项结构为 `{seq, session, kind, data}`。回放按 `seq` 合并两个 lane，并继续按宿主事务 entry 顺序驱动。mode 2 按记录值推进原有虚拟时钟，不读取 replay 过程的真实等待时间；idle credit、固定 tick 和 Promise pending-job 唤醒仍由原调度器处理。

新 ABI 以 `pocket_trace_clock_mode` 和 `pocket_trace_clock_begin_json/end_json` 为核心。mode 1/2 仅能在首次加载前启用；停止录制可恢复 mode 0。调用顺序、缺失/多余的时间值和 scalar 调用均是回放差异，不能静默丢弃。Worker/offload 共用总配额：最多 8,192 个 event、8 MiB；Dart 只校验 JSON 边界、event 数量和累计字节，event kind/data 的语义由 native 严格校验。超限使 recording 标记 incomplete，不改变 Guest 实时计算。

回放在创建 native 实例前检查验证证据：每个事务需要 clock envelope，成功的绘制事务需要 frame SHA-256；`frameDelta` 需要明确的 unchanged 结果。旧 v1 仍可解析，但缺少这些证据的记录只报告 unverified/rejected，不能因为没有比较项而返回 matched。上游 input tape 作为诊断附件保留，实际输入/effect 已由宿主事务驱动，不再把同一附件送入 Guest 重复执行。

Worker QJBC 作为普通 SHA-256 content-addressed asset 保存，配置 entry 同时记录 bytecode hash、声明、ABI、generation、tickHz、资源 limits 和实际授权的 capabilities/HTTP origins。事实中的 payload 按规范 Base64 inline 保存，不另开 blob 路由；Worker 单个 payload 上限为 1,024 bytes。回放从归档恢复同一 QJBC 与配置，再由 native runner 驱动，不依赖原 runtime、线程、网络或硬件。

目前没有拦截 `new Date()` 的隐式当前时间、`Date()` 字符串和任意第三方自行持有的外部时钟/随机源。应用仍应使用 PocketJS 虚拟时钟、显式 seed 和 effect 契约；这些契约之外的输入需要经过 host/effect lane 或额外适配，不能宣称任意 JS 都可确定性回放。

## SDK 接入

薄宿主单入口：

```dart
final recordings = PocketRecordingLibrary();

PocketSystemHost(
  systemUI: mySystemUI,
  applications: trustedApps,
  recordings: recordings,
);

// 在已完成的事务边界冻结当前 recording 前缀。
recordings.stop();
final result = await recordings.replay();
final exported = await recordings.export();
final again = await PocketRecordingLibrary.replayArchive(
  File(exported['path'] as String),
);
```

普通单应用可在挂载前调用 `recordings.attach(config, controls: true)`，再把返回的配置交给 `PocketGuest`。需要自行管理存储的嵌入方可使用 `PocketAppConfig.recordingFactory`，返回新的 `PocketRecordingController`。底层入口是 `FfiPocketRuntime.open(recording: controller)` 和 `replayPocketRecording(recording, assets: ...)`。

录制工厂在每个新 runtime 前调用；父 widget 重建应保留同一配置/工厂。切换录制应重新挂载，不在已有堆中途开始。library 与已有自定义 recordingFactory 不能同时接管同一 runtime。

显式 `recordings.stop()` / controller finish 是 capture stop：如已配置 Worker/offload，先记录 `captureStop` trace cut，再切回 mode 0；原 App 的 Guest、Worker 和 provider 继续运行。纯 UI capture stop 只切换时钟，不增加 entry，因此新纯 UI recording 仍可保持 v1。离线回放遇到 `captureStop` 时先验证同一 trace cut，再结束回放的异步执行域；它不恢复真实网络或 provider。若 runtime 在 capture 仍开启时真实 dispose，则记录 `asyncStop`，由 native 同步停 Worker/关闭 offload，再关闭 Dart provider 并销毁 native realm；回放重做 `asyncStop`，不会创建真实 provider。

`PocketRecordingLibrary` 汇总诊断事实，不管理应用栈、返回 token、前后台决策或 LRU。可选 diagnostic provider 仅安装在可信 SystemUI；普通子应用被录制但没有导出整个系统记录的权限。

## Showcase 使用

```sh
cd demo
flutter run --dart-define=POCKET_RECORD=true -d DEVICE_ID
```

业务页面仍由 JS 构建。进入 Host → Runtime 的 Deterministic replay 卡片：

1. 操作页面、输入文字、打开小程序。
2. `Recording status` 查看是否录制及各 realm 的事务数。
3. `Stop & verify replay` 冻结窗口，在新 isolate 中重建 guest 验证。
4. `Export recording` 保存归档，并附带 SystemUI 的上游 input tape。

默认运行不创建 recorder 或诊断 provider，没有录制轮询。capture stop 后原 App 可以继续运行；新录制窗口通过重新启动/挂载产生。导出前先 stop，避免把归档自身的大 payload 再录进 trace。

## 文件与配额

归档目录包含 `recordings.json` 和 `assets/<sha256>.bin`。tape 仅存 opaque asset key、长度与 SHA，不信任或重新打开 tape 提供的任意源码路径。回放资产由可信调用方提供；library 显式启用内存保留以支持从已退役 OTA generation 重放。归档按内容 hash 去重。

每 runtime 默认 8,192 条宿主事务、8 MiB trace；Worker/offload facts 共用额外的 8,192 event / 8 MiB lane 配额。可选保留资产默认上限 16 MiB。library 默认最多 8 个 runtime，可配置 1–32。超限会明确标记 incomplete，回放拒绝；不能悄悄截断后返回 matched。文件导入/导出还限制 manifest、资产总量和文件数，导入只接受普通目录与 regular asset files。

单独使用 `PocketRecordingController` 时，默认不保留源码/字节码/PAK；调用方需要传入匹配的 `PocketReplayAssets`。`PocketRecordingLibrary` 才显式保留资产。归档最多 128 个资产、共 128 MiB，单文件最多 64 MiB；导入先校验长度和 SHA，再为各 runtime 复制其实际引用的资产。不完整、未启动完成或空会话不能导出为可回放归档。停止后恢复原时钟对象，已缓存的时钟/随机函数仍可继续调用。

回放结果包含 `matched`、`replayable`、`entriesReplayed`、`framesCompared` 和 `firstMismatch`。差异应指出事务序号、帧序号和输入/输出/时钟/资产边界。首次差异就是失败，不以最终画面相同掩盖中间错误。

## 验证

实际测试结果收口到 [VALIDATION.md](VALIDATION.md)。验收必须包含真实 QJBC、多应用、IME composing、原 runtime 销毁后的离线回放、文件导出/重新导入、篡改拒绝和录制开关消融。声明“代码已接入”不能代替这些运行证据。

此前纯 UI run 已通过 Duo 两个业务场景：三应用 388 个事务、124 个帧摘要在销毁原实例后全部匹配，归档导出/重新导入成功；JS 页面中的状态、停止验证和导出按钮也实际点击通过。此前真实 dylib 纯 UI recording 10 项也通过。这些是旧纯 UI 证据，不代表 Worker/offload 或 HTTP archive FFI 已验收。macOS/iOS simulator/Android arm64 原生构建通过；Android 设备回放与物理功耗仍未验收。

截至 2026-11-03 的本轮验证：native Worker trace lane 测试 9 项、native offload 测试 5 项、录制模型 12 项通过；最终 `pocket_flutter` 全套 104 项、SDK 全套 56 项通过；架构检查通过。另有真实 native 生产 Worker C ABI timer/random/date/channel facts 在销毁原实例后由 3 个新 realm 重复回放通过；native offload C ABI submit/provider completion 事实在销毁原实例后 3 次无 provider 回放通过。Dart offload FFI 已在真实 debug dylib 上通过录制、provider close、dispose 和无 provider 三次 replay。

最终 Rust 全套 68 lib + 6 duplex passed，1 manual throughput ignored；真实 HTTP Worker 定向回归连续 10/10、offload 空闲关闭回归连续 50/50。最新 debug dylib 的 SDK Worker FFI 2 项实际执行通过，包含 HTTP 原实例销毁/服务关闭后归档两次离线回放、请求计数仍为 1、seq/payload 篡改拒绝；因此已移除 Session 的旧 Worker 录制 guard。offload 也已开放 `PocketAppConfig` / `PocketRecordingLibrary.attach` 的 provider 组合，配置测试确认 attach 不提前创建 provider。此前 SDK 全套运行中的 2 skip 是历史状态，不能用于代替这次实际执行。Worker IO、配额/backpressure、流式多请求、取消与迟到完成竞态的支持边界见 [Worker 确定性录制回放计划](WORKER_RECORDING_REPLAY_PLAN.md)。
