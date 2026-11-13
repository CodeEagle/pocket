# 验证记录

2026-11-03 的 GLYPH_RUN、按需调度与本轮回归结果见 [字形与调度接入](GLYPH_AND_SCHEDULER_IMPLEMENTATION.md)；下文保留 11-02 的历史验证，旧的“GLYPH_RUN 未接通”不再代表当前状态。完整能力缺口见 [能力覆盖](POCKETJS_FEATURE_PARITY.md)，旧多应用平台/微信 Host 的独立核查见 [平台对照](MINI_APP_PLATFORM_PARITY.md)。

## 2026-11-03：Worker/IO 真实录制与归档离线回放

| 实际命令 / 日志 | 结果与范围 |
| --- | --- |
| `cargo test --locked --manifest-path sdk/native/Cargo.toml`；`/tmp/pocket-worker-recording-rust-verified.log` | 68 lib + 6 duplex passed；1 手动吞吐基准 ignored。包含真实 Worker HTTP/timer/random/Date/channel 及 offload submit/timeout/cancel/session/late completion。 |
| 定向 `cargo test --locked --lib worker::tests::official_worker_records_http_timer_and_duplex_channels_then_replays_offline -- --exact`，在 `sdk/native` 连续执行 10 次；`/tmp/pocket-worker-recording-http-repeat10.log` | 10/10；每次 0.13–0.28s。真实 QJBC、HTTP、双向 channel、timer/scalars、活动 HTTP stub 清理和 stop/turn.end/worker.exit 的严格顺序。它是功能重复测试，不是性能基准。 |
| 上述最终 lib test binary，`offload::tests::callback_reply_probe_outside_batch_does_not_create_host_trace_event --exact --nocapture` 连续 50 次，每次 15s 超时；`/tmp/pocket-offload-shutdown-repeat-verified.log` | 50/50，每次实际运行 1 test；验证 idle deadline 线程关闭没有丢失唤醒。没有用 Cargo exit 0 或 0 tests 当作通过。 |
| `cargo build --locked --manifest-path sdk/native/Cargo.toml --lib --bin pocket_probe --bin pocket_worker_probe`；`/tmp/pocket-worker-recording-native-build-verified.log` | 最新 debug dylib 与实际探针构建通过。 |
| `bun sdk/scripts/tests/worker_recording_fixture.ts /tmp/pocket-worker-recording-fixture-20261103`；`/tmp/pocket-worker-recording-fixture-build.log` | 真实 `buildGuest` 生成 UI 与独立 Worker QJBC/metadata，使用相同固定上游及 ABI。 |
| SDK：设置 `POCKET_NATIVE_LIBRARY=.../sdk/native/target/debug/libpocket_flutter.dylib`、`POCKET_RECORDING_WORKER_FIXTURE_DIR=/tmp/pocket-worker-recording-fixture-20261103` 后 `flutter test test/recording_worker_ffi_test.dart`；`/tmp/pocket-worker-recording-http-ffi-verified.log` | 2 passed，0 skipped。真实 HTTP body/end 被 channel 送回 UI；原实例销毁、server 关闭后导出 archive，两次独立 isolate 离线回放 matched，HTTP 请求数仍为 1；seq/payload 篡改拒绝。纯 UI capture stop 后继续运行也通过。 |
| bridge：设置相同 `POCKET_NATIVE_LIBRARY` 后 `flutter test --no-pub --concurrency=2`；`/tmp/pocket-recording-bridge-final-verified.log` | 最终源码全套 104 passed，3m32s；包含真实 FFI、offload 三次无 provider 回放、纯 UI 旧格式、duplex、输入/IME、字形和停表唤醒。新增实际 controller 归档删除 frame/clock 的拒绝回归也包含在内。 |
| SDK：设置上述 native/fixture 两个环境变量后 `flutter test --no-pub --concurrency=2`；`/tmp/pocket-recording-sdk-final-verified.log` | 56 passed，2m34s；真实 Worker FFI 不再 skip，新增生产 Session+recording admission 使用真实 QJBC/metadata 验证 ready、SHA、ABI、声明和 grants。 |
| SDK `flutter analyze --no-pub`；`/tmp/pocket-recording-sdk-analyze-verified.log` | No issues found；新增测试的冗余 import 已移除。 |
| `bash sdk/scripts/build_native.sh ios-sim`；`/tmp/pocket-worker-recording-ios-verified.log` | iOS arm64 + simulator arm64 release static archive 构建与 XCFramework 包装通过；这不是 iOS 设备上 Worker HTTP/功耗验收。 |
| `bash sdk/scripts/build_native.sh android`；`/tmp/pocket-worker-recording-android-verified.log` | Android arm64 release `.so` 构建及 SDK jniLibs 安装通过；未把构建成功当作设备运行或功耗验收。 |
| `bash sdk/scripts/build_native.sh macos`；`/tmp/pocket-worker-recording-macos-verified.log` | macOS arm64 release 库、正式静态 archive 与 `pocket_probe` 构建通过。 |
| Demo JS：`POCKET_NATIVE_PROBE=.../sdk/native/target/debug/pocket_probe bun tests/native_guest_probe.ts --required`；`/tmp/pocket-native-guest-current-verified.log` | 最新 native 实际加载 QJBC，ABI、host response、pointer/input/stress 通过；100/500 节点分别 541/1761 DrawOps。 |

