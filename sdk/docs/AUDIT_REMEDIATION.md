# a5dd273 审查修复记录

本轮与 Argon 隔离分工：Argon 负责 OTA/Store、Editor 安全、方法权限和 iOS 硬件 manager；本轮负责生产通道、二进制帧、调度、构建工具链、可选依赖与测试入口。这里的验证不替代 Argon 修改合并后的权限/更新全链路验收。

## 来源与消融

遵循薄宿主架构，参考保留工程（排除 pocket_host）：

- `pocketjs_flutter_demo/native/pocket_runtime_multi.c` 的 BinaryDrawCmd 说明紧凑数值传输的价值；仅参考传输思路，当前 PFB1 编码仍消费真实 PocketJS FrameOp，不迁入旧 C 状态数组、伪引擎或第二套布局。
- `pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_graphics.js` 的 SVG 规格继续保留。删除当前 SDK 中无人消费的 compute3dMechaFrame/compute2dParticleFrame、line/arc 命令类型及仅自测数学结果的测试；没有伪装为已集成渲染能力。
- 系统硬件实现仍在 pocket_hardware，消费工程通过已有 pluginFactories 注册，不再同时维护 enableHardware 开关与工厂两套注册机制。核心包依赖解析结果已验证不含 pocket_hardware，Showcase 显式依赖该插件。
- 历史 sdk/migrations 归档已被前序提交清理，当前不存在；来源文档与 AGENTS 已纠正，不再要求读取缺失归档。
- 系统输入继续参考保留工程 `lib/render/pocket_ui_components.dart` 的 Screen/ListView 与 `_PocketFlutterNativeKeyboardInput`（约 877–942、3507–3675 行），及 `mini_apps/syslib/pocket_syslib_pages.js` 的 Card 内 keyboard 示例。保留系统 TextField、字段随页面滚动和双向同步的行为；当前 JS 拥有布局，不能直接迁回旧 Flutter 列表布局，也不能复制其会丢失 composing 的 collapsed selection 同步。
- 输入滚动消融排除了一个错误假设：将 `ScrollablePage` 的内联 JSX style 改成显式 `View({get style(){…}})`，在 pinned 编译器中没有额外收益。隔离项目 `/tmp/pocket-style-ablation.rAZXtP` 对比 `c35a3fe` 与改写版，两版均编译出响应式 getter；真实 resize/drag 的输入文本 y 都是 `354 → 304 → 255.64 → 208.866`，相邻 Counter 同步位移，输入 overlay rect 同步为 `346 → 296 → 247.64 → 200.866`。已撤回该冗余改写；此消融不能替代 Duo 宿主的整页联动验收。

## 已调整的接口

- 核心 pocket_sdk barrel 只导出应用入口、配置、会话、插件契约及必要 controller/event/duplex 类型。低层绘制与诊断从 pocket_flutter 显式导入。
- 硬件消费者移除 enableHardware，添加 pocket_hardware 依赖，并配置返回 HardwarePlugin 的顶层工厂。具体代码见 SDK_INTEGRATION.md 和 demo/lib/main.dart。
- 内置 metadata 的 version/build 进入 Session runtimeInfo/status，不能再将内置包报告为 build0。构建侧的来源与平台产物隔离见 TOOLCHAIN_NOTES.md。
- 新帧 ABI 使用紧凑二进制 DrawOp 与原始像素字节，Dart 立即复制借用 buffer 后解码。不是跨 runtime 生命周期持有原生像素指针，也不宣称整个渲染链零拷贝。旧 JSON ABI 保留用于明确的兼容/探针用途。

## 报告中需要纠正的判断

