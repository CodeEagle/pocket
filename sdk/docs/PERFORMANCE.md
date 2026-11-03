# 性能继承与测量

2026-11-03 口径更正：原 Pocket 角标/兼容 `fps` 历史统计 Guest 活动 ticker/native turns，已改名 `Guest ticks/s`；Demo 根层现独立使用 Flutter `FrameTiming.vsyncStart` 统计 `Flutter FPS`。旧 `fullyLive` 集成测试绑定会自动请求后续帧，下面这类测试里的静态约 60Hz 不能证明普通运行时的自然帧率或空闲功耗。历史 UI/raster 耗时仍是相应测试负载下的测量，不能据此否定用户看到的卡顿。新口径、普通 Flutter 运行验证和开源方案比较见 [FLUTTER_FPS.md](FLUTTER_FPS.md)。

2026-11-02，Apple Silicon；Flutter 3.35.7 / Dart 3.9.2 / Xcode 27.1。以下是本机测量，不是跨设备 FPS 保证。

## 已继承的优化

对照 PocketJSKit 的实际文件：

- `pocket_view_painter.dart` 与 `pocket_text_cache.dart` 完全一致。
- native delta marker → Dart 不解码完整帧、不触发视觉 setState。
- 每 32 DrawOps 一块 RepaintBoundary；未变化分块保留 raster layer。
- 共享有界 TextPainter LRU，容量 256；图片按 identity/revision/epoch 缓存。
- native DrawList 缓存、frame JSON 缓存、资源 revision 去重、浮点 deltaMs 均保留。

原 demo 中模拟 C/runtime 的 dirty mask、ring buffer、忽略时间步进的“高 FPS”路径没有迁入真实 QuickJS 引擎。Web 编辑器 CSS/动画优化也不是 Flutter 性能证据。

## macOS profile 实测

`bun run profile:macos` 使用真实 vsync 与 Flutter FrameTiming。预热后每场景测 4 秒，不通过循环 `pump(16ms)` 制造 FPS；静态页面仍运行 native ticker，Canvas paints 是实际 paint 调用计数。

| 场景 | 实测 Hz | UI build p95 | raster p95 | 超出 16.67ms 预算帧 | Canvas paints |
| --- | ---: | ---: | ---: | ---: | ---: |
| 首页静态 | 60.0 | 0.74ms | 2.50ms | 0 / 244 | 0 |
| 每个 vsync 更新 JS 计数 | 59.7 | 5.28ms | 2.29ms | 1 / 240 | 238 |
| 500 retained nodes 静态 | 60.0 | 1.49ms | 6.99ms | 0 / 241 | 0 |

原始本机产物：`artifacts/performance/macos-profile.json`（生成文件，不提交）。Profile 构建同时修复了 macOS project 的架构配置：当前 Rust 归档只支持 arm64，因此 profile/release 明确使用 arm64。

## iPhone Duo 模拟器 debug 实测

同一 `performance_test.dart`，iOS 27.1、60Hz、每场景 4 秒：

| 场景 | 实测 Hz | UI build p95 | raster p95 | 超预算帧 | Canvas paints |
| --- | ---: | ---: | ---: | ---: | ---: |
| 首页静态 | 60.0 | 1.49ms | 1.16ms | 0 / 243 | 0 |
| 每个 vsync 更新 JS 计数 | 60.0 | 4.58ms | 0.86ms | 0 / 235 | 239 |
| 500 retained nodes 静态 | 60.0 | 1.52ms | 2.83ms | 0 / 237 | 0 |

这是模拟器 debug 的真实 engine FrameTiming，不是 iOS 真机数据，也未覆盖 500 节点持续动画。本轮没有复现用户报告的持续低 FPS；需对齐具体页面、设备与操作后继续定位，不能据此否定用户现象。

## native full / delta 消融

`native/src/bin/pocket_bench.rs` 直接链接 release runtime，加载真实 qjbc/PAK，预热后采集 300 帧。结果只包含 engine/FFI，不包括 Dart JSON 解码、widget build 或 GPU。