这一轮修复了实际运行中暴露的 replay 跨 actor 顺序、core lock 下等待、Host stop 后活动 turn 收尾、HTTP stub 清理和 broker shutdown 丢失唤醒；CPU guard 使用线程 CPU 时间，等待 trace 的墙钟时间不再冒充 JS 运算。独立审查还用真实 controller 证明删除 frame summary 会出现假匹配；现在缺少必要摘要或 clock envelope 的旧格式仍可解析，但回放明确 unverified/rejected，不能返回 matched。生产 Live 不启用录制 gate/trace payload。高刷新率设备、物理能耗与完整流式/配额/背压/混合域矩阵仍未验收，详见 [实施计划](WORKER_RECORDING_REPLAY_PLAN.md)。

## 2026-11-03：JS 优先边界与微信 WASM 实际执行

新增产品策略留在 JS；原生 Worker runner/offload broker 捕获 JS 无法准确观测的执行事实。移除了默认 Dart provider 中未被使用的 sum/Fibonacci isolate 路径，纯计算复用 JS Worker，Dart provider 保留明确授权的原生 IO。没有为此增加另一套 JS 计算包装器或 Dart 调度器。

| 实际命令 / 日志 | 结果与范围 |
| --- | --- |
| `node sdk/targets/wechat/tests/qjbc_pointer.mjs /private/tmp/pocketjs-wechat-lobby-final-20261103`；`/tmp/pocket-wechat-independent-proof-final.log` | 主代理独立执行真实 QuickJS WASM、Lobby QJBC/PAK，通过 pointer down/up 改变 count/visits、像素摘要及 storage response/dispose。WASM 2,647,634 bytes，Brotli 774,428 bytes，SHA-256 `fdc1e31b98fbafe5bf7c1f6e68d43e5e380eab7c4c121f4b948af5456c22dd79`。Node 执行不是微信 DevTools 或真机验收。 |
| `bun test --timeout 120000 sdk/scripts/tests/build_wechat_admission.test.ts`；`/tmp/pocket-wechat-admission-independent.log` | 3 pass，6 expect；Worker/System 在构建前明确拒绝，单 Guest 继续进入真实 Guest 构建校验。当前微信目标为单 Guest，不支持动态 System 子应用、Worker HTTP 或 offload。 |
| bridge `flutter test test/pocket_offload_runtime_test.dart`；`/tmp/pocket-js-first-offload-test.log` | 4 pass；保留 HTTP redirect/cancel/error 边界，并确认默认 provider 不接管 JS 纯计算。 |
| SDK `flutter analyze --no-pub`；`/tmp/pocket-js-first-sdk-analyze-final.log` | No issues found。 |
| SDK `flutter test test/system_host_test.dart --plain-name 'recording preserves an offload factory without creating a provider'`；`/tmp/pocket-js-first-config-test-final.log` | 1 pass；录制配置保留显式 provider factory，attach 不提前启动 provider。 |
| `python3 sdk/scripts/check_architecture.py`、`git diff --check` | 通过；Demo Dart 入口保持薄宿主，SDK 不引用 Demo 内部实现。 |

Worker/IO 归档回放的新证据见 [实施与验收范围](WORKER_RECORDING_REPLAY_PLAN.md)。下方旧的纯 UI 录制通过数不能作为新增异步域已验收的依据。

## 2026-11-03：宿主录制与离线回放闭环

当前实现与边界见 [录制回放](RECORDING_REPLAY.md)。复用三名既有 GPT-5.6 Luna Max 子代理，分别负责 native 时钟、Dart 事务/库层测试和 JS 上游适配/独立审查；均已完成，未升级模型。主代理集成 SDK、归档和 JS 控件，统一串行执行 Flutter 验收。没有新建第二个 JS 调度器或 Dart 平台策略。