- P2-4 所述 patchIosSceneDelegate 与 PocketHardwareManager.handleIncomingDeepLink 不存在于 a5dd273。实际 patchIosSceneLifecycle 用于 Flutter scene 启动，不是 Deep Link 业务注入。不能据此删除启动兼容补丁或宣称已提供 Deep Link 能力。
- 仅因 Referrer-Policy=no-referrer 不能推导浏览器 POST 必定省略 Origin；Editor 仍应严格校验所有写入口，但具体浏览器攻击须实测。上一轮已实际证明的是另一个 loopback Origin 的 multipart 跨端口写入，此项交由 Argon 修复。
- 原生 SPSC 通道的零拷贝指的是预留槽位与原子游标的传输；指针兼容适配仍可能构造原有 JS 事件，不能宣传全链路零分配。

## 验证

以下命令在真实工作区执行，未使用替代运行时。Flutter 子包命令在对应目录运行：

| 范围 | 命令 | 实测结果 |
| --- | --- | --- |
| Rust runtime | `cd sdk/native && cargo test --locked` | 23 通过，1 个手动 benchmark 忽略 |
| SDK | `cd sdk && flutter test --reporter expanded` | 5 通过 |
| Flutter bridge | `cd sdk/packages/pocket_flutter && POCKET_NATIVE_LIBRARY="$PWD/../../native/target/debug/libpocket_flutter.dylib" flutter test --reporter expanded` | 最后收尾 51 通过，真实 FFI 测试未跳过，含 pointer-up 在 outside-dismiss 前被 GuestFrame 消费及输入文字实际几何对齐；日志 `/tmp/pocket-bridge-final.log` |
| Services | `cd sdk/packages/pocket_services && flutter test --reporter expanded` | 26 通过 |
| Showcase | `cd demo && flutter test --reporter expanded` | 18 通过，包含真实清单/工厂的启动准入测试 |
| Showcase JS | `cd demo/js && bun test` | 11 通过 |
| Guest/native | `cd demo/js && bash scripts/test_guest.sh` | 真实 QuickJS 字节码、输入版本往返、100/500 节点帧及图形消融通过 |
| 静态检查 | `cd sdk && flutter analyze`、`cd demo && flutter analyze`、`python3 sdk/scripts/check_architecture.py` | 通过 |
| Android 构建 | `cd demo && flutter build apk --debug` | 通过 |
| iOS simulator 构建 | `cd demo && flutter build ios --simulator --debug --no-codesign` | 通过；Runner 中检查到 binary frame、duplex 与 create 导出符号 |
| Duo 实际点击 | `cd demo && flutter test integration_test/guest_interaction_test.dart -d 4D366210-290E-46DB-8BC6-3C5233700409 --reporter expanded` | 通过；此前 microphone 声明阻断已由 Argon 修复，再次启动与点击成功 |
| Duo 系统输入 | `cd demo && flutter test integration_test/system_keyboard_test.dart -d 4D366210-290E-46DB-8BC6-3C5233700409` | 通过 |

收尾复核：

- `cd sdk && TMPDIR=/tmp bun test`：最终 19 通过、258 条断言。生成清单的定向测试 `bun test scripts/tests/build_guest.test.ts`：4 通过、58 条断言；Editor 最终打包改动后运行 `bun test editor/test/editor_server.test.ts`：4 通过、98 条断言。
- 真实编译验证 Editor build `42 → 43` 时 `app.bytecode.json`、输出目录清单和宿主 assets 清单同步更新；旧 pocket/manifest 的 build 1 不会遮蔽更新。非法 Editor build 0 不会回退到其他文件的合法 build。
- Editor API 测试验证配置 `0.1.0+1 → 0.2.0+2` 后重新构建的下载清单同步变化，并保留 capabilities。源 manifest 不再重复存储发布身份。
- 最后运行 `cd demo/js && bash scripts/test_guest.sh`，完整通过；随后 `cd demo && flutter build apk --debug` 使用最新 assets 构建成功（64 秒）。

上述设备测试运行在 iPhone Duo 模拟器；不等同于实体 iPhone/Android 硬件能力、120 Hz FPS 或 TSAN 验证。原生 SPSC 的 lock-free 原子协议测试通过，也不代表整个 JS/Dart 渲染链没有分配或锁。

