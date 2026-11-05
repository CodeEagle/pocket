# Pocket SDK 回归审查与优化建议

目标：`6e40c5486aab548ee70904b042b7d2a7a08e884a`，基准：`bba327e`。本轮实现已提交，127 个文件；本报告是提交后的独立审查结果，未包含在该实现提交中。

执行：AGY `gemini-4-argon-high` 全面审查，GPT-5.6 Luna Max 独立审查调度、事件与流热路径，主代理核对代码、测试日志并再次复现关键问题。审查没有修改正式实现。根目录原有的三份未跟踪审查文件未纳入提交，也未覆盖。

后续工作区修复及验收见 [REVIEW_FIXES_6e40c54.md](sdk/docs/REVIEW_FIXES_6e40c54.md)。下文保留目标提交的审查快照。

## 结论

目前不建议作为稳定 SDK 发布。现有回归测试通过，但仍存在传感器流生命周期、公共事件监听隔离和流缓冲边界问题。没有本轮实测证据证明需要改掉当前按需帧调度或把全部 JSON 换成 PB；生产帧输出已有二进制路径。

以下区分运行复现、代码路径确认和待测优化。iOS/Android 硬件问题没有在实体设备上复现，不能把编译或 Dart fake 测试当成原生硬件行为证明。也不以本次未发现 P0 推导所有安全边界已闭环。

## 确认的问题

### R1 / P1：iOS 单次传感器读取会停止持续流的共享 producer

- 位置：`sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift:695`、`:2527`、`:2537`、`:2623`、`:2654`。
- 触发：先开启 `hardware.sensors.watch`，再调用 `hardware.sensors.read`；权限申请路径也需要同样回归。
- 证据：watch 在同一个 `motionManager` / `altimeter` 上启动更新，并设置 `sensorStreamProducerRunning=true`。单次读取首先 supersede，调用 `clearSensorOperationState()`，无条件停止这两个 manager 的更新；单次读取完成又停止一次。此路径未恢复 watch producer 的运行状态与回调。
- 影响：持续流仍保持订阅状态，但后续样本停止，且未得到终止错误。属于原生代码路径确认，尚待真机验收。
- 建议：复用一个受控采样 producer，让单次读取获取下一份样本；或在必要原生边界为单次操作使用独立 manager。明确 producer 所有权，避免通过取消单次读取停止持续订阅。测试 watch→read→read timeout/cancel→watch 继续递增，并覆盖两个 session。

### R2 / P1：一个 JS 事件监听器抛错会阻断其他订阅和兼容入口

- 位置：`sdk/packages/pocket_ui/src/host.ts:187`、`:212`、`:224`。
- 触发：`host.onEvent` 的较早 listener 抛异常，后面还有 stream/system listener。
- 证据：主代理以实际 `createHostBridge` 在 Bun 再次复现：`{"error":"boom","later":0}`。`dispatchEvent` 逐个直接调用 listener，异常还会阻止 `eventDeliver` 调用 previous sink。`onTick` 有同类缺口；当前 Demo 已提供虚拟 deadline scheduler，因此后者不能直接说成 Demo timeout 回归。
- 影响：一个消费者故障会扩大为其他流/系统事件丢失；在真实 QuickJS 中的异常表现仍需补运行回归。
- 建议：逐 listener 隔离异常，保证后续 listener/既有 sink 可执行，并通过有界诊断入口记录异常。不要增加另一个事件总线。

### R3 / P2：多个 adapter 重复认领同一个宿主主动打开的流

- 位置：`sdk/packages/pocket_ui/src/streams.ts:619`、`:835`、`:319`。
- 触发：同一 HostBridge 创建两个 adapter，宿主发送 `stream.open`，ID 为 `host-stream-1`。
- 证据：主代理再次复现，两端 `openedA=1, openedB=1`；dispose A 后 wire 发出 `stream.cancel(host-stream-1)`，B 的同 ID 本地状态仍为 `open`。
- 影响：取消语义冲突，留下仍开放但远端已取消的订阅。当前 Hardware 示例主要是 Guest 发起流；这是公共双向 API 的真实缺陷，不能说成当前示例必现。
- 建议：优先让同一 HostBridge 复用一个 adapter/唯一认领机制；保留不同消费者的取消所有权。先验证两个消费者的 open/data/cancel/dispose，再判断是否需要更复杂的路由层。

### R4 / P2：Dart 声明的 maxBufferedMessages 不统计真实排队量