| 实际命令 / 日志 | 结果与范围 |
| --- | --- |
| `cargo test --locked --manifest-path sdk/native/Cargo.toml`；`/tmp/pocket-recording-native-final-tests.log` | 43 lib + 6 duplex = 49 passed；1 manual throughput ignored。包含严格 scalar/idle 重放、mode0 恢复、缓存函数可继续调用、资源顺序和录制配额。 |
| `bash sdk/scripts/build_native.sh macos` / `ios-sim` / `android`；`/tmp/pocket-recording-native-{macos,ios,android}.log` | 三个构建目标通过；Android 为 arm64。Android 录制回放尚未做设备执行，不能把编译成功算作真机验收。 |
| bridge：`POCKET_NATIVE_LIBRARY=.../native/target/debug/libpocket_flutter.dylib flutter test --no-pub`；`/tmp/pocket-recording-bridge-final-tests.log` | 全套 83 passed，含真实 FFI、调度、输入、绘制和录制异常路径。随后新增 signed-zero 回归，录制专项与 analyze 见下行；两组有重叠，不能相加算总数。 |
| bridge：`flutter test --no-pub test/pocket_recording_test.dart test/pocket_recording_ffi_test.dart`（同一 native 环境）；`/tmp/pocket-recording-final-ffi.log`、`/tmp/pocket-recording-bridge-final-analyze.log` | 16 passed；覆盖 signed-zero、严格时钟、原始 RPC 字段、duplex 成功/非法提交、资产篡改、超额、深层事件、停止后继续执行与 enabled/disabled 摘要消融；analyze 无问题。 |
| SDK：`flutter test --no-pub` / `flutter analyze --no-pub`；`/tmp/pocket-recording-sdk-final-{tests,analyze}.log` | 44 passed；analyze 无问题。库层覆盖未启动/空/超额会话拒绝、非法附件不提前 stop、资源 SHA/软链/文件名/单文件大小边界。 |
| Demo：`flutter test --no-pub` / `flutter analyze --no-pub`；`/tmp/pocket-recording-demo-final-{tests,analyze}.log` | 20 passed；analyze 无问题。 |
| Services：`flutter test --no-pub`；`/tmp/pocket-recording-services-final-tests.log` | 27 passed。 |
| SDK：`bun test --timeout 60000`；`/tmp/pocket-recording-sdk-final-bun.log` | 51 pass、0 fail、424 `expect()`，14 files。录制 case 内运行真实上游 clock/effects/devtools fixture，并在删除 Web TextEncoder 后验证。 |
| Demo JS：`bun run build:system`、`POCKET_BUILD_GUEST=0 bash scripts/test_guest.sh`；`/tmp/pocket-recording-demo-final-{build,guest}.log` | Showcase/Profile/Lobby 真实 QJBC+PAK；JS 改字节码消融和 native pointer/response/input/stress probe 通过，100/500 节点为 541/1761 DrawOps。 |
| Duo：`flutter drive --no-pub --no-dds --driver=test_driver/integration_test.dart --target=integration_test/recording_replay_test.dart -d 4D366210-290E-46DB-8BC6-3C5233700409`；`/tmp/pocket-recording-duo-verified.log` | 2 个业务 case passed；最终 `+3` 含 tearDownAll。场景一三应用共 388 个事务/124 个帧摘要，全部 matched；销毁所有原 Session/native handles 后离线回放，再导出/导入通过。场景二实际点击 JS status/stop/replay/export，并重新导入该导出归档通过。 |
| `python3 sdk/scripts/check_architecture.py`、`git diff --check` | 通过；SDK 不依赖 Demo。 |

Duo 输入场景使用真实 Flutter TextInputClient 与 TestTextInput，包含中文/emoji、selection/composing；它不是本轮实际系统键盘按键测试，之前的系统键盘生命周期证据见下文。回放不启动硬件、网络或平台管理 provider，验证的是宿主边界输入下的 Guest 输出，不是相机视频或 Flutter/GPU 像素录像。

验收中实际修复：资源 HashMap 顺序使相同帧摘要漂移；QuickJS 的只读 `performance.now` 被 Proxy 违反 invariant；停止后缓存的时钟 wrapper 失效；JSON f64 单 ULP 漂移；上游 Tape 合法的可选 undefined 被拒绝；QuickJS 没有 Web TextEncoder；原始 duplex 失败事务无法忠实回放；诊断超额/深层事件不应覆盖业务结果。每项均用真实 native 或设备路径补了闭环，未用 catch、浮点容忍或只比节点数量掩盖问题。

消融保留一份 native 宿主事务 trace，移除未发布且重复的 JS host observer；官方 input tape 只作附件，不再次驱动 native。默认不开录制，不复制 duplex 诊断 payload、不包装时钟、不建 recorder/轮询；停止后恢复 mode0。开启/关闭消融比较完整帧摘要，不以一次 debug 计时换算功耗或生产性能收益。

## 2026-11-03：录制实施前的集成验证

以下只汇总本轮可读日志和子代理验证回报；Duo 日志中的 `tearDownAll` 不计为业务 case，没有从日志补算未显示的通过数。模拟器结果不等同于真机功耗、稳定性或持续 FPS 结论。

