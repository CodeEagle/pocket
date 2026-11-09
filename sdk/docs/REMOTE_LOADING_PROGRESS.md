# 远程容器加载进度

## 适用流程

远程编辑器 App URL 的加载分为两段：先读取 package index、host descriptor 和引导元数据，再由既有签名更新协调器下载并校验 QJBC / PAK。JS 尚未可运行时，由 Flutter 启动层展示必要的资源 IO 反馈；业务界面、路由和数据请求仍由 JS 管理。

`PocketSystemHostApplication` 的默认远程启动入口与 `PocketGuestSession` 共用内部启动提示。提示显示当前阶段与已接收大小；有可信总大小时显示百分比，没有总大小时使用不定进度条。Host 配置读取按当前 HTTP 资源计数，包下载沿用更新协调器的文件累计计数；它们不是整个容器的加权总进度，切换阶段时可以重新开始。下载结束还需校验及准备运行时，不能把下载 100% 当作界面已经可交互。

## 来源与必要适配

实施前检查保留父工程（排除 `pocket_host/`）：

- `pocketjs_flutter_demo/lib/ui/mini_app_host_page.dart`：保留宿主表面和 JS 内容的职责分离，没有可迁移的签名远程包进度展示。
- `pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart`：YooAsset 展示有阶段文案，但不是本 SDK 的真实网络下载事实，不能直接复用为进度来源。

复用当前 SDK 的 `PocketUpdateCoordinator` 流式字节反馈。原 `PocketSession._prepareOnOpen` 只保存阶段，没有通知宿主，也丢弃了字节数；现在保存只读 `transferProgress` 并通知现有监听者，在完成、失败和取消后清理。检查更新时发送给 JS 的 `updates.progress` 继续使用同一事实记录函数。

Host 配置读取发生在 session 创建之前，使用独立的资源 IO 回调补齐这段空白；沿用原有来源、重定向、大小、哈希和信任校验，不改变准入策略。

实际远程容器验收还发现黑底上的宿主配置错误使用了默认黑字，现统一使用中文错误提示并根据背景选择对比色。更换链接时，FutureBuilder 不再把旧结果当作新请求已完成；旧请求晚到的进度也不能覆盖新请求。

Lantern 远程链接把 `pocket.demo.lantern` 作为根界面运行。默认根策略原先始终取通用 SystemUI 配置，忽略了本地已批准的同 ID 应用策略，导致约 69 MB PAK 被 8 MB 默认限制拒绝。现优先匹配本地应用策略，未匹配时继续回退原 SystemUI 策略；仍通过 `withNativePolicy` 保留远端包身份、更新源和 compositor 信息。没有提高全局包大小限制，也不接受远端自行授予的资源限额。

## 消融与边界

- 不新增下载器、定时模拟进度、全局网络拦截或另一个更新状态机。
- 移除两个启动位置各自的无文案 spinner，复用一个无状态内部组件。
- 不在 SystemUI 运行期间叠加原生业务弹层，不改变 compositor 的准备与首帧准入。
- SDK 默认入口自动接入；自行在 `runApp` 前等待 `PocketHostConfig.load` 的消费者，需要使用其 `onProgress` 回调绘制自己的启动反馈，否则 SDK 尚未挂载，无法绘制。
- 应用内部请求远程数据或图片的加载态由 JS 管理。Lantern 复用自身启动页，显示四项实际读取状态；宿主不复制游戏状态。

## 消费者接入

默认宿主使用 `PocketSystemHostApplication`，通过 `POCKET_HOST_CONFIG_URL` 提供远程链接，自动展示两段启动进度。

### 加载期间返回与取消

Debug 页应先推入容器路由，让 SDK 在路由内异步加载；不要在主界面按钮回调中先等待整包下载完成才导航。动态链接可直接传 `PocketSystemHostApplication.hostConfigUrl`，SDK 自动管理读取进度和取消。远程容器保留一个宿主“返回退出”入口，并支持系统返回与 Esc；该入口在 JS 自身仍等待初始化时也可使用。

退出先返回外层 Navigator，保留原主界面状态，随后异步清理。没有外层路由的独立宿主改为打开已有 bundled 主界面。消费者可用 `onExit` 接管导航，但 SDK 不等待回调之外的网络/插件清理后才离开。切换链接、退出和卸载都会取消当前配置请求；已创建的远程 Session 随表面卸载取消下载。旧 Future 即使后来完成，也不能重新挂载远程容器。

