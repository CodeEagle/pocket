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