## Duo 输入联动复现

Duo 严格回归补测发现：视口由 `951×669` 缩为约 `951×405` 时，Flutter 字段已在 `(32,366)`，JS 绘制却仍缺少输入卡片。失败日志保存在 `/tmp/pocket-fix-keyboard-lifecycle-final.log`；这项失败不能被其它键盘测试通过所替代。

已用同一 arm64 dylib 对照 JSON 与 PFB1，二者几何一致。原生复现明确区分了时序：修复前 resize 后连续 `frame(0)` 都只有 111 ops；首个 `frame(16)` 才得到 148 ops、输入文字 y372、Counter y320，并发出字段 rect y364。原因是页面 `ensureVisible` 原先只在 `onFrame` 执行，resize 的即时零时间帧不运行它。

修复复用 `display.viewport` 桥的同步通知，在 JS 内先测量页面、调用原有 ensureVisible，再同步字段 rect；onFrame 继续负责惯性与普通滚动。没有伪造 16ms 时间。display 桥共用一个 dispatcher，卸载会移除 observer，避免路由切换累积回调。输入框继承页面 clip，同时保持同一个 EditableText 实例；临时缺失 layout 时直接使用已是 visual 坐标的 fallback，避免重复减 offset；内容宽度暂时为零时仍读取高度。

修复后真实 QJBC 的首个 `frame(0)` 即有 148 ops，输入标题 y320、输入文字 y372、Counter y320、字段 rect y364；下一零时间帧没有重复字段更新。最终 Duo 测试增加整页位移和 Flutter hint/JS text 绝对坐标检查，设备验收结果见下文。

2026-11-02 补充隔离验证：`flutter drive --no-pub --no-dds --driver=test_driver/integration_test.dart --target=integration_test/native_resize_regression_test.dart -d 4D366210-290E-46DB-8BC6-3C5233700409` 退出 0，真实 iOS FFI 在 20 段 resize 与后续稳定帧中保持页面锚点及输入 rect 同步，日志 `/tmp/pocket-native-drive-duo.log`。该用例不创建 PocketView，因此不能替代完整宿主测试。

完整宿主使用同一 driver 运行 `system_keyboard_lifecycle_test.dart`，首先定位到 Flutter hint 顶部比 JS 文本顶部高 3px（`370.5719` 对 `373.5719`），日志 `/tmp/pocket-keyboard-drive-duo.log`。根因是 TextField 继承 Material 3 行高；修复显式使用原生 `font_slot_line_height` 的 `ceil(fontSize * 1.2)` 规则，并保留 2px 容差断言，没有增加平移补偿。新增 widget 测试检查实际 hint RenderBox，而非只检查 style 字段。

修复后完整宿主首次通过（`/tmp/pocket-keyboard-drive-aligned-duo.log`）。清理临时安全区诊断入口后，最终源码再次连续两轮退出 0：`/tmp/pocket-keyboard-final-1.log`、`/tmp/pocket-keyboard-final-2.log`。每轮 60 次采样中，最终 Flutter hint 与 JS text 同为 `(44,372)`，输入标题与 Counter 同为 y320，字段 rect 为 `(32,364)-(360,397)`；同一 EditableText/焦点保留，单次 Gallery 点击完成导航与键盘关闭。两轮均未复现此前 111 ops 的输入卡片缺失。保留有界失败帧记录，便于后续设备/时序出现新复现时定位。

本机 `flutter test --no-dds` 会遇到 golden comparator 的 VM stream 订阅错误，不能将其总退出码直接当作产品结论；上述验收使用项目现有 `flutter drive` 入口分离验证。Duo 为 iOS 模拟器，本次结果不覆盖实体 Android/iPhone 的所有键盘、字体与折叠姿态。


## dd6059d 后续修复（2026-11-03）

