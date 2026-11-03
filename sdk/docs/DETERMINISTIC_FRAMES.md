# PocketJS 确定性帧：开发价值与 Flutter 接入边界

下文保留接入前的源码研究快照。本轮后续已实施 native trace clock、宿主事务录制、JS 上游适配和归档入口；当前 API、实际验收与仍未覆盖的语义见 [RECORDING_REPLAY.md](RECORDING_REPLAY.md) 和 [VALIDATION.md](VALIDATION.md)，不能将下方历史“未完成”当作当前状态。

2026-11-03。基于固定 revision `99924de47c62fa36f526a8791055d91cbbdb3836`，源码通过 `scripts/prepare_upstream.py` 重建到 `.cache/pocketjs/`。本轮由 GPT-6 Luna / max 独立核查上游和旧 demo，并执行有界 native probe；没有以文档宣传代替当前 SDK 验证。

## 契约是什么

上游 `docs/DETERMINISM.md` 将应用视为虚拟帧事务：

`state[n + 1] = F(state[n], input[n], effectDeliveries[n])`

要复现相同状态和输出，必须固定构建/资产/初始状态、模拟频率、逐帧输入和外部结果的投递帧与顺序。它不是“锁定 60 FPS”，也不保证网络、设备和操作系统的真实时间可重复。

`framework/src/index.ts` 的 frame pump 按约定顺序推进时钟、effect delivery、app hooks、输入、响应式效果、清理和 core ticks。`framework/src/clock.ts` 的 `after()` 使用虚拟期限，期限相同时以插入序号决定顺序。应用计时应使用 `virtualNow()` / `after(seconds)`，随机行为使用显式 seed 状态。

低模拟频率可减少测试观测量；上游测试比较 60、4、2 Hz 的旅程。只有以秒为语义且不依赖具体帧编号的逻辑，低频结果才适合作为高频轨迹的抽样。不能用 2 Hz 测试证明 120 Hz 的所有中间动画、触控或碰撞都正确。显示刷新率、模拟频率和 FPS 统计是三个不同概念。

## 已有工具应直接复用

| 上游来源 | 已有能力 | 对开发的用途 |
| --- | --- | --- |
| `framework/src/devtools.ts`，`docs/DEVTOOLS.md` | 有界 flight recorder、`globalThis.__pocketDevtools.dumpTape()` / `replay()`；最多 36,000 帧，RLE 按钮/摇杆及稀疏触控、相对轴、motion track | 收集导致问题的操作，从启动状态回放；减少依赖描述和手工重试。 |
| `framework/src/effects.ts` | `runEffect`、`installEffectDriver`、host 注入 `__pocketEffectDriver`；结果在下一虚拟帧开始按 FIFO 投递；`__pocketEffectTrace` 记录命令/投递帧 | 将网络/设备结果视为可注入输入，在测试里固定成功、失败、取消和迟到顺序。 |
| `programs/sim/sim.ts`，`tests/sim.test.ts` | 无屏幕/vblank/墙钟的 headless sim，按脚本快速推进并记录 framebuffer hash、effect trace 和 RGBA | 快进 timer、导航和复杂业务流程，做稳定 CI；无需为 30 秒虚拟超时实际等待 30 秒。 |
| `tools/tape.ts` | tape 回放、逐帧 hash 比较、首个差异帧定位和画面保存 | 定位状态/绘制回归的首次分歧，而不是只看最终截图或平均 FPS。 |

`effect` 的 callback API 有意不直接 await Promise：Promise 完成时点由外部 JS 调度影响。真实 driver 可以异步完成工作，但进入业务状态的 delivery 要纳入帧事务。输入 tape 本身不包含完整的 effect 结果 payload，也没有 text/IME track；因此不能只导出 touch tape 就宣称完整会话可回放。

DevTools 有自己的可选 transport/poll cadence。接 Flutter 时应复用当前事件/控制通道，调试面板未连接时停止快照/日志发布；不要为了调试恢复生产绘制的周期探针。生产版本的 recorder/trace 成本、保留内容和开关也应单独消融。

## 对这个项目的直接帮助

1. **复现输入和页面问题。** 把触控、视口/安全区、键盘 inset、文本值/selection/composing、应用生命周期及外部响应按帧记录，回放“点击输入后页面晃动”“键盘立刻关闭”等序列。Flutter IME 仍需设备集成测试，不能只录最终字符串。
2. **稳定回归。** 多 App A→B→C→返回、取消/失败、预热/淘汰、热更新等都能使用固定外部结果序列。测试应断言状态、generation、请求结果及首个画面差异，不依赖任意 `sleep`。
3. **更快测试。** 用现有 sim/虚拟时钟快进 timer 和业务期限，减少 wall-clock 等待。普通 UI 单测优先复用这个运行底座；真实相机/BLE/系统键盘仍保留目标平台测试。
4. **性能比较。** 用同一 tape 固定负载后，对比 JS/native/桥接/绘制分段耗时、长帧和唤醒次数。确定性方便定位同一逻辑帧，但它本身不是 profiler，也不直接提高 FPS 或证明省电比例。