| 场景 | full p50/p95/p99 | delta p50/p95/p99 | 返回数据 |
| --- | --- | --- | --- |
| 首页静态 | 25/28/35µs | 22/24/26µs | full 约 27.1KB/帧；delta 平均 108B/帧（含首次完整帧） |
| 动态计数 | 94/98/100µs | 94/197/280µs | 两者约 27.1KB/帧 |

delta 在空闲场景约减少 250 倍返回数据；当前实现是在完整 guest/layout/resource pass 后判定，所以 native CPU 降幅较小。动态场景不保证加速，单次短测 p95 的波动不能直接当成长期回归。

```sh
cd /Volumes/ORICO/Development/Github/pocket/sdk
cargo run --locked --release --manifest-path native/Cargo.toml --bin pocket_bench -- \
  --bytecode ../demo/assets/app.qjbc \
  --pak ../demo/assets/app.pak \
  --frames 300
cd ../demo/js
bun run profile:macos
```

## 后续结构优化与历史基准

当前实现已落地 PFB1 二进制 frame/resource ABI，数值 DrawOps 与像素数据不再走完整帧 JSON；Dart 仍会复制借用 buffer 并解码，并非端到端零拷贝。上文 full/delta 表为当时 JSON 路径的历史测量，不能作为当前 PFB1 的基准。native 的早期 needs_frame/visual epoch、减少 DrawList 全量比较与 clone 仍可研究。后续应针对可复现的低 FPS 场景测出占用，不通过跳过定时器、Promise、输入和动画语义换取名义 FPS。

模拟器 debug 与真机 profile/release 必须分开记录；这轮没有 iOS 真机性能结论。

## 持续 FPS 标签与历史

- 右上角常驻 `FPS xx | min xx`，由 `showDebugFps` 显式控制，debug/profile/release 均可显示。`min` 是当前 runtime 会话最低采样值；首次有效窗口前显示 `--`。
- 每约 1 秒记录真实 ticker 时间窗口：FPS、frames、durationMs、maxGapMs、超过 1.5 个显示帧预算的 slowFrames、refreshHz，以及桥接/解码耗时 p95（兼容字段名 `nativeMsP95`，并非纯 native CPU）。
- 窗口之间保留连续时间基线，避免漏掉边界处长卡顿或把首个零间隔 tick 算成一帧；暂停/恢复重置窗口，后台停留不记作低 FPS。初始字节码加载不计入。
- **Host → Runtime → FPS history** 是 JS 页面，显示最近 60 点、最低 FPS 与时间戳。独立 performance signal，避免每秒诊断样本重建整个业务状态或 500-node 列表。
- 内存和文件保留最近 600 条；每 10 条及正常 dispose 时异步串行写盘。日志错误不会使业务 runtime 回滚；硬退出可能丢失最后不足 10 条。
- 本地路径：`getApplicationSupportDirectory()/pocket-performance/<appId>/history.json`。

`../demo/integration_test/fps_history_test.dart` 通过定时阻塞 UI isolate 制造可控卡顿，验证标签最低值下降、JS 历史可见、文件记录大 gap/slow frame 和重启恢复。该测试刻意产生的低 FPS 不能误认为应用自然掉帧。

## 公共 SDK 集成后的基线（2026-11-02）

Duo 模拟器 debug、60Hz，每场景预热后采集 4 秒；原始结果为 `artifacts/performance/sdk-iphone-duo.json`。

| 场景 | 实测 Hz | build p95 | raster p95 | 超预算帧 |
| --- | ---: | ---: | ---: | ---: |
| 首页静态 | 59.508 | 2.009ms | 1.768ms | 1 |
| 每个 vsync 更新计数 | 60.000 | 4.756ms | 0.919ms | 0 |
| 500 节点静态 | 60.000 | 1.655ms | 2.981ms | 0 |
| Glass 静态 | 59.504 | 1.562ms | 3.102ms | 0 |

静态页面 Canvas paints 为 0，动态计数为 240。Glass 预热 3 秒；进入页面时仍观察到短时低帧，不能用稳态结果证明转场或键盘动画不存在卡顿。上述是短时模拟器基线，不是 iOS 真机 profile 性能结论。

