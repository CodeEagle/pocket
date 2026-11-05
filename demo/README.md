# Pocket Showcase Demo

这是 SDK 的唯一示例应用。Demo 第一层就是 Flutter 工程；所有 JS/TS 代码集中在 [`js/`](js/) 中。

先看两个入口：

- [`lib/main.dart`](lib/main.dart)：薄 Flutter host，配置 `PocketSystemHost` 与可信应用目录；多应用策略在 JS SystemUI。
- [`js/app.tsx`](js/app.tsx)：Showcase 的 JS 入口，负责页面、状态、路由、移动 UI、转场和硬件能力演示。液体玻璃演示入口暂时移除，SDK 组件仍保留。

Showcase 的一级入口为 **Home / UI / Host / Settings**。二级页面使用固定顶部
Navigation Bar 和 Back，隐藏底部 TabBar；返回后恢复当前一级入口。Settings 集中
管理浅色/深色、四种强调色和界面密度，使用现有设备存储保存，下次启动恢复。
Push 保留调用页实例与滚动、输入及局部选择；Back 只销毁退出的二级页。一级 Tab
保留各自页面状态，隐藏页面停用手势、输入法和弹层。见 [路由生命周期](../sdk/docs/SHOWCASE_ROUTING.md)。
实现来源、消融与交互验证见 [Showcase 重写记录](../sdk/docs/SHOWCASE_REWRITE.md)。

Profile → Lobby 是嵌套的 JS guest 调用：Lobby 的 “Return visits to caller”
只返回 Profile，Profile 的 selected/stored identity 会保留；用户再按 Profile
自己的 “Return to Showcase” 才返回 Showcase。Lobby 被宿主取消时也只恢复 Profile，
不会自动关闭整个调用链。

运行 Demo：

```sh
cd /Volumes/ORICO/Development/Github/pocket/demo
flutter pub get
flutter run -d 4D366210-290E-46DB-8BC6-3C5233700409
```

Android 同样从 `demo/` 运行：

```sh
flutter run -d <android-device-id>
# 构建可安装 APK
flutter build apk --debug
```

当前 Android 原生运行库提供 arm64，最低 API 24。相机、BLE、运动传感器、定位和
生物识别通过 SDK 的 Android provider 接入，页面继续使用同一份 JS；系统权限由
页面操作触发。硬件支持和实测边界见 [硬件复用记录](../sdk/docs/HARDWARE_REUSE.md)
与 [验证记录](../sdk/docs/VALIDATION.md)。

只改 JS 时：

```sh
cd /Volumes/ORICO/Development/Github/pocket/demo/js
bun install
bun run build:system
```

Flutter 产物和平台工程在 `demo/` 第一层；JS 测试和更新脚本放在 `js/` 下，设备截图与测试产物放在 `artifacts/`。要开发可复用能力，请返回 [`../sdk/README.md`](../sdk/README.md)，不要在 Demo 里复制 SDK 实现。

录制会话不在启动时自动开启，而是由客户端按需控制：在 JS 的 Host → Runtime 页面点击 `Start recording` 启动新录制窗口，随时查看状态、停止录制、验证回放或导出（自动化测试也可通过 `--dart-define=POCKET_RECORD=true` 在首帧前开启）。录制包含各应用的宿主输入、IME、外部结果和二进制通道；导出资产可在原实例销毁后离线导入回放。默认空闲无采集开销，配额、SDK 接口与当前边界见 [录制回放](../sdk/docs/RECORDING_REPLAY.md)。

网页编辑、预览与设备部署：在 `demo/js` 执行 `bun run editor`，打开 **http://127.0.0.1:8791**。该入口直接绑定本 Demo 的 JS 和 Flutter 工程，可选择模拟器/连接设备部署，也可用悬浮 Codex 对话和区域截图辅助修改页面。详见 [Studio 说明](../sdk/docs/EDITOR_STUDIO.md)。

要启用本机 Editor 热更（已有本机签名配置时）：

```sh
# 从 demo/ 执行
bash ../sdk/scripts/editor_service.sh start
flutter run --dart-define-from-file=../sdk/.pocket-build/editor-host.json
```

## Video Lab 手动验收

Showcase 的 **Video Lab** 是独立的 JS 页面，使用本地真实小视频
`assets/videos/clip-a.mp4` 与 `assets/videos/clip-b.mp4`。页面由 root 路由传入
`platform`、`host` 和 `onNavigate`，复用根部固定 `MobileAppBar`，自身持有
`ScrollablePage`，不会复制 Flutter 播放器或使用计数器假视频。

页面分为 Playback、Coverage、Scroll 三个分区，覆盖：

- 默认暂停、显式播放/暂停、快速 play/pause，以及播放中打开
  `pocket.demo.profile` MiniApp 后返回；
- feed 两条目独占、切换页面/返回、真正滚动离屏/回来；
- 移除/重建、同 id 换 asset 仍保留显式 pause，以及失败 asset 重试；
- 页面首屏保留 `video-lab-hero · paused/playing` 原生状态文本、`Native controllers · N`
  快照和有界事件日志；`Inspect native state` 会请求现有 host 的 `video.snapshot`，JS 期望
  策略与 host 提供的真实 `video.state` 始终分开显示；feed、same-id、retry、scroll 也各自
  显示 `video-lab-<id> · <state>`，方便区分 `error`、`ready`、`paused` 和 `playing`。
- 在 iOS/Android 预览或设备上旋转/resize 窗口，并在 Duo 开合前后各检查一次 hero；
  `Cover fit`、`Contain fit`、`Fill fit` 会更新同一个 retained video surface，需结合
  `video.state`、画面边界和遮挡结果人工确认。
- 将 App 送入后台再回前台，确认播放中条目先暂停、显式 pause 不被唤醒、原本的播放意图
  在返回后恢复；该项只在真机 host 的 `video.state` 事件和实际画面上验收。

当前 Video API 的范围是本地 MP4、固定 loop + muted、play/pause、生命周期/覆盖 gate、feed
独占和原生可见性。seek/progress、音量、播放完成回调和网络 URL 尚未暴露，Video Lab 不会把
这些能力列为已通过；`video-lab-hero · disposed` 也只有在 host 发出对应的原生终态后才算观察到。

先跑独立源测试：

```sh
cd /Volumes/ORICO/Development/Github/pocket/demo/js
bun run test:video
```

该测试验证页面源码/API 接线、真实 MP4 asset 名称、意图模型、清理和无轮询约束，
不把浏览器预览的空视频纹理标成通过。真实播放器需要 Flutter iOS/Android 预览或设备
手动验收；只有在 native host 发出 `video.state` 或观察到实际解码/暂停恢复后，才能填写
原生状态结果。
