# 字形与按需调度实施计划

基线：`bee700e`，2026-11-03。先保留现有 PocketJS 布局、字体和固定步长语义，再补齐宿主适配；不增加第二套文本布局或 JS 事件循环。

## 分工与顺序

1. `glyph_impl`：在 Rust DrawList 投影中消费 GLYPH_RUN。复用上游 glyph page、现有 image/PFB1 tag 6、T8 解码与资源 revision。验证坐标、density、UV、coverage、clip、字体替换及缓存；不修改调度。
2. `scheduler_engine_impl`：给固定上游增加可重放的补丁，发布 JS 连续工作/最近虚拟定时器状态与安全空闲快进接口；给 core 发布动画、timeline、physics 等待办状态。默认 onFrame 保守连续运行，已知输入/几何观察者按事件运行，滚动惯性只在运动中保持连续帧。
3. `scheduler_flutter_impl`：接入可选 native 调度 ABI。连续工作使用 vsync，已知空闲完全停表，已知未来期限使用单次 Timer；输入、异步响应、键盘与生命周期直接唤醒。旧 guest/旧库没有契约时持续运行，避免漏唤醒。
4. 主代理：待字形工作完成后接入 native 调度胶水，处理长时间空闲的虚拟时钟与外部消息时间边界，更新 Showcase 的活动提示、文档并做集成验收。

各代理使用 GPT-6 Luna / max；工具没有用户指定的 6.1-Luna，已明确告知这一差异。代理共享工作区，按文件范围修改，不覆盖其他人的改动，不再向下派代理。

## 接口约定

- JS `__pocketWorkState()`：`{version: 1, continuous, framesUntilTimer, simulationHz}`。没有可靠状态时保持连续运行。
- JS `__pocketSkipIdleFrames(n)`：只快进没有回调/动画副作用的空闲虚拟帧，不越过最近的 timer；返回实际跳过的帧数。
- core `Ui::has_pending_work()`：宿主不能用“上帧没有视觉变化”推测未来无工作。
- native `pocket_next_wake_delay_ms(handle)`：负值为无限期空闲，零为连续工作或未知，正值为下一次 deadline 的毫秒间隔。Dart 不以 DrawList unchanged 推测 deadline。

## 消融与验收

| 场景 | 必须观察到的结果 |
| --- | --- |
| 静态页持续空闲 | 一次稳定事务后没有周期 FFI 调用；没有 100ms probe Timer。 |
| 动画、惯性、普通 onFrame | 保持 vsync，结束后重新计算工作状态。 |
| 5 秒以上 after() | 单次 deadline 唤醒，回调顺序正确，不受原 1000ms 帧上限饿死。 |
| 输入、IME、异步 host.response | 空闲时直接唤醒，保留页面/输入的既有行为。 |
| reload、dispose、后台 | 旧 Timer 被取消，不能访问新 generation 或已释放 runtime。 |
| 旧字节码/旧 native 库 | 持续 vsync 的兼容路径，不能因为缺少状态接口停住。 |
| 字形混排与 atlas 替换 | 图像 coverage/UV/tint 正确，复用既有缓存且 replacement 失效。 |

先运行代理范围内的真实行为测试，再运行 Rust、bridge Flutter、SDK/Showcase JS、架构检查及设备输入回归。性能结论以实际帧调用/唤醒计数为依据；没有设备功耗数据时不报告功耗百分比。

## 来源与边界

已检查保留的 `pocketjs_flutter_demo/native/pocket_runtime_multi.c`（排除 pocket_host）。旧实现提供跳过冗余帧、固定二进制记录及 FFI 的历史思路，但没有可直接迁入的真实 GLYPH_RUN 或 deadline 驱动 UI 时钟。字形复用固定上游 `engine/render/glyph-pages`、`Ui::prepare_glyph_page`；调度复用 `framework/src/clock.ts` 的确定性虚拟 timer、frame 生命周期和 core 的真实活动状态。新增代码只填补当前宿主缺失的协议与唤醒桥接。

GLYPH_RUN 接入不扩展上游的 Unicode shaping、彩色 emoji 或旋转字形语义；详情见 `GLYPH_RUN_STUDY.md`。

## 集成阶段补充

