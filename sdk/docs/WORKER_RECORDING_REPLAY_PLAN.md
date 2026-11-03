# Worker 确定性录制回放（主路径通过，边界矩阵待补）

用户于 2026-11-03 要求把 Worker、IO 与 offload 纳入录制回放。本轮 native facts/replay、archive bridge、真实 Worker HTTP 归档离线回放与 offload FFI 主路径已通过。下文按证据标注范围，复杂流式/配额/混合域边界仍不等同于完整覆盖。

## 格式与边界

- 纯 UI recording 继续使用 schema v1；旧 trace envelope `{idleMs, scalars}` 原样读取和回放。
- schema v2 trace envelope 为 `{version:2, idleMs, scalars, workerEvents?, offloadEvents?}`。每个 event 严格为 `{seq, session, kind, data}`。Worker 与 offload 共用一个 native trace 和全局递增 `seq`；归档按 `workerEvents` / `offloadEvents` 分类，回放按 `seq` 合并 facts，再按宿主 transaction entry 顺序执行。
- Worker/offload 合计最多 8,192 个 event、8 MiB。单 event 有 16 KiB 上限，Worker 单个 fact payload 最多 1,024 bytes。字节 payload 使用规范 Base64 字段（如 `bytesBase64`），inline 存入 event；不另建 blob 路由。Dart 只做 JSON shape、嵌套、事件数与字节数边界校验，kind/data 的语义由 native 严格校验。超限时录制标为 incomplete，不改变 Guest 的实时执行；导入的越限 archive 拒绝。
- Worker QJBC 复用已有 SHA-256 asset 归档。`workerConfigure` 记录 QJBC 描述、SHA、声明、ABI、generation、tickHz、limits、capabilities 和 `allowedHttpOrigins`；回放从 archive 验证并恢复相同资源和 grants。
- Offload 配置记录 generation/session/timeout/methods；provider completion、timeout/cancel、late completion 和 Guest reply 消费 facts 由原生 broker 记录。回放走 native configure/replay broker，使用空 notify 指针，不创建或调用 Dart provider。
- `externalWork` 记录每次宿主唤醒事务，包括零 delta 唤醒，使 Worker/offload facts 不会挂在没有宿主 entry 的空隙中。

## 停止和销毁

- `PocketRecordingLibrary.stop()` / controller finish 是 capture stop。已有 Worker/offload 时，先完成 `captureStop` trace cut，再切换 trace clock 到 mode 0；App、Worker 和 provider 继续运行。纯 UI runtime 没有异步域需要收口，只切换 mode 0，不追加 `captureStop`，所以新纯 UI recording 仍可保持 v1。
- runtime 在录制仍开启时实际 dispose，会在相同 trace begin/end 事务中调用 `pocket_stop_async`，记录 `asyncStop`，由 native 停止 Worker、detach UI bridge、关闭 offload；随后关闭 Dart provider、销毁 native runtime，最后完成 controller。
- 回放遇到 `captureStop` 或 `asyncStop` 时执行对应 native 路径。offload replay 不启动 deadline/provider 执行线程；Worker replay 不安装 Dart wake callback。离线回放的 capture stop 在完成 trace cut 后终止异步执行域，不恢复真实 IO；之后清理不要求录制中未发生的 async stop。原录制实例停止 capture 后继续运行。

产品录制控制、App 间编排与决策留在 JS SDK。native 官方 Worker runner 和 offload broker 负责 facts 语义、注入及可见顺序；Dart 只做 FFI 编组、runtime 生命周期边界、asset IO 和 archive 重建，不复制调度器或事件回放算法。

## 当前验证证据（2026-11-03）

- Worker native trace lane 测试 9 项通过；native 生产 Worker C ABI 的 timer/random/date/channel facts，在销毁原实例后由 3 个新 realm 重复回放通过。
- Native offload 测试 5 项通过；生产 offload C ABI 的 submit/provider completion facts，在销毁原实例后 3 次无 provider 回放通过。
- 真实 debug dylib 的 Dart offload FFI 录制、provider close、runtime dispose 和无 provider 重复 3 次 replay 通过；自定义 `compute.sum` provider 只在原录制中执行一次。
- 录制模型测试 12 项通过；最终 `pocket_flutter` 全套 104 项、SDK 全套 56 项通过（包含真实 Worker FFI 与生产 Session admission）；架构检查通过。
- 旧纯 UI 证据来自此前 run：Duo 三应用 388 个事务、124 个帧摘要销毁原实例后匹配，archive 导出/重新导入通过；此前真实 dylib 的纯 UI recording 10 项通过。此证据保留用于 v1 兼容，不代表 Worker IO 已验收。

- 最终 Rust 全套为 68 lib + 6 duplex passed，1 项手动吞吐基准 ignored；真实 HTTP Worker 录制/销毁/离线回放连续 10/10，offload 空闲关闭回归连续 50/50。
- 最新 debug dylib 的 SDK Worker FFI 2 项均实际执行通过：纯 UI capture stop 后继续运行；真实 Worker QJBC + HTTP + channel 录制后销毁原实例、关闭 HTTP server、导出归档，再在两个新 isolate 重建实例离线回放。请求计数仍为 1；篡改 seq 或 inline payload 被拒绝。日志 `/tmp/pocket-worker-recording-http-ffi-verified.log`，fixture 由真实 `buildGuest` 编译。

## 尚未覆盖或未端到端验收

- Worker/offload 混合域的全局配额边界、event/backpressure 超限行为和 archive incomplete 拒绝尚无完整端到端验收。
- Worker 双向 snapshot/ring 背压、流式 HTTP 多 chunk、多请求乱序、timeout/cancel/late completion、CPU quota、后台暂停、reload/eviction 和 generation 隔离未全部覆盖。
- 不同设备/ABI、网络硬件、纹理像素与实际耗时不作为当前可确定性重放承诺。

真实 HTTP archive FFI 验收通过后，已移除高层 Session 的旧 Worker 录制 guard。offload 也已开放 `PocketAppConfig` 与 `PocketRecordingLibrary.attach` 的 provider/recording 组合；配置测试确认 attach 不提前创建 provider。未验收的复杂 IO/配额边界继续明确标注。

## 原实施计划与剩余工作

已完成部分：

1. 扩展现有 trace envelope 和 archive，保持纯 UI v1 兼容；Worker/offload 共用全局序号和配额。
2. 通过 pinned 官方 runner/broker 记录和注入 Worker turns、时间/随机标量、channel、IO 与 offload facts，不另写 Guest 调度循环。
3. 增加 Worker QJBC asset 归档、配置重建、`externalWork`、`captureStop`、`asyncStop` 和无 provider replay dispatch。
4. 通过 native Worker/offload C ABI 和 offload Dart FFI 的重复销毁后回放验收。
5. 通过真实 Worker HTTP archive FFI、销毁/关闭服务后两次离线回放，以及 seq/payload 篡改拒绝。

剩余工作：

1. 补齐 quota/backpressure、streaming、多请求、timeout/cancel/late completion 和 Worker/offload 混合序列的端到端边界测试；若某些场景不支持，保留明确拒绝并更新支持边界。
2. 继续保留旧纯 UI、duplex、输入/IME、idle timer 回归，以及录制关闭/开启/回放的消融证据。关闭录制路径不复制 payload、不轮询、不创建常驻 ticker。

相关实现入口：`native/src/worker.rs`、`native/src/offload.rs`、`native/src/replay.rs`、`packages/pocket_flutter/lib/src/pocket_recording.dart`、`pocket_runtime.dart`、`pocket_offload_binding.dart`、`lib/src/pocket_recordings.dart`。