| 范围 / 证据 | 结果 |
| --- | --- |
| SDK Dart tests + analyze：`/tmp/pocket-sdk-current-final-tests.log`、`/tmp/pocket-sdk-current-final-analyze.log` | 33 项通过；`No issues found`。 |
| Demo Dart tests + analyze：`/tmp/pocket-demo-current-final-tests.log`、`/tmp/pocket-demo-system-final-analyze.log` | 20 项通过；`No issues found`。 |
| `pocket_services`：`/tmp/pocket-services-final-tests.log` | 27 项通过。 |
| Flutter bridge：`/tmp/pocket-bridge-post-fix-tests.log` | 68 项通过；覆盖真实 FFI、停表/deadline、外部响应唤醒竞态、输入和 T8 字形绘制。 |
| JS SDK/System Bun：`/tmp/pocket-sdk-system-final-bun.log` | 50 pass、0 fail、418 `expect()` calls，跨 13 个文件。 |
| demand scheduler：`/tmp/pocket-demand-current-final-tests.log` | 11 个 JS 行为测试通过、54 `expect()`；真实 JSX→QJBC/PAK→native 消融中，按需路径 deadline 回调 1 次、continuous 路径 300 次，均在虚拟 frame 300 执行；最终 wake delay 分别为 `-1` 与 `0`。 |
| PocketJS 固定上游虚拟时钟：`/tmp/pocket-deterministic-clock-test.log` | 9 pass、0 fail、26 `expect()`；仅覆盖 clock、`after()`、effect FIFO/下一次 drain 和 trace，不代表完整模拟器/WASM。 |
| Demo JS 全流程：`/tmp/pocket-demo-guest-current-final.log` | reducer、平台中立 hardware contract、JS→frame 消融、Guest build、静态 native probe 均完成；100/500 节点 probe 为 541/1761 DrawOps。 |
| Duo SystemUI：`/tmp/pocket-duo-js-system-closure.log` | 3 个业务 case 通过；最终 `+4` 含 1 个 `tearDownAll`。真实 guest A/B、共享 identity、结果/消息、失败回收和 prewarm 复用均在此范围内。一次 debug 模拟器消融记录 `cold=203ms`、`warm=105ms`、`residents=2`、`reused=true`。 |
| Duo 系统键盘：`/tmp/pocket-duo-system-keyboard-final.log` | 1 个业务 case 通过；最终 `+2` 含 1 个 `tearDownAll`，验证真实系统键盘与 viewport resize。 |
| Native Rust | 本轮子代理验证回报为 31 unit + 6 duplex = 37 passed、1 manual throughput ignored。可读 `/tmp/pocket-native-tests.log` 是较早的 30 unit + 6 duplex = 36 passed、1 ignored；不把旧日志冒称本轮 37。 |

真实 Duo 回归发现：外部 `host.response` 在 credited zero tick 后，Promise continuation 会失去唤醒。修复使用 QuickJS pending-job hint，让下一次真实 fixed tick 保持唤醒并 drain pending jobs；没有虚构 tick 数或第二事件循环。`cold=203ms`/`warm=105ms` 是复用同一 instance 的一次 debug 模拟器功能消融，只说明路径行为，不声称真机省电或稳定性能收益；本轮不设 60 FPS 上限，也没有物理能耗证明。

日期：2026-11-02；macOS Apple Silicon，Flutter 3.35.7 / Dart 3.9.2 / Rust 1.93.1 / Xcode 27.2（iOS 27.1 Duo 模拟器）。当前 Demo 路径约定为 `../demo/lib`、`../demo/assets` 和 `../demo/js`（相对于 SDK）；文中旧的 `host/`、`guest/` 仅保留为迁移来源说明。

## 真实运行链

| 验证 | 已执行结果 |
| --- | --- |
| 固定上游准备、6 个补丁、guest 编译 | 完整 `python3 scripts/prepare_upstream.py` 与 `bun scripts/build_guest.ts demo/js --out ../demo/assets` 通过；幂等 prepare；子代理在 pristine 固定 revision 临时目录应用全部补丁通过 |
| QuickJS bytecode 编译 / 加载 | 真实 JS_EVAL_FLAG_COMPILE_ONLY + JS_WriteObject；运行时 JS_ReadObject + JS_EvalFunction；宿主不打包 app.js |
| Rust 单元测试 | 9/9 通过；格式、ABI、摘要、真实运行与输入路径 |
| 静态 native probe | qjbc 加载、ABI、host request/response、真实 pointer、状态和导航通过 |
| JS/字节码消融 | 只修改 JS 标题再编译 qjbc，不改 Dart/native，真实 DrawList 标题随之改变 |
| Flutter renderer 单元 / widget | 初期 11/11 通过；加入输入生命周期回归后最新 15/15 通过，见下方输入专项；覆盖字节码、缓存、绘制、pointer、FPS 采样与输入边界 |
| 签名包工具 Bun 测试 | 10/10 通过；92 assertions |
| 服务 Dart 测试 | 14/14 通过；签名篡改/未知 key/ABI/blob 摘要拒绝、权限撤销/再激活、迟到响应、清理指针 |
| Host analyze / widget | 通过；后续性能测试见专项记录 |
| macOS 真实 Flutter/native 页面测试 | 计数、Gallery 往返、Runtime/Bytecode/Plugins、真实 package_info_plus、未配置更新的错误通过 |
| macOS 真实签名更新测试 | embedded → v1 → v2 → rollback v1；签名正确但启动失败的 broken → 自动恢复 v1；重新挂载宿主仍加载健康缓存；通过 |
| iPhone Duo / iOS 27.1 模拟器 | 最新字节码与插件构建通过；计数、真实 package_info_plus、500 retained nodes、签名 v1/v2、回滚、坏包自动恢复、缓存重启完整通过 |

更新测试通过 `PocketCanvasPainter` 的实际绘制文本定位，再经 Flutter gesture → FFI → JS。Apply 必须更换 PocketView/native 实例；坏包恢复必须观察新实例、恢复后的 ready 和真实错误，不能仅凭旧标题判断。

