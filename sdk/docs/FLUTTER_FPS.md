# Flutter FPS 与 PocketJS 帧节奏测量设计

本文件记录 Demo 根层独立 Flutter HUD 的测量口径、能耗消融和开源方案调研。实现与验收均使用 Flutter 3.35.7 / Dart 3.9.2；下文区分普通 Flutter 运行与集成测试绑定的测量。

## 结论

Demo 同时保留两条互不混淆的信号：

1. **Guest 调度轮转率**：SDK 原 `showDebugFps` 角标现在明确显示为 `Guest ticks/s`；它来自 `PocketView` 的活跃 ticker 与 native `frameDelta` 调用链，统计的是 Guest scheduler turn / native frameDelta 调用在活动窗口中的轮转率（含未改变画面的轮转），不是 Flutter engine 的全视图 FPS。
2. **Flutter frame cadence**：根层 `FlutterFrameMonitor` 只接收 Flutter engine 的 `FrameTiming`，用相邻 `vsyncStart` 时间戳间隔统计 Flutter 的报告帧节奏。

`buildDuration`、`rasterDuration`、`totalSpan` 都是单帧阶段/延迟指标，不能当作 FPS 的倒数。尤其 `totalSpan` 是从 `vsyncStart` 到 raster 完成的跨度；`1e6 / totalSpanUs` 不是平台显示 cadence。

这两条信号不能合并成一个“真实 FPS”。`FrameTiming` 也不等于物理屏幕的 present FPS，不能据此宣称系统键盘进程或其他 compositor 进程的 FPS。

`FlutterFrameMonitor` 也不是 Guest 异常采集器，不承诺捕获所有 QuickJS/Promise 异常；Guest 的同步异常与 pending-job 诊断属于 Pocket runtime 诊断链，未处理的 Promise rejection 需要 runtime 的独立 rejection-tracker 语义，不能由本 HUD 的 `FrameTiming` 数据推断。

## Demo 接入与开关

根层接入位于 `demo/lib/main.dart`，由 `MaterialApp.builder` 包住应用内容：

- Pocket 原有角标关闭：`PocketAppConfig.showFps: false`。
- 数字 HUD 默认由 `FLUTTER_FPS` 控制，`false` 时应同时停止 monitor listener/展示层，作为能耗消融开关。
- Flutter 官方 engine 图由 `FLUTTER_PERFORMANCE_OVERLAY` 控制：

```sh
flutter run --dart-define=FLUTTER_PERFORMANCE_OVERLAY=true
flutter run --dart-define=FLUTTER_FPS=false
```