本节记录实现与复用来源，不替换根目录用户提供的审查报告。该报告称前序 P1 已全部闭环，但独立运行仍复现了 Editor 静态软链越界、天气间接定位缺权限、公开回滚健康晋升失败、旧 Session 失败污染新 Session，以及 iOS 拍照保存阶段的回调丢失；本轮一并修复。

### 四项边界修复

- Flutter 输入命中与绘制使用同一个字段/页面 clip 交集；不可见区域不再拦截 Guest 点击。继续复用旧工程 `lib/render/pocket_ui_components.dart` 的系统 TextField 与页面滚动行为，布局仍由 JS 决定，没有迁入第二套 Flutter 页面布局。
- `ScrollablePage` 的零宽 viewport 走已有分栏 fallback；内容节点仍允许零宽高度测量。自动 ensureVisible 消费自己的 offset，下一帧不会误判为用户滚动关闭输入。复用当前 `display.viewport` 通知与 scroller，未新增独立键盘滚动器。对照旧工程 `lib/render/pocket_ui_components.dart` 和保留的 PocketJS clear 示例；旧归档已删除，不能作为当前可复现依赖。
- 空闲 timer 只探测一帧，未变化即继续停表；外部输入/消息仍正常唤醒。保留首次空闲时间以扣除连续探测间的全部休眠。参考旧工程 `lib/core/perf_monitor.dart` 与 `native/pocket_runtime_multi.c`，复用现有 ticker 与 native delta ABI，没有增加第二套调度器。
- CLI 与 buildGuest 共用 `resolveReleaseIdentity`，按 editor > pocket > manifest 选取同一个对象；所选对象缺失字段使用明确的 0.1.0/1 默认值，非法字段拒绝，不跨文件混配。Editor fallback 保留 pocket.build，build 必须为正安全整数。开启更新的 Session 必须获得合法内置 build；无更新的旧离线产物可继续缺省 build。

### 状态、权限和生命周期

- Session/store 使用真实签名和持久指针测试宿主 build 1 → OTA 2 → 商店内置 3，以及连续两次重启。测试不是字节码执行替身；真实 QJBC 执行另由 native probe 覆盖。
- 显式回滚通过 prepared package 的 isRollback 单一标记进入既有 store.rollback；普通更新仍保留防降级规则，rollback 目标只允许记录的 previous/lastGood。Session 不再维护重复的回滚布尔状态。健康窗口通过前保留原 lastGood。
- Widget 异步初始化捕获实际创建的 Session；旧实例失败只清理自己，不能设置替换实例的启动错误。
- 天气省略坐标才要求 location 权限；network-only 指定坐标仍可使用。回归测试经过真实 negotiate/activate/invoke，而非绕过管理器直接调用。参考旧工程 `lib/core/real_hardware_bridge.dart`，未扩大插件的必需权限集合。
- iOS 拍照结果持续保留至相册保存完成；capture ID 与 generation 匹配后才能结束请求，busy 请求不递增当前 generation，停止/销毁取消回调一次。来源为旧工程 `ios/Runner/AppDelegate.swift` 与 `lib/core/real_hardware_bridge.dart`；当前 manager/cameraQueue 为唯一实现。
- Editor 对 source/files/manifest/assets/config/旧状态入口统一检查静态路径组件；lstat 能识别 dangling symlink，首次普通文件写入仍允许，最终写打开使用 O_NOFOLLOW。没有承诺防御同 UID 恶意进程并发替换父目录：完整覆盖需目录 FD 遍历或隔离文件系统。

### 消融与验证范围

JS 测试分别恢复零宽 viewport 旧分支、移除 previousOffset 同步，均能触发对应回归失败。空闲测试跨四次 250ms 探测检查第一窗口 FPS；旧的“探测后 ticker 必须继续运行”断言改成检查单帧后再次停表，并继续验证 controller 与 pointer 唤醒。保留真实 QJBC 改写消融，改变字节码必须改变 native 首帧。