绘制指令可以作为逻辑回归基线；逐像素比较必须固定 renderer、字体、density、viewport 和平台。上游 sim 的 RGBA hash 不等于 Flutter/不同 GPU 的像素保证。

## 当前 Flutter SDK 的实际覆盖

| 部分 | 当前情况 |
| --- | --- |
| 固定步进和虚拟时钟 | 已接：构建/加载设置 `__simHz=tickHz`；native 将 Flutter 单调 Scheduler delta 换算成固定 guest/core ticks，并有 catch-up 上限。输入边缘保留独立事务，不能为追 FPS 合并丢失 DOWN/UP。 |
| 按需停表/快进 | 已接：只跳过已知空闲帧，不越过最近 timer；动画/physics 等真实工作保留执行。不是根据 DrawList unchanged 猜无工作。 |
| Promise 续体唤醒 | 本轮已补真实 QuickJS pending-job 提示。credited 零 tick 边界不虚构逻辑帧；job 待执行时保持唤醒，下一真实 fixed tick 走原有 `Guest::frame → collect`，250ms 预算不变。 |
| DevTools/tape transport | 未接完整 Flutter transport/导出入口。上游已有 recorder，不能另造第二套 JS 时钟或 tape 引擎。 |
| Effect driver 和结果 tape | 当前 HostBridge/SystemUI RPC 使用 Promise；没有完整记录外部响应的帧和 payload，也没有统一安装上游 effect driver。它们的异步完成顺序仍是外部输入。 |
| 完整确定性 replay host | 未完成。live FFI 在外部事件到达前用 `Instant.elapsed()` 结算空闲时间；仅重放相同 delta/input 命令还不够。 |
| 系统文本输入 | 当前系统 IME bridge 可用，但 native `GuestFrame.text` 为空；需要额外记录当前桥接实际使用的 text/selection/composing/inset 协议。 |

关键源码：`native/src/lib.rs` 的 `evaluate_guest`、`fixed_tick_count`、`run_virtual_frames`、`pocket_send`；`native/src/demand.rs` 的 `ticks_for_delta`、`before_external`、`capture`；Flutter `packages/pocket_flutter/lib/src/pocket_view.dart` 的 `_onTick`。

### live 墙钟与 replay 的差异

正常运行需要在休眠后正确安排新 timer。因此 `before_external()` 在分发事件前，按 `Instant.elapsed()` 结算已休眠时间，再通过 `elapsed_credit_ms` 抵消后续显示 delta，避免重复记账。这适合 live 宿主，但把真实事件间隔带进了虚拟进度。

独立 probe 两次执行相同显式 delta/input 序列，只将注册事件前的真实等待从约 50ms 改为约 250ms，观察到注册时 virtual frame 分别为 11、15，due 为 311、315。数字包含进程/JS/调度开销，不是精确毫秒换算；它证明必须把 idle 时间也纳入 replay 输入。当前 Rust 测试也明确验证两秒 idle 会在注册前推进 120 帧。

另一个纯确定性 guest 在两次 native probe 中得到相同颜色序列 `[4281558732, 4288243251, 4281558732]`；替换为 `Math.random()` 或 `Date.now()` 后结果不同。这是有界行为证据，未运行上游完整 sim CI，也不证明任意应用跨平台逐像素相等。

### 实际执行的上游语义测试

在已准备的固定上游目录运行：

```sh
cd sdk/.cache/pocketjs
bun test tests/clock.test.ts
```

结果为 **9 pass、0 fail、26 expect**（本轮日志 `/tmp/pocket-deterministic-clock-test.log`）。覆盖虚拟帧计时、同期限 timer 插入顺序、零延迟不能同帧执行，以及 effect 的 FIFO、仅完成一次、嵌套投递留到下一 drain、host driver 优先级和带帧号 trace。这验证了时钟/effect 基础契约，不代表 Flutter 已接通 replay driver。没有运行需要额外 WASM/应用构建的完整 `tests/sim.test.ts`。

## 最小落地顺序

1. 先接现有 DevTools flight recorder 的受控导出，保存 build/ABI/PAK hash、viewport/density、tickHz、初始状态和输入 tape；不用新 recorder 重复维护现有 track。
2. 在已有 HostBridge 边界增加可选调试 recorder/replay driver，记录 capability/effect 命令、结果/错误和实际投递虚拟帧；扩展当前 IME、视口和生命周期 lane。硬件重放返回录制数据，不再次实际拍照/连接设备。
3. 在现有 native host 加显式确定性时钟模式：事件使用录制的虚拟帧时间，关闭 live `Instant` 结算；保留当前 live 行为。不要靠补 sleep、强制多 tick 或一直 vsync 来掩盖时间输入。
4. 复用 `programs/sim`、`tools/tape.ts` 建立首差异帧与状态基线，再补 Flutter renderer/IME 的设备基线。固定 tape 后做按需调度、预热和传输的消融，分别报告工作量、响应时延与持续 FPS。

旧 demo 中 `mini_apps/app_game_detail/main.js` 直接依赖 VSync dt，UIkit 随机样式直接用 `Math.random()`，不适合原样当确定性测试基线。沿用其交互场景，计时和外部数据应改走上游已有契约。