## 单帧卡顿记录（2026-11-03）

除了 FPS 窗口，宿主现在保存最近 240 条 `longFrameEvents`。每条记录包含 UTC 时间、实际 `refreshHz`、`budgetMs=1000/refreshHz`、可用的 Flutter `buildMs/rasterMs`、桥接与解码耗时 `nativeMs`、连续活跃帧间隔 `activeGapMs`，以及 JS 提供的页面/动作 `context`。任一实际阶段或活跃间隔超过 1.5 倍预算才记录；没有 60 FPS 上限。空闲停表和恢复后的休眠间隔不计为卡顿，稀疏更新的低 FPS 本身不构成长帧证据。

`scope=flutterView` 表示 Flutter 引擎整幅视图的 build/raster 指标，不能据此把共享视图开销归因到某个子应用；`scope=pocketView` 是该 PocketView 的桥接或活跃间隔证据。`nativeMs` 包含 FFI、返回帧复制和 Dart 解码，不代表纯 Rust CPU。

复用已有活跃 ticker 和 Flutter FrameTiming 回调，不新增探针轮询或常驻 ticker。短时活跃后停表也会投递未发送事件。只有事件、没有有效 cadence 的投递不写入 FPS 窗口，也不会把最低 FPS 改成 0；旧文件恢复时同样过滤这些无效窗口。磁盘沿用每 10 个样本及 dispose 时异步串行写入，硬退出仍可能丢失最后一批。JS 通过已有 `runtime.performance({context})` 在动作变化时提供上下文，性能页显示近期长帧分解；诊断不另建 Dart 路由状态机。

Mini Apps 本轮实际失败原因是 Showcase manifest 仍声明已移除的 `system.runtime.present`，运行时实际调用 `system.runtime.awaitFirstFrame` 被拒绝，打开事务随后回滚并回收实例。已对齐声明；新增契约测试从 Dart 注册表提取合法方法，并执行 JS 打开流程，避免只检查硬编码字符串。

本轮实测：`flutter drive --no-pub --no-dds --driver=test_driver/integration_test.dart --target=integration_test/fps_history_test.dart -d 4D366210-290E-46DB-8BC6-3C5233700409` 在 Duo 模拟器通过，实际在 Flutter UI isolate 每 60ms 阻塞 45ms，并断言本轮产生的逐帧事实越过实际刷新预算、落盘及新 Host 实例恢复。此人为阻塞仅存在测试中。JS 测试 13 项、绘制与性能测试 24 项通过；这证明记录链路，不是功耗或真机高刷新率验收。

第二处 Mini Apps 阻断来自编译入口：公开包提供了 `@pocket/ui/system-surfaces` 子路径，但编译器 pass 1 只预加载 public index，未遍历该组件，因此缺少完整默认 class 的 STYLE_IDS。strict 样式解析抛错后没有插入 compositor node；resident fallback 仍能预热子应用，造成“首帧已准备但画面未呈现”。现将 `SystemAppSurfaces` 纳入 public index，沿用原编译器与原合成组件。新增 `demo/js/tests/system_surface_compiler.test.ts` 以临时消费工程走真实编译链，并在本机 native probe 中验证输出有效 handle/bounds/clip 的 hostSurface。没有新增 Dart 呈现调度或第二套渲染层。

Mini Apps 修复后的 Duo `multi_app_test.dart` 三个实际场景全部通过：Profile→Lobby 身份/消息共享并返回结果；冷启动与预热实例复用、隐藏 realm 停表；运行时失败回收及 owner 失败清理。SystemUI 作为 compositor 根层始终保留，测试同时要求前景子应用实际呈现并获得焦点。本机一次短测 cold=201ms、warm=103ms，仅作复现记录。最终全仓 `bun test`：81 pass/0 fail，含真实编译与 native compositor probe。

## Glass / 系统键盘交互录制与卡顿复现（2026-11-03）

