# 后续状态

2026-11-10 后续修复已解决本文记录的发布 409，并补齐入口离线缓存；Release 已安装到 iPhone。最新验收与边界见 [RELEASE_IPHONE_CACHE_ACCEPTANCE.md](RELEASE_IPHONE_CACHE_ACCEPTANCE.md)。以下保留前一轮调查记录。

# FunApp Pocket 容器入口

2026-11-10。源码优先调查复用了保留母工程 `pocketjs_flutter_demo/lib/ui/mini_app_host_page.dart` 的宿主退出边界，以及当前 SDK `PocketSession.initialize(cacheFirst: true)`、`PocketPackageStore.lastGood` 的验证与更新流程（排除母工程 `pocket_host/`）。没有增加第二套缓存选择或导航状态机。

- FunApp `TryFunPocketRemoteContainer` 不再在每次读取 Host 配置后清除 active/lastGood 激活指针；`PocketSystemHost.fromHostConfig(cacheFirst: true)` 把缓存优先策略传入根 SystemUI Session。可用的本地签名包先挂载，更新在后台准备；无缓存、损坏缓存或版本准入失败仍走正常下载与校验。Host 描述符和信任验证仍需执行，不承诺完全离线启动。
- FunApp `TryFunPocketRemoteContainerPage` 改为无 AppBar 的简单页面，删除原有全局 Key、配置副本与刷新导航栏状态。JS SystemUI Home 的返回图标通过正式 `system.container.close` 请求调用 `onClose`，FunApp 仅退出当前仍位于栈顶的容器 Route，防止连续点击误退出下方页面。协议详情见 `SDK_INTEGRATION.md`。
- Debug 打开入口显式启用 `showFps`，通过 SystemUI 根 PocketView 显示 SDK 的 `Guest ticks/s` 标签；这是 Guest 帧调度指标，不能等同屏幕刷新率。子应用不重复叠加标签。
- Debug 页面增加 Lantern 快捷入口，沿用当前输入地址的 HTTP(S) origin，默认 `http://192.168.50.230:8791/test/pocket/0.1.0/pocket.demo.lantern/latest.json`。索引应从签名发布日志和不可变资源解析，不以原项目源目录仍然存在为前提；不创建空项目或篡改发布归属。

验证：既有 Session cacheFirst 的 5 个场景通过，覆盖持有/阻塞的网络请求不会挡住缓存、冷下载、后台失败与下一次打开更新。JS 内核协议测试通过；真正编译的 SystemUI QJBC 经 pinned native probe 和实际返回图标 pointer down/up 输入，观察到唯一 `host.request(system.container.close,{})`，测试通过。iOS Release-Dev 签名构建成功（Xcode 400.5 秒），最终 Runner 的 41 个 Pocket FFI 及 intiface 接口校验通过。Flutter 关闭协议检查通过；FunApp 4 项回归全部通过，覆盖导航栏消失、FPS 参数、重复关闭不误退、真实 HTTP 取消/错误重试和不删除激活指针。JS System 内核 20 项检查通过，包含目录配置阻塞时仍可退出的消融用例。完整 SDK host 历史套件另有既有 awaitFirstFrame 测试的异步错误捕获失败，本次关闭协议单独运行通过；不把整个历史套件称为通过。

测试发布限制：重建 Showcase 编译产物已成功；尝试发布整个 Showcase 到测试通道时，既有 Lantern 槽位属于独立 `pocket-demo-lantern` 项目，后端正确拒绝跨项目覆盖（409）。本轮没有更改该归属或覆盖旧发布。手机加载已有 Lantern 测试包使用上述固定索引地址；新 SystemUI 返回按钮的远程发布需按既有发布归属处理，不能把本地编译通过称为远程已更新。

历史索引来源调查：保留母工程（排除 `pocket_host/`）的 `docs/04_BIDIRECTIONAL_FFI_WASM_AND_YOOASSET_HOTUPDATE.md` 及审计文档描述了签名 OTA、SHA-256 与回滚；未包含 Editor 发布日志或历史索引服务器实现。本轮对现有 `sdk/editor/server.ts` 的发布日志解析做必要适配，移除对项目源码配置的强制依赖；配置仅用于可选旧版发布迁移。

历史索引回归验证：删除临时项目源目录后，固定索引、不可变 Host、签名清单与资源哈希仍有效，状态和日志字节未变（222 项断言通过）。重启正式本地服务后，用户 LAN 固定 Lantern 索引、Host、清单、1,231,811 字节入口和 14,536,995 字节 7z 包均 HTTP 200，入口与包 SHA-256 匹配清单。此验证不等同 iPhone 端游戏交互验收。

最终审核修正：`PocketSystemHost.fromHostConfig` 将目录准入与已验证根哈希复用统一放在自定义重载回调之前，避免 FunApp 的 IO 回调绕开该策略。直接 Host 描述符没有不可变目录时不安装目录重载器；同根哈希复用描述符，新根才调用自定义传输。Host 配置套件 9 项与 FunApp 容器 4 项再次通过。

最终本地 `agy` Argon Medium 统一审核曾发现 Debug dylib ABI 预检误报及自定义目录重载绕过复用两项问题，均已修正并复核为无阻塞发现。预检仅在 Mach-O 声明依赖时解析 `Runner.debug.dylib`，无依赖的同名旁文件不能掩盖缺失符号。Python 16 项测试通过；实际 Debug-Dev 与 Release-Dev 产物的 41 个 Pocket FFI 及 intiface 检查均通过。审核会话：`16338cb9-8b20-40c1-859e-8e41385619f7`。最新 UI 未安装到手机；本轮未提交或推送。

## 宿主摇晃 Inspector 与 Debug 入口（2026-11-10）

FunApp 的 Debug 页只保留 Pocket 容器入口，移除独立 Lantern 快捷按钮与专用 URL 拼接；游戏继续从 Pocket 首页进入。容器路由使用 `tryFunPocketRemoteContainerRouteName`。内部宿主的 `FlutterInspectorShake.isEnabled` 复用现有 NavigatorObserver 的实际 route membership：Pocket 尚在栈中时禁用摇晃触发，含 Flutter Dialog 覆盖期间；pop/remove/replace 移除容器后恢复。保留魔法点击等手动 Inspector 入口，没有把宿主 Inspector 策略加入 Pocket SDK。

定向导航 widget 测试通过，覆盖进入、Dialog 覆盖/关闭、其他页面覆盖、pop/remove/replace。Dart 格式检查通过。本地 agy Argon Medium 会话 `a7900426-0cc2-4f55-a9ab-9836850b938d` 首次发现 modal 顶层判断边界，改成 route membership 后同会话复核 `NO BLOCKING FINDINGS`。这部分需安装新的宿主构建后生效；不能仅靠 JS 更新。

本轮 iPhone Release-Dev 构建成功（Xcode 90.1 秒，Runner.app 426.3MB），最终 Runner 的 43 个 Pocket FFI 符号与 intiface 导出校验通过。保留应用数据安装与启动成功，证据为 `shake-release-install.json` / `shake-release-launch.json`。原生库已用固定 `build_native.sh ios` 同步当前接口；尚不把手机手动摇晃体验作为自动测试通过项。

用户随后在已安装的新宿主上实际进入 Pocket 并摇晃手机，确认“不再弹出 Inspector”；该项真机验收通过。退出后恢复的自动验收仍由导航回归覆盖，未另声称用户已手动确认。
