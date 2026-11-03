# 合并改动复审说明：修复复审 + argon 并行工作

供独立 agent 复审当前提交。比较基线为 `e06720e5ab88e9ff211d3eedfe2d768cb77a004b`，
本说明与被审代码在同一提交中，可用 `git diff e06720e..HEAD` 查看。旧问题来源为
仓库根目录 `POCKET_SDK_AUDIT_REPORT_de8b051.md`。

用户要求总结“我的和 argon 的”并提交。下面按工作内容归纳：第一组是本会话组织六个
GPT-5.6-Luna Max 子代理执行、由负责人整合的修复；第二组是工作区已有的并行性能/UI/集成测试工作，
按用户称谓记为 argon 组。并行组摘要由另外两个 Luna Max 只读核对当前 diff、源码及日志，
不凭文件作者信息推断某一行归属。

## 1. 修复复审组

原始 e06720e 的常规测试虽然通过，仍存在五项可复现残余。本次修复：

| 问题 | 实现 | 针对性证据 |
|---|---|---|
| Offload 最后 reply 消费后不重开 wake gate，下一 submit/cancel 丢通知 | `sdk/native/src/offload.rs`：request/cancel/reply 都在 broker 锁内以三队列判空重武装，复用同一 predicate | 原 FFI notify_count=2，修复=3；Rust 覆盖新请求、取消、多回复、陈旧回复 |
| 子应用 Offstage 已产帧后失败，visible waiter 直到超时才结束 | `sdk/lib/src/pocket_system_host.dart`：失败始终拒绝未完成 visible waiter，不依赖 hasEverProducedFrame | 新 `sdk/test/system_host_first_visible_ffi_test.dart` 加载真实 QJBC，验证失败、销毁中的等待与重建；恢复旧逻辑后因 TimeoutException 失败 |
| 零 tick 帧漏左/右模拟摇杆及回中 | `sdk/native/src/lib.rs`：补零 tick 输入判定，复用 external_work_pending 送达回中 | 真实 QuickJS 测试验证双摇杆、中心释放恰好一次、虚拟时间不额外推进 |
| Worker HTTP 单次阻塞读取可超出剩余总预算 | `sdk/native/src/worker.rs`：每跳 Agent 除 connect/read/write 上限外设置 overall timeout | 延迟 headers+body、重定向后累计耗时两项 Rust 测试；300ms 消融 old 492ms 后仍读成功，fixed 301ms 超时 |
| 微信 dispose 取消过程中重入新请求、abort/native destroy 异常后引用残留 | `sdk/targets/wechat/template/wechat-host.js`：先置 disposed 关闭准入，逐项隔离 abort 异常，先清引用再 destroy | 旧模板 2 通过/3 失败；新模板 5 通过，含重入、重复 dispose、异常及启动期间 dispose |

消融同时移除：旧 scalar TraceClock C ABI 和 last_* 缓存、恒空 duplex ring 导出、重复 ABI alias、
未构造的 RecordingLimitException、零调用 completed getter、Demo host 转发文件、buildGuest 字符串重载和无效 target 参数。
`PocketAppConfig.copyWith` 统一字段复制；有消费者的 recordedBytes/stop 保留。
TraceClock 结束时先关闭 Worker batch 再传播 quota failure，保留 v1/v2 录音语义。

**兼容性需复审：** 删掉的是仓内无消费者或有 canonical 替代的接口，但有些是公开导出。
仓外消费者可能需要迁移；不能用仓内零引用证明仓外没有调用。

详细原报告 P0/P1/P2/P3 与消融逐项表、源码行号、原始目标和修复后的区分，见
[REMEDIATION_E06720E_VERIFICATION.md](REMEDIATION_E06720E_VERIFICATION.md)。六份模块说明记录保留父工程出处和取舍。

## 2. argon 组：性能、渲染与输入

- `sdk/packages/pocket_flutter/lib/src/pocket_view.dart` 把 scene 与 editor overlay 的失效分开，
  批内合并刷新；保留同一个 scene Widget，结构相等的 DrawOps 不触发 canvas 重建。
  editor 继续使用原 controller、FocusNode、选区、composing 与 epoch，没有复制业务或输入状态机。
- 主/辅助 surface、资源完成/释放、host surface 的参数/焦点、video fit、DPR、宿主配置变化仍刷新 scene。
  editor wrapper 使用稳定 key，防止 canvas 分块变化重建 EditableText。
- 停表后才通知 performance callback，处理 callback 同步唤醒，避免重新 arm 旧 deadline；
  intentional idle 不进入活跃帧间隔或 FPS 分母。
- `pocket_performance.dart` 新增 `PocketLongFrameEvent`；复用 ticker/Flutter FrameTiming 记录真实 refresh budget、
  build/raster、bridge/decode、active gap、scope、JS context。FrameTiming 使用有界上下文队列和去重，
  没有增加常驻诊断 ticker。
- `sdk/lib/src/performance_history.dart` 独立保留 600 个 FPS 样本、240 个长帧事件；兼容旧文件。
  event-only burst 保留卡顿事实，但不以 fps=0 污染最低 FPS。每 10 次及 dispose 异步串行落盘，硬退出仍可能丢最后一批。
