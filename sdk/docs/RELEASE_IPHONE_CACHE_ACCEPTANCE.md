# iPhone Release 与本地缓存启动验收

2026-11-10。本轮从 FunApp 的本地 Pocket 依赖构建 iOS Release-Dev（AOT Release 模式，Dev 环境），保留原应用数据安装到 `lincoln-phone`（iPhone 15 Pro Max，`com.lovappen.pulse`）。最终构建 179.5 秒成功，编译内核时间晚于本轮 SDK/容器源码修正；最终 Runner 的 41 个 Pocket FFI 符号和 intiface 接口均通过验证。

## 缓存契约

- 完整可用缓存包括已验证的 Host/目录/引导信息和可准入的签名游戏资源包。FunApp 初始加载与按根哈希重载启用 `PocketHostConfig.load(cacheFirst: true)`，游戏继续使用现有 `PocketSession.initialize(cacheFirst: true)`。
- 入口缓存命中先读取本地文件，不发 HTTP 请求；已验证游戏资源从本地挂载，远程更新在后台准备，不阻挡当前游戏。缓存缺失、损坏、不满足准入或缺少目标版本入口信息时需联网补齐，不能将部分下载视为可启动缓存。
- 从旧 SDK 升级时，已有游戏资源缓存会保留，但旧版尚未保存 Host 入口缓存，首次进入需补取一次入口信息。不是重新下载全部游戏资源。
- 删除了 FunApp 遇到信任冲突时自动清空整份信任文件的重试路径；冲突失败时保留原锚点和其他游戏的信任数据。

## 发布和验证

- 新 SystemUI 已发布为 `0.1.0-test.4`：`http://192.168.50.230:8791/test/pocket/0.1.0/pocket.host.demo/latest.json`。
- Showcase 使用 `editor.json` 的显式 `reusePublishedPackages` 复用独立 Lantern 的不可变签名版本；独立 `pocket.demo.lantern` 的发布日志与状态文件哈希保持不变，原固定索引仍由 `pocket-demo-lantern` 拥有。原 409 发布冲突已解决。运行时 System schema 与原游戏身份未变。
- SDK Host 配置套件：11 项通过，覆盖关闭服务器后入口零 HTTP 命中、历史根哈希匹配、损坏缓存网络修复和信任冲突拒绝。
- FunApp 容器套件：5 项通过，覆盖全屏/FPS/退出保护、激活指针保留、入口断网加载、历史目录本地重载和信任文件不被清空。
- Editor 版本套件：4 项、348 个断言通过（宿主同时构建时使用 `--timeout=60000`），包含默认冲突、显式复用、独立根作为子应用、不可变及可变 Host 路径保留外部版本、缺失 owner 拒绝。
- 本次发布 QJBC 的 SHA-256 匹配签名清单；外部 Lantern 引导资源哈希匹配。发布构建产物经 pinned native probe 和实际 Home 返回图标 pointer down/up 输入，观察到唯一关闭容器协议请求。

## 手机验收边界

Release 安装已成功；自动启动时手机锁屏，系统返回 Locked，待解锁重试。上述离线缓存验证来自真实 loopback HTTP / Flutter 回归，尚不能宣称手机上的游戏断网交互已人工验收。

证据保存在忽略目录 `sdk/.pocket-build/release-cache-local-20261110/`。本轮未提交或推送工作区变更。

最终统一审核：本地 `agy` Argon Medium 会话 `f97f1b8e-dbc8-4a1a-b7ca-473a22d4084d` 复核无阻塞 HIGH/MEDIUM 发现。备注的 direct Host + requiredRootPayloadSha256 非索引组合不属于固定索引入口的常规重载路径；缓存缺失仍按现有网络路径处理，不返回错误根描述符。安装日志确认 `com.lovappen.pulse` 安装成功，自动启动返回设备 Locked；已请求用户解锁。