- 位置：`sdk/packages/pocket_services/lib/src/pocket_stream.dart:207`。
- 触发：端口尚未监听或下游 paused，连续送入数据。
- 证据：`_buffered++ → _controller.add(value) → _buffered--` 在同步调用内归零，未计算 StreamController 内部待消费队列。主代理再次运行 Luna 的实际 Dart 复现：`maxBufferedMessages=1 batch=10001 received=10001 isClosed=false`。
- 影响：公共桥接层的缓冲承诺不成立。这是既有实现的问题，本次继续沿用。PluginManager 的累计事件/字节配额是另一层保护，不能据此声称所有生产路径无限增长，也不能代替每流 pending 上限。
- 建议：按真实未消费队列计数，对未监听/paused consumer 设置明确溢出行为；不要仅给现有计数变量改名。补 paused、resume、取消和远端终止回归。

### R5 / P2：Android 多传感器事件共用一个节流时间戳

- 位置：`sdk/packages/pocket_hardware/android/src/main/kotlin/dev/pocketjs/pocket_hardware/PocketHardwarePlugin.kt:1485`、`:1495`。
- 触发：默认订阅多个 sensor，事件时间接近，某一类事件先到。
- 证据：每个 stream 只有一个 `lastEventNs`；先到的事件更新它，其余 sensor 的事件在同一窗口被丢弃，而发出的 packet 仅包含当前 sensor。可由同步到达顺序产生某类数据长期缺失。此结论来自代码路径，未做 Android 真机采样复现。
- 建议：明确 API 是固定频率合并快照还是每类独立采样。优先与 iOS 对齐为有界频率快照；若保留逐类事件，则使用每类时间戳并明确总事件预算。加入不同频率和固定到达顺序的原生回归。

### R6 / P2：Android 通知配置失败的原始错误码可能被断连清理覆盖

- 位置：`sdk/packages/pocket_hardware/android/src/main/kotlin/dev/pocketjs/pocket_hardware/PocketGattConnection.kt:272`、`:495`；`PocketHardwarePlugin.kt:1255`、`:1399`。
- 触发：通知 CCCD 操作失败，并进入 invalidateConnection 路径。
- 证据：`complete()` 先 disconnect，再派发 operation completion；disconnect 的回调先将 notification state 以通用 disconnected 错误移除，后到的配置 completion 因 identity 检查返回，丢失原始原因。
- 范围：收窄到通知配置和相关流错误；普通 read/write completion 直接持有 result，不能据此宣称所有 GATT 请求错误码均被覆盖。属于静态顺序确认，未做真实 BLE 复现。
- 建议：保留立即 fence/close 和 identity 防护，同时让 notification cleanup 接收原始 cause，保证一次完成；不要简单交换回调顺序而重新放过迟到通知。

### R7 / P2：出站 batch 缺少预先 count/byte 限制，真实 native emit 也接受超大批次

- 位置：`sdk/packages/pocket_ui/src/streams.ts:282`、`host.ts:235`；`sdk/native/src/lib.rs:1004`。
- 触发：向 `sendBatch` 传入大数组，先 every/map/stringify 完整构造，再交给 native。
- 证据：Fake transport 上的实际 SDK batch 100000 项会编码约 8.5MB。另用同等 map/stringify batch 形状直接调用真实 QuickJS `pocket._emit`；主代理再次复现 30000 项：`accepted=true count=30000 outer_events=2 nested_events=30000 frame_json_bytes=2479219 last_error=`。该 native probe 不是实际 SDK 模块编译测试，只用来验证真实 emit 边界没有阻止该大包。Luna 的 40000 项 probe 出现 Guest OOM，属于该输入下的边界证据，不是所有包大小的固定阈值。
- 影响：JS 单次同步阻塞和 native 解码/后续逐事件派发，可能先撞 heap OOM，再有机会返回结构化 quota 错误。现有 per-stream JS 入站 buffer 限制不保护这条出站路径。
- 建议：在大规模构造前限制消息数，编码时施加字节上限；native emit 也设置一致的有界拒绝行为。优先使用现有 accepted/error 机制，只有实测需要持续大批量吞吐时再加 chunk/ack。

## 值得先做的消融优化