历史构建尺寸不作为当前产物契约；实际字节码大小和 ABI 以 `../demo/assets/app.bytecode.json` 为准。每次 JS / SDK UI 修改后重新编译，禁止以旧产物代表新源码。

## Editor production build / publish（2026-11-02）

`bun test editor/test/editor_server.test.ts scripts/tests/build_guest.test.ts`：4 tests、61 assertions 通过。覆盖多文件读写边界、显式外部项目、真实 installed-only `@pocket/ui` 构建和 node_modules 原样恢复；同一项目构建有互斥，CLI/editor 共用 `buildGuest()`。`tooling_scene.test.ts` 的脚本断言验证默认 Scene 模板和自定义 AppDelegate 保留，exit 0（不是 Bun 注册测试计数）。

生产 runner 的 `editor_live_probe.ts` 通过真实 QuickJS qjbc / PAK、Ed25519 签包、blob 摘要、PAK 重组，以及坏源码不能发布旧构建的验证。最终本地服务 `http://127.0.0.1:8790` 使用最新代码运行，showcase revision **17** 已通过多文件 API 同步冻结 guest 并 build/publish：

- qjbc：233,227 bytes；PAK：333,536 bytes。
- ABI：`quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021`。
- 独立校验 Ed25519 签名、entry/PAK 摘要与大小、20 个 blob、重组 PAK 和 metadata 全部通过。
- 发布入口：`/updates/showcase/latest.json`；客户端公钥配置：`/updates/showcase/host.json`。
- editor 与 `../demo/assets` 的字节码 payload 摘要、尺寸及 PAK 一致；构建路径注释使 sourceSha/header 和整个 qjbc 文件摘要不同，不将它描述为跨路径字节完全一致的构建。

这验证的是 loopback 本地编辑/发布闭环，不是多人生产部署服务。私钥留在忽略的工作区，不进入 Flutter 安装包。

## FPS 历史专项

- 右上角常驻当前/最低FPS，所有构建模式可用。
- 真实 iPhone Duo `fps_history_test.dart` 通过：UI线程每60ms阻塞45ms持续3秒，标签最低值下降；JS FPS页可见；文件记录低FPS/slow frame且maxGap≥40ms；重新挂载读取历史通过。
- 持久化单元测试4项通过：600条上限、恢复、非法值拒绝、写盘故障不影响内存记录。
- 采样窗口边界200ms卡顿测试通过，不漏跨窗口长gap。

## 压力页与性能边界

- 真实 native probe：100 retained nodes 对应 544 DrawOps，500 nodes 对应 1,440 DrawOps。
- iOS 模拟器通过真实点击创建 500 nodes 并绘制，随后继续进行热更测试。
- 以上是正确性/负载测试，不等于设备持续 FPS 基准。收到用户低 FPS 反馈后增加 `performance_test.dart`，对比原项目优化并分别记录 engine、UI build 和 raster；macOS profile 与 iPhone Duo debug 的三个场景均约 60Hz，见 [性能记录](PERFORMANCE.md)。
- iOS 模拟器 debug 结果不能冒充真机 profile/release 性能。

## 修复与消融

- 删除旧 demo 的模拟 C/runtime、Dart bundle runner、Dart 业务组件树、重复路由、故事模板/编辑器。
- 复用 PocketJSKit 的实际 renderer、资源/文本缓存与输入桥接；服务迁入独立包，不混进 renderer。
- 去掉无独立语义的 ScrollRail/WrapLines/WrapTextPage 和遮挡 Home 点击的重复 ActionBar；焦点 scope 覆盖导航。
- macOS 使用静态 runtime，解决 Xcode 27 dylib LINKEDIT alignment；删除重复 dylib 测试路径。
- iOS 宿主、Flutter framework 和 Pods 最低版本统一 15.0，修复 force_load 的 iOS symlink 路径；按 Flutter 3.35.7 自带示例补齐 UIScene 与插件注册，iPhone Duo 启动通过。
- 字节码加载去掉 ROM_DATA 借用标志，确保 FFI 输入释放后 QuickJS 仍持有有效数据；packageSource 优先于内置 asset，失败无源码回退。
- 修复 Dart extension 递归导致 Stack Overflow，添加回归测试并经 macOS/iOS 真链路验证。
- 切包前使旧 generation 失效，取消旧定时器/迟到响应；只有首帧及短运行健康确认后才晋升缓存指针。

## 尚未验证或未接通（截至 2026-11-02 的历史快照）

本节保留 11-02 的原始边界记录；其中 GLYPH_RUN 与按需调度已由上面的 2026-11-03 最终验证更新，不能把下面旧句子当作当前结论。

Android provider 的静态 manifest/minSdk、Dart channel contract 和 JS capability
声明已通过；Android debug APK 已构建成功并包含 arm64 原生运行库。Android 真机硬件、iOS 真机、硬件键盘/IME 的 `GuestFrame.text`、
GLYPH_RUN、通用 compositor、完整组件集合和持续设备性能仍未完成。不能由上述结果
推断这些项目已通过。