`demo/integration_test/interaction_jank_test.dart` 从实际点击前开始采样，而不是等页面稳定三秒后才测。覆盖 Glass 首开/再开、真实系统键盘首开/收起/再开/再收起。先滚动到目标再开始窗口；不注册 TestTextInput、不增加驱动 ticker、不用 16ms pump 制造 FPS。记录 Flutter FrameTiming、真实帧桥接调用耗时、IME inset 和同期持久化长帧。桥接探针仅覆盖 frameDelta 调用，不能当成全部 FFI 成本。`engineSpanHzIncludesIdle` 只是该窗口内 engine 帧的跨度比率，包含有意空闲，不能等同持续动画 FPS。

Duo 60Hz 模拟器 debug，旧采样脚本一次关闭录制的历史输出（ms；非真机功耗或 AOT 性能保证）。该版按 FrameTiming 回调到达时间归属场景，可能混入前一场景延迟投递的帧；以下数值保留供追溯，不能直接用于优化前后的收益比较：

| 操作 | build max | raster max | frame bridge max |
| --- | ---: | ---: | ---: |
| Glass 首开 | 22.3 | 6.7 | 4.6 |
| Glass 再开 | 22.5 | 3.0 | 15.9 |
| 系统键盘首开 | 79.8 | 1.4 | 2.8 |
| 系统键盘再开 | 20.9 | 1.8 | 2.9 |
| 键盘首次收起 | 15.0 | 1.9 | 5.5 |
| 键盘再次收起 | 12.7 | 1.9 | 6.2 |

这些历史输出提示交互期存在长 build，需要校准帧归属后复测；稳定页面的 60Hz 结果不能否认首开卡顿。初步消融中，提前加载 FragmentProgram 未观察到稳定收益；去除复杂 InputDecoration 的首开仍约 68ms、暖开约 20ms，没有证明解决了主要瓶颈。两个候选修改均已撤回，不保留无明确收益的预热层或改变输入框外观。玻璃光学 shader/saveLayer 和输入 composing/geometry 语义保持原实现。旧 demo 可复用的输入生命周期来源为 `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`，玻璃 recipe 缓存来源为 `mini_apps/pocketjs_uikit.js`；没有搬入旧 VDOM renderer。

诊断链修复了两个确证问题：无 Pocket 原生帧上下文的 Flutter 长 build（如第一次创建输入控件）原先漏记，现在作为 `scope=flutterView` 的独立事实记录，不填充伪造的 native/gap 耗时；停表时同步诊断广播的唤醒原先可能被随后停表和旧 deadline 覆盖，现在先停表，再检查回调是否已重新唤醒，避免延迟到旧定时器。idle gap 也直接依据睡眠标记排除。绘制/调度相关定向回归 26 项通过。

### 使用已有确定性录制，不新建第二套录制器

```sh
cd demo
flutter drive --no-pub --no-dds \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/interaction_jank_test.dart \
  --dart-define=POCKET_PERF_RECORD=true -d DEVICE_ID
cd js
bun run perf:save
```

测试通过 `PocketRecordingLibrary` 捕获真实输入/viewport/host 事务，在原实例销毁后导出归档并执行离线 `replayArchive`。本轮真实采集验证了 623 条事务、225 帧一致，没有 mismatch。`perf:save` 从 driver 报告提取性能 JSON、录制 manifest 和内容寻址资产到新的 `demo/artifacts/performance/interaction-*` 目录，校验资产 SHA，避免测试卸载后丢失归档。输出目录已被 artifacts ignore 规则排除，不把字节码归档重复提交到源码仓库。

要测性能，去掉 `POCKET_PERF_RECORD=true` 再跑同一交互脚本并保存另一个目录。录制会增加事务摘要/哈希成本，本轮捕获时 frame bridge 峰值达到约 49ms，不能把开启录制的数据作为普通运行性能。回放验证的是 SDK 执行事实与帧输出；它不重演系统键盘自身的渲染耗时、Flutter build/raster 或 GPU 功耗。优化前后真实时间采样和离线行为一致性是两条互补证据。