实际运行：Rust `cargo test --locked`（23 通过、1 手动 benchmark 忽略）；SDK Bun 全套、Demo JS、`bash scripts/test_guest.sh`、架构检查通过。Editor 原始两条静态软链复现均返回 400，外部目标未被创建或修改；正常外部项目、无 editor.json 的 build 42、首次新目录文件、上传控制均由服务测试覆盖。Flutter/设备收尾结果见本轮交付说明。iOS manager 完成 Swift parse 与模拟器编译不等同于实体相机/相册验证。


独立候选复核又确认：合法 editor.json 的提前返回会漏检 pocket.json，实际编译会跟随相对导入源码软链。本轮补齐启动/加载前两份配置的检查，并在 Editor build 前复用静态输入树校验，覆盖实际自定义 entry、源码链接、嵌套 assets、缓存目录自身链接。node_modules 与既有 vendor/pocket-ui 是可信包边界；生成目录内容不扫描，普通外部 import 仍按本地构建器解析。这不构成任意不可信 JavaScript 的文件系统沙箱。相关正常控制实际运行 buildGuest 并生成 QJBC，不仅使用 fake runner。

新增的回滚失败反例还覆盖了没有 previous 指针的情况：回滚到内置包若在健康窗口前失败，Session 保留的已验证恢复目标可直接恢复 OTA，不必等待进程重启。该引用仅在显式内置回滚健康窗口内存在，不替代 package.isRollback 的晋升标记。

本轮最终验收命令与结果（命令均在所列目录执行）：

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| Rust | sdk/native: cargo test --locked | 23 通过，1 个手动 benchmark 忽略 |
| Session/SDK | sdk: flutter test --no-pub --reporter expanded | 19 通过，含公开回滚、失败回退、重启、商店升级、旧 Session 异步失败 |
| Bridge/真实 FFI | sdk/packages/pocket_flutter: POCKET_NATIVE_LIBRARY="$PWD/../../native/target/debug/libpocket_flutter.dylib" flutter test --no-pub --reporter expanded | 53 通过，FFI 用例未跳过 |
| Services | sdk/packages/pocket_services: flutter test --no-pub --reporter expanded | 27 通过 |
| Demo/硬件权限 | demo: flutter test --no-pub --reporter expanded | 20 通过，含真实插件管理器的天气权限组合 |
| SDK Bun/Editor/UI/构建 | sdk: TMPDIR=/tmp bun test | 28 通过、314 条断言；包含安全反例、合法控制、真实编译 |
| JS Demo | demo/js: TMPDIR=/tmp bun test | 11 通过 |
| QJBC/消融/压力 | demo/js: TMPDIR=/tmp bash scripts/test_guest.sh | 通过；修改真实字节码改变 native 帧，100/500 节点与输入往返通过 |
| 静态分析 | sdk: flutter analyze --no-pub；demo: dart analyze | 无问题 |
| 边界/补丁检查 | python3 sdk/scripts/check_architecture.py；git diff --check | 通过 |
| Swift | swiftc -frontend -parse sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift | 通过 |
| Duo 完整宿主 | demo: flutter drive --no-pub --no-dds --driver=test_driver/integration_test.dart --target=integration_test/system_keyboard_lifecycle_test.dart -d 4D366210-290E-46DB-8BC6-3C5233700409 | Xcode 编译及测试通过；60 次采样后 hint/JS text 均 (44,372)，页面锚点同为 y320，焦点和单次导航点击保持 |

验收期间一次回滚状态消融留下悬空字段引用，首次编译失败，已修正并重跑；并行新增的另一条回滚测试缺声明/未等初始健康时失败，已补齐真实能力准入及健康阶段，最终 19 项全部通过。没有放宽断言、权限或防降级规则来获得通过。

本轮未提交。上述结果不等同于实体 iPhone/Android 的相机、相册回调或所有折叠姿态验证；Linux/macOS 跨主机编译也不在本次设备验收范围。