- `pocket_session.dart` 通过既有 `runtime.performance({context})` 接收有界 JS 上下文，向 JS 投递本次新增长帧事实。
  `nativeMs` 是 FFI、拷贝和 Dart 解码的总桥接路径，不能解释为纯 Rust CPU；`scope=flutterView` 属于整个 Flutter view。

对应测试为 `pocket_view_invalidation_test.dart`（含 DPR）、`pocket_performance_test.dart`、
`performance_history_test.dart`，这三组都在本次最终完整 Flutter 矩阵中实际运行。

## 3. argon 组：Showcase、编译和集成测试

- JS Performance 页面新增真实长帧阶段、refresh budget、事件历史与页面/动作上下文；
  JS 的 FPS 与 long-frame 历史分离，event-only 不污染 cadence。
- 按此前产品决定，Demo 暂时删除 Liquid Glass 页面、Home/Gallery 入口和对应演示转场选项。
  SDK `GlassSurface`、recipe、光学测试仍保留。该产品范围收缩需要 reviewer 明确注意，不能把隐藏入口写成性能问题已根治。
- `sdk/packages/pocket_ui/src/mobile.tsx` 使用 Solid memo + 单 effect 注册/更新 Glass surface，移除重复 onMount 注册。
  测试使用 pinned Solid 客户端 runtime，保留 cleanup。
- `sdk/packages/pocket_ui/src/index.ts` 导出 `SystemAppSurfaces`，使 pinned compiler 的 public-index preload
  收集默认 class 的 STYLE_IDS；继续使用原编译器和 compositor，没有第二个 renderer。
- Demo manifest/system 契约测试验证真正的 `create → awaitFirstFrame → platform.launch` 顺序。
  SystemAppSurfaces 编译回归以临时真实消费工程验证 STYLE_IDS，并在本次提交前运行中实际执行 native hostSurface 分支。
- `guest_interaction_test.dart` 记录 raw/clip/visible rect，优先 inputEnabled PocketView；
  reveal 分离 12 次拖动与最多 4 秒 settling，保留有界轨迹，不放宽可见性要求。
- `multi_app_test.dart` 增强 hostSurface handle/bounds/focus、隐藏 ticker、预热复用及故障回收断言。
  SystemUI 保留 compositor 根 `isPresented=true` 语义，与子应用焦点分开。
- 新 `FrameTimingCollector` 按源 FrameTiming 投影 build-start wall time，不按 callback 到达时间归属场景；
  trace 校验要求最慢源帧有完整 Dart Frame 区间。单测覆盖窗口边界、排序、无效时钟、未闭合 trace 与只覆盖快帧。
- 新键盘交互/纯 Flutter 对照脚本、jank/mini-app 聚合测试及 `save_interaction_capture.ts`：
  可保存 performance JSON、录音 manifest 和 SHA 校验后的内容寻址资产。生成归档不提交源码库。
- 保留的 Demo QJBC/PAK 为现有 tracked consumer assets 的同步更新；main/profile/lobby 的 QJBC 长度、payload SHA-256
  与各自 metadata 已核对一致。不提交 Cargo/Flutter/node 缓存或设备生成归档。

## 4. 验证证据与边界

### 本次提交前负责人重跑

合并快照为 `/tmp/pocket-fix-verify`，捕获源码后通过 SHA-256 对照确认没有并行源码漂移；
后续只补摘要和文档措辞。日志在 `/tmp/pocket-submit-review/`。

| 检查 | 结果 | 日志 |
|---|---|---|
| 五包 `flutter analyze --no-pub`，串行 | 全部 0 issues | flutter-*-analyze.log |
| pocket_services Flutter test | 27 通过、0 失败、0 跳过 | flutter-services-test.log |
| pocket_flutter Flutter test | 116 通过、0 失败、0 跳过 | flutter-flutter-test.log |
| sdk Flutter test，真实 Worker fixture + native dylib | 62 通过、0 失败、0 跳过 | flutter-sdk-test.log |
| demo Flutter test | 27 通过、0 失败、0 跳过 | flutter-demo-test.log |
| SDK `bun test`，显式 native probe | 76 通过、0 失败 | bun-sdk-with-probe.log |
| Demo JS `bun test`，显式 native probe | 14 通过、0 失败；compiler + native hostSurface handle/bounds/clip 实际通过 | bun-demo-with-probe.log |
| tracked QJBC metadata 校验 | main/lobby/profile 长度和 payload hash 均匹配 | 提交前命令输出 |
| `git diff --check` | 通过 | 无输出，exit 0 |

本次最新快照 Flutter **232** 项、Bun **90** 项通过。hardware 没有 `test/` 目录，
上一轮实际执行已得到 `Test directory "test" not found.`，本次没有伪造 hardware 测试或重复运行同一缺失命令。