| 顺序 | 改动 | 证据与边界 | 验收 |
| --- | --- | --- | --- |
| 1 | 移除 System、Platform、Display、Demo shell 对事件的重复 JSON 解码，复用 HostBridge.onEvent 已解码对象 | 真实 Demo 同时安装这些入口。Luna 的同源码链 probe 对一个 stream.data 统计到 5 次 parse；20000 包 Bun/macOS 合成消融约 32.97ms→7.253ms。不是手机 QuickJS、FPS 或功耗收益 | 合并路径保持事件顺序与取消语义；每包只解码一次；测设备 JS CPU、分配和 p95 事件延迟 |
| 2 | 按实际订阅最大频率配置原生采样，并支持按需选择 sensor | Android 当前 SENSOR_DELAY_FASTEST、iOS motion producer 固定 60Hz，再对 JS 输出限速；10Hz 输出并不代表硬件只采 10Hz | 1/10/60Hz、多个订阅、最后一个订阅退出时统计回调/唤醒次数和真实功耗；无订阅停止 producer |
| 3 | 在 JS sendBatch 编码前限制 count/bytes；必要时再决定 chunk/ack | 当前 every→map→stringify 先构造完整 batch。实际 SDK fake transport 编码约 8.5MB；真实 QuickJS/native probe 另外确认了 30000 项、约 2.48MB frame 的 batch 可被接受，见 R7 | 超额在大规模分配前拒绝；测 JS 峰值 heap 和最长同步阻塞；保证错误对消费者可见 |
| 4 | native unchanged 帧在构造 owned DrawOps 前短路 | `sdk/native/src/lib.rs:2318` cache hit 仍 clone ops/auxiliary/handles，`:5136` 才返回 unchanged。Luna allocator probe 发现静态 op 增加分配；不能把全部差值都归因于 clone | 对比空帧、静态复杂帧、有 transient event 帧的 allocations、bytes、p50/p95；保证 transient 事件不漏 |
| 5 | PAK 文件读取前使用已批准包大小上限 | `sdk/native/src/lib.rs:4660` 先按统一 256MiB ceiling 读取，再做 per-runtime PAK admission。当前文档并不承诺整个进程 RSS 上限，因此列为提前拒绝优化 | 超大文件在读取前拒绝，读取中仍保留长度变化/上限检查；测峰值 native allocation |

优先使用现有 HostBridge/stream/按需调度，移除重复包装和重复状态。只有测出 schema 编码在真实高频消息中占主要成本，才比较现有 JSON 与 PB/专用二进制；不能用帧已经是二进制的场景重复估算收益。

## 证据校正与未采用的模型结论

AGY 原始报告保存在 ignored `.pocket-build/review-6e40c54/argon-raw-report.md`，事件/测试执行记录在同目录 `argon-review-events.jsonl`。原始模型输出包含事实错误，本报告以代码与复现核验为准：

- 当前公开入口是 `pocket_create_with_memory_limits`，不是模型写出的 `pocket_set_memory_limits`；未实现其所称动态调额入口、`PocketMemoryLimits.fromPolicy` 或全 App 合计 `maxTotalHeapBytes`。不能把这些写成已验收能力。
- 默认宿主 16MiB allowance 属于明确记录的授权政策，不能建议为了接受更大 Guest 声明而自动放宽。Catalog 与 manifest 的双重 admission 是否需要支持进一步收紧，要先补契约测试，未列为已确认缺陷。
- `HARDWARE_STREAMS.md` 当前没有承诺 sensor/sensors 过滤，不能将缺少未承诺字段直接说成文档违约。按需筛选列为低能耗增强项。
- Android FASTEST 的权限/设备表现未在真机验证，未采纳“Android 12+ 必定失败”的表述。注册异常已有 catch；真实失败范围仍须设备验证。
- 模型所述 Universal Links、App Links、签名资产命名及无 listener 队列背压等不能一概视为已支持。本轮仅明确验证已有 custom scheme 路径的历史记录，冷启动和 Android URL 交付未专项重跑。
- 原始报告汇总写 256 项，但执行日志中各批合计为 297 项；本报告逐批记录，不以原始汇总为准。

## 本次实际执行的测试

下列 AGY 命令有本次 event log 的 tool completion 和退出码 0，不是从上一轮历史日志抄来。Flutter 均以 `--no-pub --concurrency=1` 运行。

| 执行者 / 目录 | 命令与范围 | 结果 |
| --- | --- | --- |
| 主代理 / repo | `git diff --cached --check`（提交前）；`python3 sdk/scripts/check_architecture.py` | 通过 |
| AGY / repo | `python3 sdk/scripts/check_architecture.py`；`git diff --check bba327e..6e40c54` | 通过 |
| AGY / repo | `bun test`：UI streams、platform_experience、platform_client、system_kernel、recording 五文件 | 19 pass |
| AGY / repo | `bun test`：plugin_types、platform_scaffold、package_update、streams_runtime、android_scaffold、ios_archive_outputs、tooling_scene、system_manifest、demand_scheduler、capability_panels、guest_state、hardware_platform、mobile_ui 十三文件 | 61 pass |
| AGY / repo | `bun test sdk/editor/test/editor_server.test.ts demo/js/tests/system_capabilities.test.ts` | 11 pass |
| AGY / sdk/native | `cargo test --locked --lib` | 81 pass |
| AGY 与主代理分别执行 / sdk/native | `cargo test --locked --test memory_limits` | 各 4 pass，含真实 QuickJS OOM 和独立 runtime 隔离 |
| AGY / sdk/packages/pocket_services | `flutter test --no-pub --concurrency=1` | 39 pass |
| AGY / sdk/packages/pocket_platform | 同上 | 8 pass |
| AGY / sdk/packages/pocket_hardware | 同上 | 11 pass |
| AGY / sdk | `flutter test --no-pub --concurrency=1 test/memory_policy_test.dart test/pocket_system_host_test.dart test/recording_library_test.dart test/performance_history_test.dart` | 27 pass |
| AGY / sdk/packages/pocket_flutter | `flutter test --no-pub --concurrency=1 test/pocket_memory_ffi_test.dart test/pocket_view_first_frame_test.dart test/pocket_recording_ffi_test.dart` | 21 pass |
| AGY / demo | `flutter test --no-pub --concurrency=1 test/plugin_contract_export_test.dart test/flutter_frame_monitor_test.dart test/showcase_admission_test.dart` | 15 pass |
| Luna / 临时复现 | 多 adapter、listener throw、Dart paused/no-listener、JSON parse 计数、native allocator | 复现结果见各条；合成性能不能外推设备 |
| 主代理 / repo | Bun 直接调用实际 HostBridge 与两个 adapter，再次验证 R2/R3 | 复现成功 |
| 主代理 / 临时复现 | Dart 无 listener 队列、Bun parse 链、Rust/QuickJS native emit 大包 | 分别复现 10001 项未溢出、5 次 parse、30000 项被 emit 接受 |