## Flutter 系统输入 bridge（2026-11-02）

`../demo/integration_test/system_keyboard_test.dart` 已在 iPhone Duo iOS 27.1 模拟器通过：真实字节码 guest 点击打开 Flutter `TextField`/`EditableText`，通过 `TestTextInput` 驱动实际 `TextInputClient`，验证中文、emoji、selection/composing、删除、done、导航关闭及返回后 JS draft 保留。没有调用 `demo.setText`。此测试使用平台输入桩；系统键盘外观与实际按键另行 UI 检查。上游 `GuestFrame.text` 硬件键盘/IME 通道仍属于未接通范围。

guest 状态测试、架构检查、真实 native probe 与字节码消融均通过，包括真实 pointer 打开输入、测量 rect、edit/submit 回传、无冗余文本 echo、卸载关闭、紧凑视口拖动、open→resize→rect-only update 且不误关输入。移除 JS OSK 并整合原示例滚动后，相比上一版构建，JS 从 331889 降到 301987 字节，qjbc 从 199041 降到 179661 字节，pak 从 334560 降到 291152 字节。输入框只有实际 rect 变化时发送 rect-only 更新，不覆盖 Flutter 的光标和 composing 状态。

`system_keyboard_lifecycle_test.dart` 在 iPhone Duo iOS 27.1 使用真实系统键盘（不注册 TestTextInput）通过：等待实际 viewInsets > 0，持续 3 秒断言同一 EditableTextState、焦点及键盘展开状态；输入框自动移到缩小后的视口内；点击 Gallery 能完成导航并关闭键盘。Renderer 全部 15 个测试通过，其中覆盖画布分块增删、瞬态 inset、outside tap 的 down/up 时序与拖动。

`page_scroll_test.dart` 在同一设备通过：真实多帧拖动让 Home 内容上移并滚到底部，Header/Nav 固定；Gallery 在 360 高度的实际宿主约束下，初始被裁切的底部内容经拖动进入可见区，没有固定超大滚动范围形成的空白尾部，滚动后仍能导航到 Host。全尺寸 Gallery 能容纳内容时不强制它滚动。

滚动整合后的 `guest_interaction_test.dart` 同设备再次通过，覆盖计数、Home/Gallery/Host 路由、字节码信息、真实插件返回、未配置更新错误和压力页交互。嵌套 VirtualList 的边缘滚动交接没有由本轮测试覆盖，详见 SCROLL_REUSE.md。

来源与必要适配见 [INPUT_REUSE.md](INPUT_REUSE.md) 和 [SCROLL_REUSE.md](SCROLL_REUSE.md)。无 overlay key 的消融探针确认画布 sibling 数量变化会替换 EditableTextState；保留稳定 key，并删除依据瞬态零 inset 推断关闭的逻辑。

针对用户 12.17.35 录屏中的整页晃动，修正框架自动视口过渡：旧 native frame 保持 1:1、顶左裁切，等待 resize 后的新 frame，不再 contain 缩小后恢复。扩展后的 `system_keyboard_lifecycle_test.dart` 已在真实 iPhone Duo 再次通过：键盘展开及收起期间，每个 Flutter frame 的主画布 scaleX/scaleY 均为 1，left/top 相对宿主均为 0；同一编辑器、焦点、自动上滚后的可见性和导航关闭仍通过。测试回调直接读取 Element/RenderBox，避免异步 pump 期间调用受 guard 保护的 WidgetTester 查询。

普通 `lib/main.dart` 已重新启动并保留运行。`artifacts/input/keyboard-after.mp4` 记录实际系统键盘展开、输入及收起；`keyboard-transition-after.jpg` 是展开过渡的 20fps 分帧复核，页面保持满宽和左上锚点。录屏包含 iOS 键盘首次使用提示；它属于系统 UI。辅助 surface 的滚动容器保留原有有限尺寸 fit，避免无界高度下应用 OverflowBox；renderer 15 个测试及分析再次通过。

普通 iPhone Duo Demo 已从 `lib/main.dart` 启动并 detach 保留，非测试入口；display=3 截图实际显示 `FPS 60 | min 55`。新日志首20条最低55.4、最新60；截图位于生成目录 `artifacts/performance/iphone-fps-label.png`。

## 2026-11-02：通用光学 surface 与宿主回归

- `POCKET_TEST_ASSETS=../demo/assets POCKET_TEST_SOURCE=../demo/js/.pocket-build/app.js cargo test --locked --manifest-path native/Cargo.toml`：9 个 native 测试通过，包含 retained host surface 注册、参数变化、裁剪和释放；测试资产由 Demo 显式传入，SDK 不再硬编码 Demo 路径。
- `packages/pocket_services: dart test`：14 个测试通过，包含 provider 权限/激活失败时撤销准入。
- `packages/pocket_flutter: flutter test --no-pub`：20 个测试通过，包含 safe area / keyboard overlap / 嵌套点击和平台纹理授权撤销。
- `demo: flutter test --no-pub`：新增 Android-shaped hardware contract 后 14 个测试通过；
  `flutter analyze --no-pub` 无问题。
