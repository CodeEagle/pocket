# 6e40c54 审查修复与消融

审查快照：[POCKET_SDK_REVIEW_6e40c54.md](../../POCKET_SDK_REVIEW_6e40c54.md)。本轮继续使用现有 PocketJS runtime、HostBridge、双向 stream 与 Flutter 绘制边界；应用政策和 UI 留在 JS。

| 复核项 | 本轮代码修复 | 验证边界 |
| --- | --- | --- |
| R1 iOS watch/read 互停 | producer 所有权、事件唤醒、generation 与错误收尾 | 实际 iOS 编译；持续物理采样待真机 |
| R2 listener 异常扩散 | 逐消费者隔离、有界诊断 | Bun 真实 SDK；QuickJS fixture |
| R3 host stream 多重认领 | 每 HostBridge 唯一所有者 | 两 adapter open/cancel/dispose 回归 |
| R4 Dart 假缓冲上限 | 按实际交付扣减 pending | 真实 StreamController 的 9 项回归 |
| R5 Android sensor 饥饿 | 每类 latest 快照、每流期限 | Kotlin 编译与 JVM 策略测试；物理采样待真机 |
| R6 CCCD 原始错误丢失 | 原始 code/message 贯穿断连清理 | 映射单测、identity/once 路径交叉审阅；外设时序待真机 |
| R7 大批次/队列无限制 | JS 预检与 native 最终有界 admission | Bun、真实 QuickJS batch/queue 回归 |

## 来源与实现边界

复核了保留项目 `pocketjs_flutter_demo/native/pocket_runtime_multi.c` 的有界 draw command buffer、外部 buffer admission 与双向通道，以及本项目已整合的实际 PocketJS/QuickJS 和插件实现。旧 C 文件包含配置账本和宿主示例，不将其当成真实 QuickJS allocator 或第二套绘制引擎引入。本轮主要修正现有实现的边界与重复工作，具体硬件/JS复用路径见各节。

## 原生消息边界

JSON 用于控制与能力消息，已有二进制帧和 SPSC numeric 通道继续承担对应数据路径。

| 边界 | 上限 / 行为 |
| --- | --- |
| 单次 `pocket._emit` | UTF-8 JSON 最多 256 KiB，解析前按长度拒绝 |
| `stream.batch` | 最多 256 项，拒绝嵌套 batch，包括 name/method 别名 |
| 待输出 JSON 队列 | 最多 1024 条，累计输入编码长度最多 1 MiB |
| 拒绝 | `_emit` 返回 false，已接受消息保留；frame/error/load 排空后恢复 |

累计字节由唯一 producer 记录；检查现有队列是否为空来重置，未增加另一个队列、轮询器或 Dart 调度状态机。这是编码长度与事件数限制，不是整个进程 native heap/RSS 的精确上限。

`sdk/native/tests/bridge_limits.rs` 使用真实 QuickJS 调用边界，验证大包、批次计数、嵌套/别名、非法 JSON、累计条数/字节和排空后恢复。不能用 fake transport 的 accepted=true 代替这些验证。

## 文件 admission

`pocket_load_files` 与 `pocket_load_bytecode_files` 在读取 PAK 前，取既有 256 MiB 文件上限、已批准 maxPakBytes、完整 QuickJS heap ceiling 中最小值。保留同一文件句柄上的 metadata 检查与 `take(limit + 1)`，读取中长度变化仍会拒绝。

真实内存回归加入稀疏超大 PAK，验证 source/bytecode 两条 file loader 在 metadata admission 拒绝，不先进入字节码校验或重置已运行 realm。它不改变宿主默认授权额度，也不承诺合计 App/GPU/RSS 配额。

## 静态帧消融

资源增删/版本检查仍遍历借用的缓存 DrawOps；只有需要输出完整帧时才构造 owned operations。delta unchanged 分支不再先 clone 整个 ops、auxiliary 和 texture handles。临时事件和资源变化继续输出完整帧，legacy full-frame 仍保有完整缓存。