`PocketHostConfig.load` / `loadFromEnvironment` 接受可选 `PocketCancellationToken cancellation`。自定义 `loadHostConfig` 仍兼容旧签名，消费者自行持有其 IO 的取消令牌；SDK 会阻止迟到结果显示。优先使用 `hostConfigUrl`，可以避免再写一层无取消能力的加载包装。

自定义 Debug 链接输入页如果自行加载配置，使用新增的可选回调更新已有加载界面：

```dart
final config = await PocketHostConfig.load(
  Uri.parse(appUrl),
  onProgress: (PocketHostLoadProgress progress) {
    // 更新当前启动界面：stage、downloadedBytes、totalBytes。
    // totalBytes 为 null 时使用不定进度，勿自行估算百分比。
  },
);
```

`PocketSession` 的现有 ChangeNotifier 订阅者可读取 `stage` 与 `transferProgress`。回调只表示收到的资源字节，资源仍按原来的校验链准入。重新打开、失败或关闭后，不应复用上一次的进度对象。

## 验收记录

验收分开覆盖真实 HTTP 分块下载的事实通知、进度组件的已知/未知总大小与阶段切换，以及成功/失败/取消/重新打开后的状态清理。桌面实际看到启动提示，并打开用户远程 Lantern 包，通过键盘从首页进入剧情。另使用已生成的固定编译链 QJBC / PAK 夹具，实际下载、原生执行并点击按钮，验证文本从 `Downloaded count 0` 变为 `Downloaded count 1`。

2026-11-09 真实局域网索引读取通过，观察到 `index 2374/2374`、`descriptor 3352/3352`、两项 bootstrap asset 的实际字节回调。macOS Demo 使用同一链接启动，已看到宿主初始化进度提示，随后看到 Lantern 首页；按 Return 后进入人物与对话场景。测试进程已从应用分离，桌面应用保留运行。

```sh
cd sdk
flutter test test/pocket_startup_indicator_test.dart \
  test/pocket_host_config_test.dart test/pocket_host_loading_test.dart \
  test/pocket_background_test.dart test/pocket_system_host_test.dart \
  test/pocket_bundled_application_catalog_test.dart

POCKET_NATIVE_LIBRARY="$PWD/native/target/release/libpocket_flutter.dylib" \
POCKET_ON_DEMAND_FIXTURE_DIR=/tmp/pocket-on-demand-fixture-verify \
  flutter test test/session_download_on_open_test.dart
```

第二条命令需要已经构建的 native library 和由 `scripts/tests/on_demand_fixture.ts` 经固定 `buildGuest` 流程生成的夹具。本次 FFI 输入验收使用已有夹具；真实远程 Lantern 另由桌面运行验证，未用夹具替代该远程包。

最终结果：启动组件/配置/背景/策略/宿主回归 25 项通过，包含 FFI 输入用例的 session 回归 39 项通过，总计 64 项，无跳过。变更范围的 Dart 静态分析无问题。

### 远程 Lantern 实跑中的独立限制

用户提供的索引把普通 Lantern 应用标成 SystemUI 根包（`sdk/editor/server.ts` 的 `aggregateHostConfig` 与发布索引生成逻辑）。当前该应用没有安装 `installPocketSystem`，而 `PocketSystemHost` 的 `platform.*` 代理会把请求路由到根 JS kernel。旧测试包的存储请求曾依次等待 30 秒应答超时，再由应用自己的 catch 进入首页。当前 Lantern 已并发读取，并由真实桥接超时回退；这仍与包下载进度不同。

正确的后续修复应区分单应用容器和多应用 SystemUI 发布：使用真正安装 JS kernel 的 SystemUI shell 承载普通应用，或明确提供与单应用宿主相符的 JS/存储能力接入。不能用 Dart 业务路由绕过它，也不能用伪成功应答掩盖。此次加载进度不宣称已经修复该存储路由问题。

### 可取消与游戏内加载的补充验收（2026-11-09）