纯 Flutter 对照：`flutter_keyboard_control_test.dart` 在新进程点击后才挂载同风格 TextField 并打开真实 IME；无 Pocket 依赖。旧脚本本机首开 build max 125.9ms，暖开 6.7ms，收起 5–6ms，实际 inset 为 792→0。该版本同样存在批量回调的场景归属问题，且首个窗口紧邻应用挂载；125.9ms 可能包含启动帧，不能据此把 Pocket 首开卡顿归因给 Flutter。两者 widget 树也不同，不能将约 21ms 减去约 7ms 当成 SDK 净成本。需要使用修正后的同一采样方法分别复测；这不是 release/AOT 对照，不声称框架消除了键盘卡顿。

### 局部失效与交互窗口校准

`PocketView` 复用了旧工程 `lib/render/pocket_ui_components.dart` 的局部监听与保留绘制子树模式，适配真实 DrawOps/原生 TextField 合约：

- scene/editor 两个 notifier 仅表示失效，不复制 frame、文本、选区或滚动状态。值与 composing 通过原 controller 同步；rect/style/open/close 只更新 editor。一次 frame 的多个事件合并通知，scene 同时变化时由 scene 更新消费最终 editor 状态。
- 主/辅助 DrawOps、surface 的参数与焦点、资源完成/释放、宿主输入属性变化仍刷新 scene。比较复用现有 op 等价逻辑并补 video fit，不以新解码 list 的 identity 作为变化证据。
- 保留同一个 scene Widget，FPS 标签的外层 `setState` 不再穿透场景。固定 editor wrapper key，使 canvas 分块数量变化不重建 EditableText；controller、FocusNode、选区、composing 和编辑 epoch 沿用原实现。
- DPR 单独变化时显式失效，防止缓存画布继续使用旧像素网格；同 DPR 的键盘 metrics 不增加这条失效。该回归先在新测试中复现，再补修复。
- 宿主 resize、原生键盘和 JS 滚动合约保持原有行为；本轮没有启用稳定全高 viewport，也没有新增 Dart 滚动/路由状态机。

Glass 延续旧工程 `mini_apps/pocketjs_uikit.js` 的 recipe 复用思路：用 Solid memo 缓存 recipe 和字符串 payload，以一个 effect 注册/更新 surface，移除重复的 `onMount + effect` 注册。没有额外的全局 surface cache、注册状态机或 shader 预热。测试在隔离子进程使用 pinned Solid 客户端 runtime，覆盖真实 effect/memo/cleanup 行为，未用手写响应式实现代替 Solid。

`frame_timing_collector.dart` 持续接收引擎 timings。每次操作前清理旧 batch，操作后等待延迟 batch；源帧归属使用：

```text
buildStartWallUs = rasterFinishWallUs - (rasterFinishUs - buildStartUs)
```

后两项取自同一 FrameTiming 的 monotonic phases，不拿 scheduler 的 vsync target 时间直接比较 vsync start，不假定 16.67ms。按投影后的 build-start 时间选帧并排序；场景必须有有效 timings，空结果不报告为零耗时。纯 Flutter 对照使用同一 collector。键盘关闭改为点击固定页头，避免把 Gallery 路由创建算进关闭耗时。窗口长度约 1.4 秒，`wallClockMs` 表示采样窗口长度，不是点击响应延迟；`engineSpanHzIncludesIdle` 也不是持续动画 FPS。Flutter view 指标还包含测试框架和系统键盘造成的 view 工作。

```sh
cd demo
# Demo 行为回归：真实键盘生命周期、中文输入、滚动与页面导航
flutter drive --no-pub --no-dds \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/jank_regression_test.dart -d DEVICE_ID
# 同一键盘交互的轻量时间线，用于归因
flutter drive --no-pub --no-dds \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/interaction_jank_test.dart \
  --dart-define=POCKET_PERF_TRACE=true -d DEVICE_ID
```