- Android 硬件脚手架：`bun sdk/scripts/tests/android_scaffold.test.ts` 通过，覆盖最小
  权限声明、Android 12 BLE flags、无用媒体/录音/传感器权限消融与 API 24 minSdk 的幂等 patch；
  `demo/js/tests/hardware_platform.test.ts` 和 `demo/test/hardware_plugin_test.dart`
  覆盖 JS/Dart 不按 iOS 硬编码硬件 capability。尚未把静态结果记为 Android 真机验收。
- iPhone Duo iOS 27.1 `hardware_native_test.dart`：真实 MethodChannel 权限查询、不支持错误与 session 清理通过。此项不代表摄像头/BLE/定位/生物识别的真机验收。
- iPhone Duo `glass_optics_test.dart` 通过真实 FFI `SURFACE_QUAD`、Impeller shader、形状变化、关闭 warp、移除 surface、偏移窗口裁剪后的 raw RGBA 等价断言。截图位于 `artifacts/showcase/glass-*.png`。
- 光学消融移除了重复的 Gaussian blur compose，使用复用 shader 的采样核；修正了将 backdrop 全画布误当局部 lens 的坐标。只有包含 glass 的画布隔离采样层，普通页不增加 saveLayer。

执行命令：

```sh
cd ../demo
flutter drive --driver=test_driver/showcase.dart \
  --target=integration_test/glass_optics_test.dart \
  -d 4D366210-290E-46DB-8BC6-3C5233700409 --no-pub
```

正式页面回归使用 `sdk_regression_test.dart` 汇总既有测试，共用截图 driver；Duo 实际开合由 `duo_geometry_native_test.dart` 单独验证，详见公共 SDK 记录。


## 公共 SDK 集成回归（2026-11-02）

- `sdk/test`（Session 集成测试）：3 个会话测试通过，包含独立 appId、外部 plugin factory、必需能力拒绝、初始化中关闭；analyze 无问题。
- `packages/pocket_flutter`：最终 25 个测试通过，analyze 无问题；包括原生几何坐标转换、错帧延迟、嵌套/固定视口、FPS 安全区和既有输入/绘制回归。
- `packages/pocket_services`：14 项通过；签名发布工具 10 项 / 92 assertions 通过。
- `demo/test`：公共 SDK 迁移后 13 项通过，硬件测试直接导入 `pocket_hardware`，不再依赖 host 私有 adapter。
- iPhone Duo `hardware_native_test.dart` 在自动插件注册后再次通过：真实 qjbc 页面启动、原生 MethodChannel 可用性/不支持错误和清理。仍不代表物理相机、BLE、定位等真机能力验收。
- 独立临时工程通过 `init → build --platform=ios-sim → flutter analyze → flutter build ios --simulator --no-codesign`；SDK 未反向依赖 Showcase 的 `demo/lib` 或 `demo/js`。

已完成：SDK 设备 8 场景回归、签名更新完整生命周期、Duo 真实开合 geometry、硬件原生通道、两个独立脚手架工程真实 pointer 输入均通过。Editor revision 17 的签名、20 个 blobs、PAK 重建与宿主 bytecode payload 已核验；这是本次输入修复前的集成基线。删除旧目录后，独立输出目录重新编译与 native probe 均通过，生成的 bytecode metadata 与宿主一致。设备日志分别为 `/tmp/pocket-sdk-device-verified.log`、`/tmp/pocket-sdk-updates-stable.log`、`/tmp/pocket-duo-geometry-final.log`、`/tmp/pocket-hardware-sdk-ios.log`、`/tmp/pocket-external-sdk-final.log`、`/tmp/pocket-sdk-template-device.log`。模拟器原生通道通过不等同于实体硬件全覆盖。

## 输入录屏与 Update Check 修复（2026-11-02）

用户 `14.44.40` 录屏的问题修复后，`input_regression_test.dart` 在同一 iPhone Duo 模拟器完成 4 个实际场景：系统键盘生命周期/逐帧横向锚点、中文 emoji selection/composing、真实页面滚动、Editor 签名更新 Check。日志 `/tmp/pocket-input-device-final.log`，Flutter 的 +5 包含 tearDownAll，实际业务测试为 4。更新结果为 `stage=verified`、`available=0.1.1`、`lastError=none`。

输入包单测 7 项与 analyze 通过；最新版 native QuickJS probe、mobile 几何断言、host analyze 通过。新版 embedded qjbc 为 235139 bytes，PAK 为 333472 bytes；Editor revision 18 发布相同 JS SDK，PAK 一致且签名、17 个 blobs 校验通过。服务端与 embedded 的完整字节码 hash 不承诺跨构建路径一致。

真实系统键盘录像：`artifacts/input/input-fix-keyboard.mp4`，截图：`artifacts/input/input-fix-keyboard.png`。视频确认输入框保留浅色背景，键盘展开时只发生必要的纵向滚动，右侧导航保持原位。修复来源与消融解释见 `INPUT_REUSE.md`。