Bun 真实 native probe 套件使用 `POCKET_NATIVE_PROBE=sdk/native/target/debug/pocket_probe`、`POCKET_BYTECODE_COMPILER=sdk/native/target/debug/pocketjs_bytecode`。SDK/桥接/Demo 部分 Flutter 测试使用 `POCKET_NATIVE_LIBRARY=sdk/native/target/debug/libpocket_flutter.dylib` 的绝对路径。已有二进制未在本次全部重新编译；不能把这些测试当作干净机器构建验证。Rust cargo 测试检验当前源码。

复现实物与命令（均为临时文件，不纳入 SDK）：

```sh
bun /tmp/pocket_js_probes/multi_adapter_listener.ts
bun /tmp/pocket_js_probes/send_batch_fake.ts
bun /tmp/pocket_js_probes/parse_chain.ts
cd /tmp/pocket_stream_backpressure_probe
/Users/lincoln.law/fvm/default/bin/dart run bin/main.dart
```

```sh
CARGO_TARGET_DIR=/tmp/pocket_binary_alloc_probe/target cargo run --quiet \
  --manifest-path /tmp/pocket_binary_alloc_probe/Cargo.toml
POCKET_PROBE_COUNT=30000 CARGO_TARGET_DIR=/tmp/pocket_emit_probe/target \
  cargo run --quiet --manifest-path /tmp/pocket_emit_probe/Cargo.toml
```

Raw `PocketStreamBridge` 没有 10000 条累计 quota；`PocketPluginBudget.maxStreamEvents` 是每个受管 plugin stream 的独立限制，不是全局限制。当前生产 provider 均由 Guest 开流，未发现生产代码主动调用 `PocketStreamBridge.open()`；R3 仍需作为公共 embedding API 缺陷修复。

## 覆盖边界与下一轮验收

| 域 | 本轮覆盖 | 尚需补充 |
| --- | --- | --- |
| Runtime/FFI/内存 | Rust 库与内存真实执行、Dart memory FFI 与 admission 测试 | 跨 App 合计资源预算、设备 RSS/GPU 内存不在当前 per-realm quota 承诺内 |
| 帧/输入/FPS | 源码审查、first-frame、帧监控与录制 FFI 测试 | 真机输入/滑动/120Hz持续交互、30秒 idle 唤醒与功耗；本次未重跑模拟器UI |
| Host streams | 双向生命周期测试、R2/R3直接复现、缓冲反例 | 原生开始/取消迟到回调与多session压力测试 |
| 硬件 | Dart契约与原生源码路径检查 | iOS watch/read并发、Android多sensor和真实BLE CCCD/断连/权限撤销 |
| 平台体验/Deep Link | Provider单测、JS测试、已有warm/repeat/background历史日志 | 冷启动与Android交付；未接入Universal/App Links就不声称支持 |
| 多应用/SystemUI | JS kernel和Dart system-host测试 | 合计预算契约、复杂System子应用组合与真实设备驻留压测 |
| 构建/Editor/生成器 | Editor安全回归、脚手架/原生patch/类型/bytecode probe测试 | 本次不是所有历史审计项的逐条重新证明；干净环境全平台构建仍是发布门槛 |

建议下一轮按 R1/R2 → R3/R4/R5/R6/R7 → 重复解析消融 → 原生采样频率与静态帧分配消融的顺序推进。先保证错误隔离和真实缓冲，再测设备上的 p95 输入/事件延迟、长帧率、CPU/唤醒、峰值内存与功耗；不设“空闲必须60/120 FPS”这种会破坏停表目标的指标。