默认 Trace 模式保留框架阶段与 `Pocket.frameDeltaAt` span，并在 tap 前插入操作 marker；额外传入 `POCKET_PERF_WIDGET_TRACE=true` 才逐 Widget 采集 build/layout/paint。测试检查最大 build 帧是否落在完整的 Dart Frame 区间内；未覆盖时直接失败，避免 VM ring buffer 丢失开头后仍报告诊断成功。Trace 耗时单独存放，不与普通运行作数值比较。录制仍使用前述 `POCKET_PERF_RECORD`，用于执行/帧一致性验证。

按用户后续决定，Demo 暂时移除 Liquid Glass 页面、入口与演示转场选项；`interaction_jank_test.dart` 现在只测键盘，日常 `jank_regression_test.dart` 聚合输入、滚动和移动页面导航回归。SDK Glass 组件与独立光学回归文件保留，前面的 Glass 数据作为历史实验记录。本轮临时关闭路由转场的消融已恢复：关闭转场降低了后续帧工作量，却未消除首帧尖峰，没有将关闭效果作为正式性能修复。

新版键盘轻量 trace 已验证四场景最慢帧均完整覆盖。一次 Duo 模拟器 debug 首开 build 为 57.772ms；对应 Dart Frame 61.811ms，其中 LAYOUT 为 47.606ms，嵌套 BUILD 为 40.051ms，PAINT 为 5.316ms，frame bridge 为 1.166ms。该 Frame 无 GC 重叠，UI 线程最大编译 span 1.515ms，不能将后台编译总时间当成 UI 阻塞。暖开 build 为 13.764ms，对应 LAYOUT 9.384ms、嵌套 BUILD 7.317ms、frame bridge 1.377ms。这定位到 layout/build 区间，尚未证明某一个 Widget 是全部根因；也不能把轻量 trace 的耗时当成普通运行的收益结论。未经 trace 的重复采样仍有较大波动，本轮不宣称消除了首开尖峰。

移除 Glass 后，对四个真实键盘场景重新录制，在销毁原 session 后离线回放：402 条事务、145 帧全部匹配。归档在本机 `demo/artifacts/performance/interaction-2sBZ4M/`；窗口与 trace 原始报告在 `demo/artifacts/performance/jank-fix-20261103T061326Z/`。这些是被忽略的生成文件，不提交到源码；该结果只验证这组输入/viewport/host 事实，不代表未执行的 Worker/硬件场景也已验收。

## 无 Glass Demo 回归验收（2026-11-03）

本轮 Demo 已移除 Liquid Glass 日常入口；独立 SDK 光学测试仍保留。iPhone Duo 模拟器 debug 回归使用以下两个命令：

```sh
cd demo
flutter drive --no-pub --no-dds \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/jank_regression_test.dart -d DEVICE_ID
flutter drive --no-pub --no-dds \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/multi_app_test.dart -d DEVICE_ID
```

`jank_regression_test.dart` 的键盘生命周期、中文 IME、页面滚动、Mobile UI 导航和无 Glass 入口 5 个业务测试全部通过；`multi_app_test.dart` 的 A→B 结果/消息、隐藏实例预热复用和故障回收 3 个场景也全部通过。原先 Mobile UI 的失败是测试 helper 误报：12 次拖动预算与每次仅 50ms 的 0.5px 稳定检查共用，`ScrollablePage` 释放后的惯性滚动可持续超过 1 秒，导致目标已可见但尚未稳定时耗尽预算。helper 现分离 12 次拖动和有界 4 秒稳定等待，并保留有限 point/clip 轨迹；没有放宽可见性断言或修改 SDK 滚动规则。

结果日志：`/tmp/pocket-no-glass-device-regression-final.log`、`/tmp/pocket-no-glass-miniapps-final.log`。对应归档位于 `demo/artifacts/performance/jank-fix-20261103T061326Z/no-glass-device-regression-final.*` 与 `no-glass-miniapps-final.*`。日志中的 debug 模拟器 cold=150ms、warm=101ms 只是一次复用消融观测，不是性能保证；上述命令证明的是设备功能回归与实例生命周期，不能替代普通运行的 FrameTiming、trace 或 A/B 性能证据。