- 移除常量 passive 观察者的全局工作提示条目：回调仍随真实事件帧执行，避免每次状态查询扫描重复的 false 提示；覆盖 256 个 passive 观察者。
- Showcase 请求的 30 秒超时改接 `after()`，不再为等待响应而连续执行 1800 帧；转场按实际 simulationHz 推进。
- 停表后外部 JS 入口通过 `with_turn` 获取新的有界执行预算，避免上一次 frame 的 250ms 预算已经过期而误中断正常处理器。
- 补齐原生 physics 绑定开关；修复 SURFACE_QUAD inline 可见区域投影，保留完整纹理几何，复用既有 clip 字段。
- 功能覆盖审查与仍未接通的能力见 `POCKETJS_FEATURE_PARITY.md`，不能把本轮绘制/调度完成外推成全部 PocketJS 功能支持。

调度回归入口：先构建当前 native probe，再在 `sdk` 执行 `bun run test:demand`。该命令包含 JS 行为测试和真实 JSX→QJBC/PAK→native 消融：相同 5 秒定时任务，continuous 路径在截止前执行 300 次观察回调，按需路径执行 1 次；两者都在虚拟 frame 300 触发并更新文字，随后按需路径返回 `-1` 空闲状态。

## 代理阶段验证快照（2026-11-03，历史日志）

以下结果保留代理阶段日志，命令分别在仓库根、SDK 包或 Demo 下执行；最终收口计数见下方“最终收口验证”，不能用本节旧日志替代最终结果。

| 命令 / 范围 | 结果与证据 |
| --- | --- |
| `cargo test --manifest-path sdk/native/Cargo.toml` | 30 项 native library、6 项 duplex integration 通过；1 项手动吞吐基准未运行。真实 QJBC＋PAK 字形、资源替换、surface inline clip、长空闲、外部唤醒预算均覆盖。日志 `/tmp/pocket-native-tests.log`。 |
| `bash sdk/scripts/build_native.sh macos` / `ios-sim` | 两平台原生构建通过；iOS device/simulator 库重新生成。日志 `/tmp/pocket-macos-native-build.log`、`/tmp/pocket-ios-native-build.log`。 |
| `bun run test:demand`（`sdk/`） | JS 调度测试及真实 JSX→QJBC/PAK→native 消融通过：300→1 回调，同一 frame 300 执行 timer。日志 `/tmp/pocket-demand-tests.log`。 |
| `bun test`（`sdk/`） | 39 项、371 assertions 通过。日志 `/tmp/pocket-sdk-bun-tests.log`。 |
| `POCKET_BUILD_GUEST=0 bash scripts/test_guest.sh`（`demo/js/`） | Guest 状态、硬件声明、输入、真实 pointer、字节码消融与压力页通过。100/500 节点分别产生 541/1761 DrawOps。日志 `/tmp/pocket-demo-guest-tests.log`。 |
| `POCKET_NATIVE_LIBRARY=.../sdk/native/target/debug/libpocket_flutter.dylib flutter test --no-pub --reporter expanded`（bridge） | 62 项通过；包括真实 FFI、停表/deadline、同步响应唤醒竞态、输入和 T8 字形像素。两个字形像素实测 `[136,16,32,255]`、`[8,144,32,255]`；clip 外保留背景。日志 `/tmp/pocket-bridge-final-tests.log`。 |
| `flutter test`（`sdk/`、`demo/`） | 分别 19、20 项通过。日志 `/tmp/pocket-sdk-flutter-tests.log`、`/tmp/pocket-demo-flutter-tests.log`。 |
| `flutter drive ... --target=integration_test/system_keyboard_lifecycle_test.dart -d 4D366210-290E-46DB-8BC6-3C5233700409`（Demo） | Duo 模拟器 1 个业务 case 通过（日志 `+2` 含 `tearDownAll`），覆盖实际系统键盘、页面滚动、同一编辑器和每帧几何稳定性。日志 `/tmp/pocket-duo-demand-drive.log`。 |
| `python3 sdk/scripts/check_architecture.py` | SDK/Demo 入口及 SDK 不依赖 Demo/旧业务 renderer 的边界检查通过。 |