`frame_delta_cache.rs` 验证 unchanged→临时事件→unchanged→legacy complete 的实际 ABI 行为。单节点场景的同一 allocator probe 对比：

| 100 次 unchanged binary delta | 6e40c54 | 修复后 |
| --- | --- | --- |
| 空场景 allocation calls | 292 | 292 |
| 单节点 allocation calls | 492 | 292 |
| 单节点累计 allocated bytes | 66,260 | 34,660 |

该结果是 macOS debug、特定场景的分配计数，未换算成手机 FPS 或功耗。仍存在虚拟帧/资源 bookkeeping 的必要成本；本轮没有通过额外运行 idle 帧追求该指标。

## JS 通道与 stream 所有权

HostBridge 对 event、tick 和兼容的旧 global sink 分别隔离异常。可选 `onDiagnostic` 最多报告 32 次，并截断错误文本；诊断观察者本身抛错也不会阻断后续消费者。该上限是单个 bridge 生命周期内的报告预算，不保留额外诊断队列。

System、Platform、Display 与 Showcase 的现代路径使用现有 `HostBridge.onEvent`，共用已经解码的 `HostEvent`。只有旧的 request-only 注入 bridge 继续解析字符串。回归测试构造真实 Platform client 和 stream adapter，确认一次 wire event 只触发一次 JSON.parse。

同一 HostBridge 上的多个 stream adapter 使用 WeakMap 记录 host-originated stream 的唯一所有者。只有已注册 `onStream` 消费者的 adapter 能认领，按订阅处理顺序由第一个符合条件的 adapter 持有；其他 adapter 不再创建重复本地 stream，也不会在自身 dispose 时取消别人的 stream。所有者关闭/释放后，同 ID 的下一次合法 open 可以被重新认领。Guest 主动 open 的隔离 ID 规则保持不变。

`sendBatch` 预检完整 wire envelope 的 UTF-8 字节与项目数。超过 256 项或 256 KiB 抛出 `stream_batch_too_large`；非法 JSON 值抛 TypeError，预检失败不发送部分 batch。使用有界遍历避免先构造超大 JSON 字符串；原生 `_emit` 仍是不能绕过的最终边界。

有界预检拒绝访问器、own/inherited `toJSON`、循环数据、超过 32 层或 16,384 个遍历节点的结构。这样普通数据对象的预检结果不会被第二次 stringify 的 getter/toJSON 扩张绕过。它不是执行不受信任 Proxy 的隔离沙箱。

## Dart 真实缓冲

原先 add 前后立即增减的计数不能代表 StreamController 队列。本轮计数改为在数据实际交付给订阅者时释放；未监听、暂停、刚恢复及重入期间的待交付数据都计入额度。溢出发送 `stream.error`（`stream_buffer_overflow`）并关闭对应流；正常 end 仍让已接受的数据依序交付。取消唯一订阅会释放远端 producer。

沿用原控制器和 stream 协议，没有新增另一个数据队列或定时 drain。batch 最多 256 项并拒绝递归展开，UTF-8 chunked encoder 在 256 KiB 后中止，不创建完整的超大编码字符串。9 项回归使用真实 Dart StreamController，覆盖未监听/暂停、正常结束、remote error、取消、dispose、重入与消息边界。

## 传感器与 BLE

iOS 的 watch producer 与独立 one-shot manager 分离所有权。已有 watch 时，read 使用共享 producer 的真实样本事件唤醒，并以一次 timeout 收尾；watch 取消不会中断进行中的共享 read。producer 的 Core Motion 请求频率随活跃消费者调整，节流使用单调时间；generation 检查屏蔽旧 producer 的迟到 sample/error。重启会清空旧样本，producer error 同时按 generation 结束共享 read；错误处理不再经过第二个可能跨 generation 的异步跳转。未增加采样探针轮询。