Editor 服务补充：已从工具 PTY 切换为本用户临时 launchd job（PPID 1），`editor_service.sh` 的隔离端口 start/status/stop、独立 shell 健康检查、服务内部实际编译均通过。只显式传入 PATH/HOME，不复制整份工具环境；退出登录或重启后需重新 start。普通 App 已显示 `active=0.1.1`、`lastError=none`。

## SDK / Demo 两入口整理（2026-11-02）

顶层仅 `sdk/`、`demo/` 两个工作目录。`sdk/pubspec.yaml` 是公共 Flutter 包，
`demo/` 是 Flutter 工程根，页面和 JS 工具位于 `demo/js/`。
Demo 运行依赖只有 Flutter 与 `pocket_sdk`，其他直接包引用只用于测试。
CLI 与 Editor 共用 `sdk/templates/app/app.tsx`（App）与 `sdk/templates/game/app.tsx`（Game），本地更新服务只有
`sdk/scripts/serve_updates.ts` 一份实现。

新路径下：独立 CLI init/build、Editor live build/publish、SDK Flutter 测试、
Demo analyze、JS reducer/mobile/native probe 和字节码消融通过。
Rust 9 项测试显式传入 Demo 编译产物，无缺少 fixture 时的静默跳过。
Demo 最终 qjbc 235139 bytes，PAK 333472 bytes。

最终 `demo/` 路径真实设备回归：`input_regression_test.dart` 4 场景全部通过
（系统键盘逐帧布局、中文/emoji/选区、页面滚动、签名 Update Check）；
日志 `/tmp/pocket-layout-device.log`。公共编译器的 Bun file-dependency
逐文件 symlink 回归为 2 pass / 27 assertions，构建后依赖链接恢复原状。

## Android 硬件接入（2026-11-02）

- `sdk: bash scripts/build_native.sh android` 成功，APK 包含
  `lib/arm64-v8a/libpocket_flutter.so`（2,328,464 字节）。
- `demo: flutter build apk --debug --no-pub` 成功；硬件插件自动注册，
  app 合并 manifest 最低 API 24。
- `demo: flutter test --no-pub`：14 项通过；`flutter analyze --no-pub` 无问题。
  Android 脚手架幂等 patch、JS hardware/mobile 测试及 SDK 架构边界检查通过。
- 在 MAA_AN00（Android API 36）执行 `hardware_native_test.dart` 的安装阶段，
  设备返回 `INSTALL_FAILED_ABORTED: User rejected permissions`，尚未启动测试。
  这不是硬件调用结果，不能记为真机验收通过。
- 相机采用 Camera2 + Flutter Texture，照片为应用私有文件；BLE、传感器、
  生物识别和定位使用 Android 原生 API。真实权限交互、相机帧方向/镜像、
  BLE 外设连接、GPS 和生物识别用户交互仍需设备专项验收。

Android API 35 arm64 模拟器最终运行：
`flutter drive --driver=test_driver/integration_test.dart --target=integration_test/hardware_native_test.dart -d emulator-5554 --no-pub`
通过（`All tests passed`）。实际加载新版 235,404 字节 QuickJS qjbc，验证
启动页面、生产原生 channel、权限状态、未授权相机结构化错误、传感器响应
及两次 session 清理。此前暴露相机错误返回 `PlatformException` 的不一致，
已修为统一 map 后重跑通过，没有放宽测试。该结果仍不代表物理外设验收。
`pocket_flutter: flutter test test/pocket_surface_test.dart` 2 项通过，
包含 Texture 的 90° 旋转和镜像；动态旋转仍需设备验证。

集成测试结束后重新执行普通 `flutter build apk --debug --no-pub` 成功，
`demo/build/app/outputs/flutter-apk/app-debug.apk` 为普通 Showcase 入口。

## 2026-11-13: Studio M7 hardening (shared components, keymap hooks, recording regression)

Linux container, real debug native library. New SDK surface: `Tree`, `SplitPane`, `TabsBar`, `ToastHost` (`SHARED_EDITOR_COMPONENTS.md`),
`CodeView onKeyDown`, `InputField autoFocus`, and a `PocketView` fix: host font metrics are now synced right after the runtime is created
(before compositor/offload/worker configuration) so a recording, which locks its font snapshot at the first recorded transaction, no longer
defers the sync and fails to load a native-text bytecode. Evidence: `studio/test/studio_recording_test.dart` records a real Studio journey
(open, edit, save, build, publish) and replays it offline and from the exported archive with every frame digest matching (about 355-375
transactions, 122-130 frames). `packages/pocket_ui/test/shared_components_{model,native}.test.ts` (bun 3 + probe 5). Full SDK suites after the
change: pocket_flutter 307 passed, sdk `flutter test` 202 passed, Rust all passed, pocket_services/pocket_studio/pocket_clipboard passed.
`bun test packages/pocket_ui ...`: 321 passed, 5 failed; the failures (`accessibility.test.ts` x2, Duo close hitbox in `system_kernel.test.ts`,
file-level errors in `wrap_text_lines.test.ts` and `flutter_widgets.test.ts`) come from `mock.module` leaking between files in one process and
persist with the new exports removed; each file passes when run on its own.