字形像素测试用实际 T8 解码和 PocketView 画布，以注入帧隔离 Flutter 投影；另有 native 测试覆盖真实 QJBC＋PAK 到该帧契约。它们不能替代所有字体、脚本及设备的视觉验证。Duo 是模拟器，这些结果不作为真机功耗或持续 FPS 基准。

FPS 采样排除主动睡眠，统计明确持续请求帧的活动区间。最初以每 16ms 离散计数事件驱动设备测试时，每次处理完都重新睡眠，数值标签未形成连续窗口，测试失败。没有用周期 ticker、合成 samples 或间隔阈值掩盖这个边界；设备回归改用已有真实转场保持连续工作，在该区间注入 UI 卡顿。离散事件唤醒与下一帧响应由独立调度/duplex 测试验证，不能据 FPS 缺少数值推断卡住。

## 2026-11-03：最终收口验证

以下只使用本轮最终可读日志或明确标注来源的子代理验证；Duo 日志的 `tearDownAll` 不计为业务 case。完整回归清单见 [验证记录](VALIDATION.md)。

| 范围 / 日志 | 本轮确认 |
| --- | --- |
| Native Rust | 子代理本轮验证回报 31 unit + 6 duplex = 37 passed、1 manual throughput ignored。当前可读 `/tmp/pocket-native-tests.log` 是较早的 30 unit + 6 duplex = 36 passed、1 ignored，不能把旧日志冒称本轮 37。 |
| demand scheduler：`/tmp/pocket-demand-current-final-tests.log` | 11 个 JS 行为测试通过、54 `expect()`；真实 JSX→QJBC/PAK→native 消融为按需 deadline 1 次回调、continuous 300 次回调，均在虚拟 frame 300 执行，最终 wake delay 为 `-1` / `0`。 |
| 固定上游 clock：`/tmp/pocket-deterministic-clock-test.log` | 9 pass、0 fail、26 `expect()`；仅覆盖虚拟时钟、`after()`、effect FIFO/下一次 drain 与 trace，不外推为完整模拟器/WASM。 |
| Flutter bridge：`/tmp/pocket-bridge-post-fix-tests.log` | 68 项通过；含真实 FFI、停表/deadline、外部响应唤醒竞态、输入及 T8 GLYPH_RUN 的 UV/coverage/clip/tint。 |
| JS SDK/System Bun：`/tmp/pocket-sdk-system-final-bun.log` | 50 pass、0 fail、418 `expect()` calls，13 个文件。 |
| SDK/Demo/Services | SDK 33 tests + analyze 通过；Demo 20 tests + analyze 通过；`pocket_services` 27 项通过。日志分别为 `/tmp/pocket-sdk-current-final-tests.log`、`/tmp/pocket-sdk-current-final-analyze.log`、`/tmp/pocket-demo-current-final-tests.log`、`/tmp/pocket-demo-system-final-analyze.log`、`/tmp/pocket-services-final-tests.log`。 |
| Demo JS 全流程：`/tmp/pocket-demo-guest-current-final.log` | reducer、平台中立 hardware contract、JS→frame 消融、Guest build 与静态 native probe 完成；100/500 节点为 541/1761 DrawOps。 |
| Duo SystemUI：`/tmp/pocket-duo-js-system-closure.log` | 3 个业务 case 通过，最终 `+4` 含 1 个 `tearDownAll`；日志记录真实 A/B guest、共享 identity、结果/消息、失败回收及 prewarm 复用，消融为 `cold=203ms`、`warm=105ms`、`residents=2`、`reused=true`。 |
| Duo 系统键盘：`/tmp/pocket-duo-system-keyboard-final.log` | 1 个业务 case 通过，最终 `+2` 含 1 个 `tearDownAll`；验证真实系统键盘与 viewport resize。 |

真实 Duo 发现外部 `host.response` 在 credited zero tick 后，Promise continuation 失去唤醒；修复是在调度状态中加入 QuickJS pending-job hint，使调度保持活跃，直到下一次真实 fixed tick drain pending jobs。这里没有虚构 tick 数，也没有引入第二事件循环。`cold=203ms`/`warm=105ms` 是一次 debug 模拟器、复用同一 instance 的功能消融，不是真机省电或稳定性能收益证明。FPS 统计不裁到 60；高刷新率表现和物理能耗仍需对应真机验证。
