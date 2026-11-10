# 缓存进入不重刷与 Home 退出入口

2026-11-10。修正 Demo 的两处消费策略，并发布 SystemUI `0.1.0-test.5` 到原 `pocket.host.demo/latest.json` 地址；无需重新安装 Flutter 宿主。

## 来源与消融

已检查保留父项目 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` 的 Flutter shell 与 safe area 实现（排除 `pocket_host/`）；父项目没有可直接移植的容器退出按钮。保留现有宿主安全区和官方 `system.container.close` 通讯协议。

`demo/js/system.ts` 原先启用了 `createPocketUpdateClient({autoRefresh: true})`，会在启动、更新通知及恢复前台时主动检查并应用更新。宿主 `PocketSession.initialize(cacheFirst: true)` 已负责后台准备下次进入的新包，两条流程重复，JS 主动 apply 可能在缓存进入后切换当前页面。移除 Demo 的自动刷新选项，保留手动更新 API；不增加 Dart 更新状态机，也不改变 SDK 自动刷新的公共选项。

`demo/js/app.tsx` Home 共享导航栏保留返回箭头，并增加显式“退出容器”按钮，两者调用已有带失败处理的关闭请求；其他页面保留返回导航。

## 验证

- 真实 pinned QuickJS 字节码与 native probe：健康更新状态、`updates.changed`、`onResume` 不产生非用户触发的 `updates.check` / `updates.apply`；390px 和 1280px 均有唯一退出按钮；切回手机宽度后实际 pointer 点击只发出一次 `system.container.close`。
- 上述验证同时通过隔离构建和实际发布的 Editor revision 19 构建。
- 手机缓存元数据确认入口为当前 Showcase 地址；尚未把手机人工点击或断网体验作为已通过项。

证据：`sdk/.pocket-build/cache-no-refresh-20261110/`。旧包可能先从缓存进入并后台获取此次修复；新包准备完成后再次进入生效。

本地 `agy` Argon Medium 最终审核会话 `35592489-7f2c-450a-9825-d50b41a6a817`：无阻塞发现。发布索引指向 `0.1.0-test.5`，签名 payload 哈希与索引匹配，entry 哈希与通过 native 回归的 revision 19 `app.qjbc` 匹配。

用户随后要求保留 Home 返回箭头：恢复该箭头并发布 `0.1.0-test.6`。新构建再次通过 native 回归，390px / 1280px 均找到返回箭头与退出文字，手机宽度下实际点击箭头只发出一次关闭协议。SDK plain Session 回归 `warm cache keeps its generation and bridge through a blocked same-manifest refresh` 通过；后台相同签名 manifest 请求挂起／放行以及手动 check/apply 均保持 active package、payload SHA、generation、controller、registry 和挂载次数不变，apply 返回 `scheduled:false`。移除了最初冗余的 widget/runtime 模拟方案。

## Flutter FPS 修正

用户明确要求 Flutter 端 FPS。`PocketView.showDebugFps` 改为复用原 Demo 的 `FlutterFrameMonitor`，显示 Flutter engine `FrameTiming` 的帧节奏；移除 Guest ticks/s 文字及其专用字段、颜色方法和每秒 setState。监控提升为 SDK 的单一实现，Demo 原路径兼容导出。与原实现唯一逻辑差异是底部 SafeArea 适配，HUD 穿透输入。没有采用在 Release 不绘制的官方 PerformanceOverlay。来源与详细验收见 [FLUTTER_FPS.md](FLUTTER_FPS.md)。

原监控 13 项测试和 SDK HUD 显示／隐藏 2 项通过。本地 Argon Medium 在同一审核会话继续复核最终 FrameTiming 实现，无阻塞发现。后台更新的 manifest URL 保持可变端点，不因缓存 descriptor 指向旧版本而冻结；FunApp 仍启用原生 cacheFirst 后台更新路径。

## iPhone Release 安装

FunApp 本地依赖已解析到本工作区 SDK。iOS Release-Dev 最终构建成功（Xcode 832.2 秒），最终 AOT 包含 Flutter HUD，41 个 Pocket FFI 符号及 intiface 导出校验通过。已保留应用数据安装到 `lincoln-phone` 的 `com.lovappen.pulse`，并成功前台启动（PID 2864）。未宣称已在手机上人工点击 Home 或目测 FPS；这两项的输入／显示验证来自上述 native 与 Flutter 回归。安装和启动的成功 JSON 及日志位于同一证据目录。

随后用户手机截图确认 Flutter HUD 已显示（Flutter 76 FPS），但 Home 仍无返回入口。读取该容器实际 active 指针为 `0.1.0-test.3`；`test.6` 已于手机本次打开时下载到 versions（13:47:22），没有覆盖正在运行的旧页面，符合本轮“不后台重刷”策略。已请用户重新进入以验证本地 staged 版本激活；不通过清空缓存强制修正。

### 手机重入后仍回退的真实原因

用户完全退出并重新进入后 active 仍为 test3，test6 目录被失败回退删除。按手机缓存副本分别加载 required-root test3/test6 都成功，namespace 和 index URL 一致，排除入口缓存解析故障。手动以错误的 120Hz native tick 加载 60Hz 包也会失败，但真实 SDK 从包 metadata 读取 60Hz，显示刷新率独立，因此该人工参数错误不是手机故障原因。

最终用 test6 的确切 QJBC/PAK 与手机实际 compositor registry `{profile:2,lobby:3,lantern:63}` 复现：`guest bytecode evaluate: Guest: ui.__surfaces must match every installed child in the System catalog`，栈从 `readSurfaceRegistry` 进入 `SystemAppSurfaces`。Flutter FFI decoder 与 native probe 均得到相同错误。Demo 将 30 个可选官方示例静态声明为 installed，但远程 host descriptor 仅提供三个真实子应用。此前 NativeSession 测试硬编码完整本地 Showcase 的 33 项 registry，未覆盖远程发布边界，不能据此宣称手机新包启动已验收。

修正已落在 JS 消费策略：仅安装实际受信任 registry 中存在的可选示例，并同步打开策略与界面的可用状态。保留完整说明目录、必需应用约束、SDK strict registry 与签名校验；不添加假 handle、不清理健康缓存。

另在 SDK 初始候选准入与运行时恢复入口补精简诊断日志，记录版本/hash/generation/stage/限长错误，便于回退后定位真实失败；focused 回归验证一次失败对应一条日志，健康 fallback 仍可用。

### test.7 发布与手机确认

修复构建同时通过手机三项 registry 和本地完整 33 项 registry；实际 Flutter FFI 解码通过（317 ops），窄屏/宽屏返回箭头与 pointer 关闭协议回归通过。最终本地 Argon Medium 会话 `18e67f77-b96b-48a2-b097-c8ab18174403` 无阻塞发现。

已发布 `0.1.0-test.7` 到原入口，签名 payload SHA-256 为 `2e68cf6f6059a8f6a6dcff5b0dd20f9517bb37421af0b61dd8f7bf3e4e341bb1`；entry SHA-256 为 `44d9a64d75c579d0b97d6ac31ea4913ec0fce1d6a7b876ab14efca33a77c9965`，与通过回归的 740327 字节 QJBC 一致。

发布后首次外部进入：14:36:08 旧版 test.3 启动，14:36:11 test.7 才下载完成；这次不自动重刷符合 cacheFirst 策略，不能据此判定下次激活失败。用户随后通过 App 内手动 update 成功；再次读取手机 active 指针已为 test.7。尚未独立完成“新版已下载后完整外部重入”的真机验收，不把手动更新等同于该项通过。证据分别为 `phone-current/files-after-test7.json` 和 `phone-current/active-after-manual-update`。

本轮重跑 `cacheFirst presents healthy cache through blocked HTTP and uses staged update on next open` 通过：挂起网络时旧缓存立即可用、后台完成不改变当前 generation、后续 open 消费本地 staged 包。此为 Session 自动激活回归，不代替 FunApp 外部入口真机验收。