保留父工程的 `pocket_services/lib/src/pocket_package.dart`、`pocket_update.dart` 的取消令牌与分块读取语义。配置加载复用 SDK 的同一个取消令牌，取消时 abort 当前 HTTP 请求；不关闭消费者共享的 HttpClient。bootstrap 哈希移入后台 isolate，等待结果时可取消，不再继续请求后续资源。

`flutter test test/pocket_host_loading_test.dart test/pocket_host_config_test.dart` 共 13 项通过：请求头等待、分块 body、共享 client 后续请求、取消后无进度/后续资源，以及按钮、Esc、系统返回和迟到结果隔离。真实 macOS Demo 在远程 Lantern 自身启动页点击返回后回到 bundled 主界面，点击计数按钮使 JS 文本从 00 变为 01。带外层路由时保留页面状态由 widget 路由测试验证。

用户提供的固定测试索引最初仍指向 `0.1.0-test.2`，其游戏加载页只有“正在翻开雾港手机”一行。现有 Lantern JS 已有标题、装饰与四项真实启动读取反馈；通过本地编辑器既有发布接口先更新同一测试索引为 `0.1.0-test.3`，移除启动装饰图片后再发布 `0.1.0-test.4`，不另造游戏 Loading。`bun test tests/novel_startup_native.test.ts` 3 项、31 个断言通过，验证实际字节码的 0/4→1/4→2/4→3/4 帧变化、并行读取超时与点击进入剧情。它不是整包下载百分比；下载前仍使用宿主 IO 提示。

ZIP / 7z 解压与逐文件哈希沿用原验证函数，移到可终止的独立 isolate；只传文件路径，避免向 UI isolate 复制整包数据。取消会终止 worker，临时目录在 finally 清理；完成校验后才把 blob 纳入缓存，不推进 active/healthy 指针。12 MiB ZIP/7z 的主 isolate 心跳与 32 MiB 7z 取消用例包含在 `pocket_package_update_test.dart`。原生运行时加载 QJBC/PAK 的同步 FFI 边界仍未改动，本次不宣称任何尺寸的运行时初始化均零卡顿。

桌面复查发现已验证健康缓存会按原更新策略继续启动旧版本。此次为测试新包，将 `host_0618ad6020ecb93001bf39ee` 包缓存目录重命名为 `.before-loading-test3-120758` 备份后冷启动；未删除旧数据。下载成功后已进入新包首页。固定索引发布不等同于消费者已经执行 Check/Apply，验收时需区分这两件事。

Lantern startup fallback 的装饰 `NovelSkinFrame` 图片被消融，改为已有底色和简单边框。四项读取的状态、文案及 ready 条件保持不变，使启动反馈自身不再依赖图片解码。编辑器重新通过固定 buildGuest 构建后，直接下载新 QJBC/PAK/metadata 到 `/tmp/pocket-lantern-loading-final` 跑 native 测试：3 项、33 断言通过；初始与 1/4 帧均没有 image/textureTriangle 绘制，后续 2/4、3/4、首页和点击剧情行为继续验证。首帧 gate 的实际时序还取决于设备，未用固定延时强制展示。

最后复跑 `session_download_on_open_test.dart`：39 项全部通过，含真实 native pointer 输入；配置/返回 13 项与 Lantern 3 项共 55 项通过，包解压 worker 测试另列。当前工作区宿主相关五文件静态分析无问题。

新测试包最终为 `0.1.0-test.4`，固定 URL 保持不变；test3 冷启动包缓存另保留在 `.before-loading-test4`。备份只用于本机验收，不属于源码或 SDK 交付。

消融对照：同一新增断言运行旧 bundled QJBC，启动首帧检测到 18 条图片绘制而失败；运行重新编译的新 QJBC 则为 0 并通过全部三项。随后 macOS Demo 使用固定测试链接实际显示 Lantern 标题、当前“正在读取语言偏好”、`已完成 0 / 4 项启动读取` 及四项各自状态，宿主返回入口持续显示。没有把 native Guest 测试当作 Flutter 可见性的替代。

收尾结果：包更新单文件 17 项全部通过。心跳测试记录最后下载块到处理完成的完整时长与最大 timer 间隔，要求至少 10 次响应且最大间隔小于处理窗口一半；取消用例覆盖真实 32 MiB 7z。连同上述 55 项，本轮最终 72 项通过，无跳过。收窄后的 package 实现及测试静态分析无问题，`git diff --check` 通过。