沿用同一原生修复源码的上一轮证据：Rust **82** 通过、0 失败、1 手动吞吐基准 ignored；
locked native build、固定上游 verify-only、architecture check、真实 Worker fixture、
test_guest 的 QJBC 消融/指针/输入/host response/stress 均通过；
三类 Worker turn 篡改回放均拒绝，普通子应用 compositor 越权拒绝。
原日志在 `/tmp/pocket-fix-e06720e/`，没有将其冒充本次重新执行的命令。

SDK Bun 首次在隔离目录未设置 native probe，出现 2 个 native-test 初始化错误；设置下列环境后完整重跑通过，
原失败 `bun-sdk.log` 保留。新功能的可选 native 分支已经通过显式 probe 补验。

```sh
export CARGO_TARGET_DIR=/Volumes/ORICO/Development/Github/pocket/sdk/native/target
export POCKET_NATIVE_LIBRARY=$CARGO_TARGET_DIR/debug/libpocket_flutter.dylib
export POCKET_NATIVE_PROBE=$CARGO_TARGET_DIR/debug/pocket_probe
export POCKET_RECORDING_WORKER_FIXTURE_DIR=/tmp/pocket-worker-fixture-fixed
export TMPDIR=/tmp
# Flutter 各包依次 analyze/test，禁止并行启动测试。
# Bun SDK 和 demo/js 构建测试也顺序执行，避免上游依赖安装冲突。
```

### argon 并行工作的既有模拟器记录

以下是读取并核对的已有日志，本次提交整合没有重新启动设备测试。目标为 **iPhone Duo 模拟器 debug**
`4D366210-290E-46DB-8BC6-3C5233700409`，不能称为 iOS 真机：

- `/tmp/pocket-no-glass-device-regression-final.log`：5 个业务场景 + tearDownAll，终值 `+6 All tests passed!`。
  覆盖真实系统键盘生命周期、Flutter text client、滚动、Mobile UI 导航、Home/Gallery 无 Glass 入口。
- `/tmp/pocket-no-glass-miniapps-final.log`：3 个业务场景 + tearDownAll，终值 `+4 All tests passed!`。
  包括 A/B 消息与结果、预热复用和失败回收；一次 cold=150ms、warm=101ms，仅为该次观测。
- `/tmp/pocket-duo-system-keyboard-final.log`：系统键盘场景 + tearDownAll，终值 `+2`。
- `/tmp/pocket-duo-jank-complete.log`：真实 UI isolate 可控阻塞、history 落盘/恢复，终值 `+2`。

存在较早失败日志：`pocket-duo-jank-final.log` 的旧文案断言、
`pocket-duo-miniapp-jank-complete.log` 的旧 SystemUI isPresented 断言。不能因文件名带 final/complete 就当作成功。
后续 no-glass 日志与当前测试断言应一起复核；不声称旧日志精确绑定当前 Git tree。

**不作保证：** 微信 DevTools/真机、Android 真机、iOS profile/release/AOT、GPU/功耗、
所有时钟与刷新率组合均未由本次提交验收。旧按 callback 到达时间归属的 Glass/键盘数字、
开启 recording/trace 的数字不能用于普通运行的性能 A/B；低 FPS 窗口本身不是卡顿根因证明。

## 5. 建议独立 reviewer 优先检查

1. 原始 P1/P2 五项是否在真实调用链闭环；不要只运行既有全套后给结论。
2. retained scene 的失效覆盖：reload、辅助 surface、异步资源、字体/DPR、配置、焦点和 dispose，
   尤其 scene 批处理消费 editor pending 的路径是否保持最终输入状态。
3. FrameTiming 配对的 2ms 容差、有界队列、重复/延迟/未匹配 timing，及多 PocketView 的 whole-view scope 是否错误归因。
4. idle 期间性能 callback 同步 wake/dispose/替换 runtime 时，旧 Timer、notifier 和 listener 的所有权。
5. JS 与 Dart history 的事件合并/去重键是否丢失同 timestamp 的不同 scope/context 事实；event-only 的恢复兼容性。
6. visible waiter 在失败、销毁、generation 变更的拒绝；当前新 FFI 测试覆盖 Offstage/失败/销毁，
   不伪造可见 hostSurface 或 OTA replacement，后两者仍需真实 SystemUI 场景。
7. 删除公开导出的兼容影响、Demo Glass 产品取舍，以及 SystemAppSurfaces public index 对编译收集面的影响。

可直接给 reviewer 的任务：

> 对 `git diff e06720e5ab88e9ff211d3eedfe2d768cb77a004b..HEAD` 做独立代码与运行证据复审。
> 阅读本说明和 `REMEDIATION_E06720E_VERIFICATION.md`，把它们当待核查声明，不当证明。
> 默认只读；可以使用隔离 worktree、构建缓存、/tmp 脚本；不要覆盖工作区、停止服务或读取私钥。
> Flutter 测试串行执行。按 P0/P1/P2/P3 报告可复现残余或新回归，给出文件行号、触发条件、
> 实际证据和最小修复建议。区分原始 e06720e 的缺陷、当前提交的修复、历史模拟器记录和当前实际运行结果。
