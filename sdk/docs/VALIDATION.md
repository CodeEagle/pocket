# 验证记录

日期：2026-11-02；macOS Apple Silicon，Flutter 3.35.7 / Dart 3.9.2 / Rust 1.93.1 / Xcode 27.2（iOS 27.1 Duo 模拟器）。当前 Demo 路径约定为 `../demo/lib`、`../demo/assets` 和 `../demo/js`（相对于 SDK）；文中旧的 `host/`、`guest/` 仅保留为迁移来源说明。

## 真实运行链

| 验证 | 已执行结果 |
| --- | --- |
| 固定上游准备、6 个补丁、guest 编译 | 完整 `bash scripts/test_guest.sh` 通过；幂等 prepare；子代理在 pristine 固定 revision 临时目录应用全部补丁通过 |
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

`bun test editor/test/editor_server.test.ts scripts/tests/build_guest.test.ts`：4 tests、61 assertions 通过。覆盖多文件读写边界、显式外部项目、真实 installed-only `@pocket/ui` 构建和 node_modules 原样恢复；同一项目构建有互斥，CLI/editor 共用 `buildGuest()`。`tooling_scene.test.ts` 的脚本断言验证默认 Scene 模板、自定义 AppDelegate 保留和 Podfile 幂等性，exit 0（不是 Bun 注册测试计数）。

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

## 尚未验证或未接通

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

- `packages/pocket_sdk`：3 个会话测试通过，包含独立 appId、外部 plugin factory、必需能力拒绝、初始化中关闭；analyze 无问题。
- `packages/pocket_flutter`：最终 25 个测试通过，analyze 无问题；包括原生几何坐标转换、错帧延迟、嵌套/固定视口、FPS 安全区和既有输入/绘制回归。
- `packages/pocket_services`：14 项通过；签名发布工具 10 项 / 92 assertions 通过。
- `host/test`：公共 SDK 迁移后 13 项通过，硬件测试直接导入 `pocket_hardware`，不再依赖 host 私有 adapter。
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
CLI 与 Editor 共用 `sdk/templates/starter/app.tsx`，本地更新服务只有
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