两个开关可以组合。例如只看官方图时使用 `FLUTTER_PERFORMANCE_OVERLAY=true FLUTTER_FPS=false`；只看数字 HUD 时关闭官方图。普通 Debug Duo 的实测、原始 JSON/日志路径和限制见下文[“实际运行与验证（2026-11-03）”](#实际运行与验证2026-11-03)；该轮未做真机 profile/release 或功耗验收。

`flutter drive` 在 Flutter 3.35.7 默认使用 `--start-paused`。无线 iOS 的 Dart VM Service 未发现时，Dart isolate 还没有执行入口 `main()`，测试目标可能长时间显示白屏；这是启动/调试连接问题，不是 Flutter HUD 的绘制结果。手机 automation 必须显式关闭该默认暂停（仍需要可达的 VM Service 才能由 driver 收集结果）：

```sh
cd demo
flutter drive --no-pub --profile --no-start-paused -d DEVICE_ID \
  --driver test_driver/integration_test.dart \
  --target integration_test/first_open_regression_test.dart
```

需要在目标设备上复测时，可直接运行同一普通 App 验证工具：

```sh
cd demo
flutter run --profile --no-pub -d DEVICE_ID --target tool/verify_flutter_fps.dart
flutter run --release --no-pub -d DEVICE_ID --target tool/verify_flutter_fps.dart
```

以上命令只提供 profile/release 的可用入口，不将本轮普通 Debug Duo 的数据外推为真机 profile/release 性能或功耗结论。

手机 automation 结束后，必须恢复普通 Showcase 入口；重新构建 `lib/main.dart`，再用 `devicectl` 安装并启动。`devicectl device process launch` 的选项必须写在 bundle ID 之前；bundle ID 后面的参数都会原样传给应用，因此不要把 `--terminate-existing` 写在 bundle ID 后：

```sh
cd demo
flutter build ios --profile --no-pub --target lib/main.dart
xcrun devicectl device install app \
  --device DEVICE_ID \
  build/ios/iphoneos/Runner.app
xcrun devicectl device process launch \
  --device DEVICE_ID \
  --terminate-existing \
  BUNDLE_ID
```

### 默认刷新行为

`FlutterFrameMonitor` 不得创建主动 `Ticker`、`Timer`、`Timer.periodic` 或 `scheduleFrame`。当前实现的 collector 只在 `addTimingsCallback` 中接收已有 engine timing；HUD 通过 `addPersistentFrameCallback` 观察已经安排的 app frame，在版本变化时仅对紧凑 HUD 绘制边界 `markNeedsPaint`，不调用 `setState`，也不从 timing callback 自己安排新帧。应用空闲时保留上一个有效窗口，不合成 0 FPS、60 FPS 或虚构的一帧。

如果数字 HUD 改为在每个 timing 批次里直接 `setState`，就可能让 HUD 自己安排下一帧，进而把被测对象变成“HUD + 应用”的自激循环。因此当前实现把 collector 与 HUD 解耦，只在已有 persistent frame 中观察版本；关闭 `FLUTTER_FPS` 后不得继续保留 collector。

## 两种口径的计算

### Guest tick / PocketJS

现有 `PocketPerformanceSample` 的 `fps` 由活动窗口内的 ticker/native frameDelta 输出计数计算：

```text
guestTickRate = nativeTurnCount / activeWindowDurationSeconds
```

窗口中的 `frames`、`durationMs`、`maxGapMs`、`slowFrames`、`refreshHz` 和 `nativeMsP95` 是兼容字段，必须标注为 Guest tick / Pocket renderer bridge 口径。`nativeMsP95` 是 FFI、返回帧复制和 Dart 解码路径，不是纯 Rust/native CPU 时间。

`PocketView._onTick` 使用 scheduler ticker 驱动 `frameDeltaAt`；只有实际得到 Guest 输出时才记录对应的性能 tick。空闲停表时间从活动窗口中扣除，不能被报告成掉帧。

相关实现：

- [`FlutterFrameMonitor` 被动 collector/HUD](../../demo/lib/flutter_frame_monitor.dart)
- [`PocketView._onTick` 与性能窗口](../packages/pocket_flutter/lib/src/pocket_view.dart)
- [`PocketPerformanceSample` 字段定义](../packages/pocket_flutter/lib/src/pocket_performance.dart)
- [`PocketSession.runtime.performance` 注册与 sample 投递](../lib/src/pocket_session.dart)
- [`demo/js/state.ts` 兼容 performance history 聚合](../../demo/js/state.ts)

### Flutter engine cadence

`FrameTiming` 回调是异步批量投递的。对每批 timing：

1. 取 `timing.timestampInMicroseconds(FramePhase.vsyncStart)`；
2. 按时间戳单调递增去重；
3. 对相邻有效时间戳计算 `deltaUs`；
4. 以窗口内的间隔或首尾跨度报告 cadence，并保留最后有效窗口。

可展示的辅助指标：

```text
cadenceFps(i) = 1_000_000 / (vsyncStartUs[i] - vsyncStartUs[i - 1])
buildMs      = timing.buildDuration.inMicroseconds / 1000
rasterMs     = timing.rasterDuration.inMicroseconds / 1000
totalSpanMs  = timing.totalSpan.inMicroseconds / 1000
```

`cadenceFps` 只描述 Flutter 收到/报告的帧节奏；`buildMs`、`rasterMs` 和 `totalSpanMs` 分别用于 UI、raster 和端到端延迟/jank 诊断。帧预算应使用 `View.of(context).display.refreshRate` 动态计算，而不是固定 60 或 16.67ms。

Flutter 官方接口：[`addTimingsCallback`](https://api.flutter.dev/flutter/scheduler/SchedulerBinding/addTimingsCallback.html)、[`FrameTiming`](https://api.flutter.dev/flutter/dart-ui/FrameTiming-class.html)、[`timestampInMicroseconds`](https://api.flutter.dev/flutter/dart-ui/FrameTiming/timestampInMicroseconds.html)、[`totalSpan`](https://api.flutter.dev/flutter/dart-ui/FrameTiming/totalSpan.html)、[`Display.refreshRate`](https://api.flutter.dev/flutter/dart-ui/Display/refreshRate.html)。

### 空闲与边界

- 没有 timing 回调不代表 0 FPS；通常表示没有新的 Flutter frame 可观测。HUD 显示 `last window`，并可标记 `idle/no new timings`。
- 窗口开始/结束只使用有效的 `vsyncStart`；不把 callback 到达时间当成 vsync 时间。
- 不把 `totalSpan` 的平均值倒数称为 cadence FPS。
- 不把 idle 间隔直接判为卡顿；最近一秒以 source-time 裁剪，长 idle 后旧样本自然淘汰，少于两帧时显示 `--`。系统键盘进程及物理屏幕 present FPS 不属于此采集器。

## 旧字段与旧来源的兼容边界

### 保留 `runtime.performance` / 兼容 history

现有 `runtime.performance`、`runtime.performance.sample`、`PerformancePoint` 和历史数组先保留，避免破坏 JS/宿主兼容；JS 页面已从 “FPS history” 改名为 **Frame diagnostics**，其中的指标明确显示为 `Guest ticks/s`。字段中的 `fps`、`frames`、`durationMs` 应在文案和新报告中继续标注为 **Guest tick / native turn rate**；不能改名后伪装成 Flutter FPS。

Flutter 根层 monitor 的 cadence、build、raster 不写入旧 `fps` 字段。`totalSpan` 仅在原始引擎诊断或官方工具中另行分析，当前紧凑 HUD 不展示它。需要传输时使用独立字段或新的 `scope=flutterView` 诊断记录，避免旧消费者将两种信号平均或比较成同一指标。

### 为什么不复用旧 `lib/core/perf_monitor.dart`

旧来源在 [`LEGACY_SDK_REUSE.md`](LEGACY_SDK_REUSE.md) 中只作为迁移参考，当前 SDK 已有自己的 PocketView/FrameTiming 配对链。它不能直接成为独立根 HUD，原因是：

- 旧采样历史混合了旧 runtime 的窗口状态，不能提供本轮明确的 Guest tick 与 Flutter cadence 双口径；
- 旧实现的预填 60 FPS/固定耗时只能作为旧 UI 的占位或兼容数据，不能作为测量结果；
- 旧 HUD 更新路径与 PocketView 的 runtime 生命周期耦合，复用会重新引入第二套 Dart 性能状态机；
- root monitor 需要以 `vsyncStart` 为唯一 cadence 时间基准，并能在 `FLUTTER_FPS=false` 时完全停掉，不应继承旧窗口或旧历史的隐含状态。

### 监控自身的消融与漏唤醒回归

旧 `lib/core/perf_monitor.dart` 的 `_isSelfHudRebuildFrame` 会按下一批 timing 数量丢弃整批（不超过 2 帧时），这可能丢掉真实应用帧。新采集器不猜测并丢弃所谓 HUD 帧。

本轮首次数字 HUD 方案曾在 persistent 阶段调用 `setState`。尽管该阶段 `ensureVisualUpdate` 不会请求新帧，它却留下 `BuildOwner` 的脏元素/flush 标记，可能吞掉后续外部 `setState` 的调度。第二次普通 App 消融真实触发了关闭 HUD 超时；该失败日志保留为 `ordinary-ablation-before-fix.log`。

最终实现只标脏独立 **360×44** HUD 的绘制边界（最多每秒 2 次，采集保留全部 timing），`CustomPainter` 读取最新样本，不改 Widget build 状态；TextPainter 复用并在 controller 更换/卸载时释放。曾包住全屏的 HUD layer 已缩到文本矩形，业务 child 外多余的全屏 RepaintBoundary 也已移除。禁用时直接返回原 child，不增加 monitor 绘制边界。

根代理在 `/tmp` 独立测试包中只将 `markNeedsPaint` 换回 `setState`，新增的 parent wake 回归明确失败（外部 parent `setState` 后 `hasScheduledFrame` 为 false）；正式绘制方案已通过同一测试。该负例不修改正式源码，避免只凭源码推理宣布无干扰。

## 开源方案调研

以下结论基于 pub.dev 页面和各项目原始源码；未做 `pub get`/Flutter 构建解析，因此不把 pubspec 的 Dart 上界写成“Dart 3 必然无法解析”。主要按测量口径、主动刷新和维护风险排除。

### statsfl

来源：[`pub.dev`](https://pub.dev/packages/statsfl) · [`GitHub`](https://github.com/gskinnerTeam/flutter-stats-fl) · [`lib/statsfl.dart`](https://raw.githubusercontent.com/gskinnerTeam/flutter-stats-fl/master/lib/statsfl.dart) · [`pubspec.yaml`](https://raw.githubusercontent.com/gskinnerTeam/flutter-stats-fl/master/pubspec.yaml) · [`MIT`](https://raw.githubusercontent.com/gskinnerTeam/flutter-stats-fl/master/LICENSE)

- 通过 `Ticker` 计数，在采样窗口计算 `ticks * 1000 / sampleTimeMs`，然后用 `maxFps` 截断；不读 `FrameTiming`。
- 默认和图表归一化使用 60，存在固定 60 口径；没有 16.67 的 engine cadence 证据。
- 启用时启动常驻 `Ticker`，会让监测本身持续参与每帧调度，不符合默认低能耗/不主动刷帧要求。
- 当前 pub.dev 为 2.3.0，版本长期未更新；许可证 MIT。pubspec 的 Dart 上界需要在目标 SDK 上实际解析验证，不能仅凭上界断言失败。

结论：主动刷新且不是 engine timing，排除。

### fps_monitor 与 show_fps

#### `fps_monitor`

来源：[`pub.dev`](https://pub.dev/packages/fps_monitor) · [`GitHub`](https://github.com/Nayuta403/fps_monitor) · [`performance_observer_widget.dart`](https://raw.githubusercontent.com/Nayuta403/fps_monitor/master/lib/widget/performance_observer_widget.dart) · [`fps_chart.dart`](https://raw.githubusercontent.com/Nayuta403/fps_monitor/master/lib/widget/fps_chart.dart) · [`pubspec.yaml`](https://raw.githubusercontent.com/Nayuta403/fps_monitor/master/pubspec.yaml) · [`BSD-3-Clause`](https://raw.githubusercontent.com/Nayuta403/fps_monitor/master/LICENSE)

- 优点是使用 `addTimingsCallback`/`FrameTiming`，监测本身没有 Ticker 或 Timer。
- 但它把 `totalSpan` 小于 `16.7ms` 的值钳制为 `16.7ms`，图表还固定使用 16/33/66ms 等 60Hz 阈值；`totalSpan` 也不是 cadence 间隔。
- 当前 pub.dev 为 2.0.0，GitHub 仓库已归档；许可证 BSD-3-Clause。Dart 上界为 `<3.0.0`，兼容性必须以实际解析/构建为准。

结论：数据源方向正确，但固定 60Hz、错误的 FPS 推导和维护状态不适合本 Demo。

#### `show_fps`

来源：[`pub.dev`](https://pub.dev/packages/show_fps) · [`GitHub`](https://github.com/mantreshkhurana/show_fps) · [`lib/show_fps.dart`](https://raw.githubusercontent.com/mantreshkhurana/show_fps/stable/lib/show_fps.dart) · [`pubspec.yaml`](https://raw.githubusercontent.com/mantreshkhurana/show_fps/stable/pubspec.yaml) · [`MIT`](https://raw.githubusercontent.com/mantreshkhurana/show_fps/stable/LICENSE)

- 不使用 `FrameTiming`，而是用连续 `addPostFrameCallback` 的时间差计算每帧 reciprocal FPS。
- 默认 `targetFps=60`、`chartMaxFps=60`，帧预算是 `1000 / targetFps`；仍以 60Hz/约 16.67ms 为默认设计中心。
- 默认每个 callback 调用 `setState`，再注册下一个 post-frame callback；这会间接安排下一帧，形成持续刷新。`visible=false` 不是停止 collector 的保证。其显示值是逐帧 reciprocal FPS 的平均，不是 `vsyncStart` 跨度上的 cadence。
- 当前 pub.dev 为 1.1.0，许可证 MIT；pubspec 的约束覆盖 Dart 3.9，但没有看到针对 Flutter 3.35 的明确验证。近期维护不改变其非-FrameTiming口径。

结论：不是低能耗被动 engine monitor，排除。

### 官方 `PerformanceOverlay` 与轻量 callback

来源：[`PerformanceOverlay API`](https://api.flutter.dev/flutter/widgets/PerformanceOverlay-class.html) · [`Flutter source`](https://github.com/flutter/flutter/blob/main/packages/flutter/lib/src/widgets/performance_overlay.dart) · [`UI performance guide`](https://docs.flutter.dev/perf/ui-performance)

- 官方 overlay 由 engine/rendering overlay 绘制，不使用应用层 Ticker/Timer/`scheduleFrame`；空闲时图表停止更新。
- 它适合验证 Flutter UI/raster 图，但不直接提供 PocketJS Guest tick 数字，因此 Demo 仍需保留两条独立信号。
- 如需数字 HUD，只需实现 `addTimingsCallback` collector，按 `vsyncStart` 做 cadence，按 build/raster/totalSpan 做阶段指标。
- Flutter SDK 自带，随目标 Flutter 3.35/Dart 3.9 一起验证；无需引入第三方依赖。框架源码采用 BSD-3-Clause，见 [Flutter LICENSE](https://github.com/flutter/flutter/blob/main/LICENSE)。

结论：官方 overlay + 极薄被动 collector 是本 Demo 唯一推荐方案。

### 简短补充：`frame_insights`

来源：[`pub.dev`](https://pub.dev/packages/frame_insights) · [`API docs`](https://pub.dev/documentation/frame_insights/latest/)

该包当前为 0.1.0、BSD-3-Clause，使用 Flutter timings callback，功能比本 Demo 更重；其公开限制明确说“FPS”是平均 frame span 推导值（可理解为 `1 / avgSpan`），不是平台实际显示帧计数。它还带 HUD/store/dashboard 和 `shared_preferences`，会扩大状态、持久化与自测干扰面；因此不作为本 Demo 的轻量 cadence 方案。

## 能耗/刷新消融矩阵

| 变体 | `FLUTTER_FPS` | `FLUTTER_PERFORMANCE_OVERLAY` | 预期观察 |
| --- | --- | --- | --- |
| A：基线 | `true` | `false` | 根层数字 HUD；不新增主动 ticker/timer |
| B：去数字 HUD | `false` | `false` | monitor 与 HUD 均关闭，用于能耗/帧行为对照 |
| C：官方图 | `false` | `true` | 只显示 Flutter engine 官方 UI/raster overlay |
| D：双诊断 | `true` | `true` | 交叉查看，但要注明官方图和数字 HUD 的额外绘制成本 |

所有变体都必须保持 PocketJS 业务逻辑、Guest tick 口径和旧 `runtime.performance` schema 不变。消融只能改变观测层，不能通过主动刷帧制造“更高 FPS”。

## 实际运行与验证（2026-11-03）

设备为 iPhone Duo 模拟器，iOS 27.1，display 60Hz。数字以下均为 debug 实测，用于验证统计器，不能充当 Pocket SDK 的 profile/release 性能结论。

### 集成测试绑定的持续帧干扰

Flutter 3.35.7 的 `LiveTestWidgetsFlutterBinding.handleDrawFrame` 在非 benchmark policy 下直接调用 `platformDispatcher.scheduleFrame()`，`fullyLive` 会处理这些后续帧。因而集成测试中的 idle 页仍可能收到约 60 个 engine timing/s。本轮第一次 idle 验收检测到 2 秒新增 117 帧，明确失败；没有将其解释为监控器正常，也没有放宽 0 帧断言。此前同类绑定下静态页约 60Hz 的结果不能证明普通 App 的自然帧率或低能耗。

普通运行工具 [`demo/tool/verify_flutter_fps.dart`](../../demo/tool/verify_flutter_fps.dart) 使用 `WidgetsFlutterBinding`，不导入 `flutter_test`，复用同一真实动画负载：

```sh
cd demo
flutter run --no-pub -d DEVICE_ID --target tool/verify_flutter_fps.dart
```

本次输出 `POCKET_FLUTTER_FPS_VERIFICATION` 的 `passed=true`：

| 场景 | Flutter cadence | UI p95 | raster p95 | 观察 |
| --- | ---: | ---: | ---: | --- |
| 纯 Flutter 动画初始窗口、HUD 开 | 57.000 FPS | 1.747ms | 36.182ms | 58 个最近窗口 source 帧；不是预填 60 |
| 每帧 build 忙等 45ms | 19.990 FPS | 45.956ms | 0.561ms | 20 个最近窗口 source 帧，phase 超预算事实增加 |
| 同一动画预热后、HUD 关 | 60.000 FPS | 0.719ms | 17.905ms | 原 collector 已解绑，独立 raw collector 继续采集 |
| 再开 HUD、同一动画 | 60.000 FPS | 0.551ms | 19.692ms | 确认开关后能继续正常调度 |
| 停止动画、HUD 开 | — | — | — | 排空 2 秒后再观察 2 秒，两个独立 collector 均新增 0 帧 |
| 停止动画、HUD 关 | — | — | — | 排空 2 秒后再观察 2 秒，新增 0 帧，HUD collector 已解绑 |

这验证了采集器可独立于 Pocket 反映真实 Flutter 卡顿，HUD 没有形成自驱动帧循环。初始窗口本身存在 raster 超预算，不声称模拟器恒定 60 FPS。预热后的 HUD 关/再开窗口都约 60 FPS，raster p95 仍有差异；这是单次顺序对照，不宣称零观测开销或稳定性能增益。0 个额外帧也不是 CPU/GPU 功耗百分比测量。

原始 JSON、日志与源码 SHA256 位于本机被忽略的 `demo/artifacts/performance/flutter-fps-20261103/`。`ordinary-flutter-final.json` 是最终正常 binding 的测量，`source-sha256-final.json` 固定对应源码；`ordinary-flutter-pre-layer-ablation.json` 保留去掉冗余整页边界前的对照；`first-harness-run.log` 保留先前失败及原因，不作为空闲性能结论。

Demo 全部 40 项单测通过，其中独立监控 13 项覆盖 120Hz、不分批/拆批一致、source watermark 去重、1 秒窗口、UI/raster 慢帧、idle、真正 nearest-rank p95、禁用/卸载与 HUD 无自驱动；SDK safe-area 角标回归亦验证了改名后的诊断。执行命令：

```sh
cd demo
flutter test --no-pub
flutter analyze --no-pub
flutter drive --no-pub -d DEVICE_ID \
  --no-start-paused \
  --driver test_driver/integration_test.dart \
  --target integration_test/jank_regression_test.dart
# SDK 角标坐标与安全区
cd ../sdk/packages/pocket_flutter
flutter test --no-pub test/pocket_view_viewport_test.dart
```

`jank_regression_test.dart` 中的纯 Flutter 动画/人为卡顿仍验证引擎统计与 Showcase 接线，idle 无额外帧的必要断言由上述普通 binding 工具执行。它同时覆盖实际系统键盘、中文 IME、页面滚动、Mobile UI 和诊断历史。持续动画时不要拿 Guest tick 历史冒充引擎统计；两者的 schema、采集入口和报告始终分离。