Android 使用每类 sensor 的最新真实值组成快照，按每个 stream 独立 deadline 输出，避免较快传感器永久饿死另一类。注册周期取活跃消费者所需频率，取消/完成后重配或停止；重配失败尝试恢复原注册，恢复失败清理 OS 中的部分注册并结束逻辑 stream。

Android GATT 的立即 fence 和 once completion 保留；断连通知沿现有回调携带原始 code/message，通知状态清理不再将 CCCD 配置失败先覆盖为泛化 disconnected。JVM 测试覆盖生产 cause mapping 和传感器快照/期限策略，不能视为真实 BLE 外设端到端验证。

## 验收记录

- `cargo test --locked`：96 项通过、1 项既有测试 ignored，详见 ignored `.pocket-build/review-fixes-6e40c54/rust-tests.log`。
- `build_native.sh ios-sim` 与 `build_native.sh macos`：实际 archive / probe 构建通过。
- SDK 根目录 `flutter analyze`：No issues found。
- SDK 根目录 `flutter test`：67 项通过、4 项因原生库环境变量或 Worker fixture 缺失跳过。
- 最终 `bun test sdk/packages/pocket_ui/test sdk/scripts/tests/streams_runtime.test.ts`：27 项通过（含真实 QuickJS stream runtime）；Demo system/state/mobile suite：12 项通过。
- R2 补充 fixture：在真实 QuickJS 的 stream adapter 前注册抛错 listener，既有样本数与绘制文本断言仍通过；独立重跑 runtime test：1 项通过。
- `pocket_services` 全套：48 项通过；其中新增真实 stream 缓冲回归 9 项通过。
- 设置 `POCKET_NATIVE_LIBRARY` 后 `pocket_flutter` 全套：130 项通过。
- Demo `flutter test --no-pub`：45 项通过；`flutter analyze --no-pub`：No issues found。
- 补齐真实 Worker fixture 后，SDK 两个 FFI 测试文件的 3 项测试及 `recording_worker_session_test.dart` 的 1 项通过；最初跳过的 4 项均已补跑通过。fixture 初次构建遇到 Bun 依赖缓存 EEXIST，使用 `bun install --frozen-lockfile --backend=copy` 修复生成缓存后，默认 buildGuest 构建恢复通过。
- `bun run build:system`：Showcase/profile/lobby 字节码重建完成；`POCKET_BUILD_GUEST=0 bash scripts/test_guest.sh`：JS 状态、硬件契约、真实字节码消融与 native load/ABI/message/pointer/input/stress 通过。
- Android `./gradlew :pocket_hardware:compileDebugKotlin :pocket_hardware:testDebugUnitTest`：编译与 3 项 JVM 测试通过。
- `python3 sdk/scripts/check_architecture.py`：通过；`git diff --check`：通过。
- Swift parse 与 podspec parse 通过；`flutter build ios --simulator --debug --no-pub` 实际构建通过。第一次编译发现新增闭包缺少显式 self，已修正并重新构建；交互测试后续构建也包含最终 generation/error 修复。新增 iOS XCTest 源码未作为已执行的设备测试计数。
- iPhone 18 Pro / iOS 27.2 模拟器：`legacy_capabilities_test.dart` 1 项、`multi_app_test.dart` 3 项通过；输入合集中的键盘/文本客户端/页面滚动 3 项通过。合集额外的 Editor 签名更新用例因未提供 `POCKET_UPDATE_URL` 配置在前置断言失败，没有进入更新逻辑；单独 `input_regression_test.dart --name 'keyboard|TextField|pages scroll'` 复跑 3 项全部通过。未将该 Editor 用例报告为通过。

真实 Core Motion、BLE CCCD、OS sensor 注册失败，以及手机 FPS/能耗仍需物理设备验收；模拟器和 JVM 策略测试不能证明这些指标。
