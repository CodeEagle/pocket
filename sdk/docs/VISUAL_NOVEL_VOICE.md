# 逐句配音与自动播放

## 来源与边界

首先检查保留母版 `pocketjs_flutter_demo/pocketjs_super_app_demo.html:923–953` 的 `playSynthTone`/静音控制，以及 `lib/`、`mini_apps/`、`native/` 和平台目录（排除 `pocket_host/`）：母版的 WebAudio 振荡器没有可迁移的逐句文件配音或原生完成回调。保留 `mini_apps/app_game_detail/main.js` 的 JS 游戏状态和薄原生事实边界。保留现有 `pocket_vn/src/audio.ts` 的单一 JS 音频意图适配器和 `pocket_audio` 的 just_audio 资源白名单边界；本次只补缺少的 token 关联事实。参考 [Ren'Py voice](https://www.renpy.org/doc/html/voice.html) 与 [LetsGal 配音管理](https://docs.avg-engine.com/manual/writing/voice-management)，行 ID、配音资产和实际完成事件分别承担作者绑定、资源解析和自动播放等待。

作者在同一 `story.json` 的 `say` 写入可选 `voice` cue，在 `novel.assets.json.audio` 中映射到 WAV 等资源。Editor 对白检查器复用同一音频注册表，可选择或清空配音；不存在另一份 voice 剧本。多语言目录可把逻辑 cue 映射到另一个已登记资源。

## 单一状态与事实流

引擎快照中的 `voice` 是当前行的暂态播放意图，每次开始、重听、读档、回溯都产生新 token。原生 `media.audio.play` 接收 `playbackId`，just_audio 的 playerState/error 边界回传 `media.audio.playback`：channel、playbackId、status、positionMs、可选 durationMs/error。Dart 不决定剧情、跳读、自动播放或恢复策略，不使用位置轮询。

JS 适配器验证当前 token，再异步调用 `engine.reportVoice()`，防止发布快照时同步重入。旧行、旧播放器、已终止 token 的迟到事实不能推进新行。资源缺失、宿主不支持、播放失败会明确终止等待并报告状态，不假装播放成功。保留音轨和配音复用现有队列；语言切换只更新资源表，下一次 apply 比较解析后的资产，未变的背景音乐不重启。

自动播放必须同时满足文字完成、自动间隔到期和配音结束。等待配音时撤销剧情时钟，原生完成事件再唤醒；模型动画使用已有共享时钟。手动推进、已读跳过仍由玩家控制。菜单/生命周期暂停会暂停配音；恢复由 JS 当前意图决定。存档、回溯检查点不序列化原生状态或 token，读档从句首重播，未实现音频采样点续播。

## 原创示例与可复现生成

Lantern 的 Mira `arrival_02` 绑定完整中文和英文对白。`demo/js/apps/lantern/scripts/generate_voice.ts` 直接从原始剧本和唯一 `novel.locales.json` 取文本，以固定 eSpeak NG 1.52.0 源码 SHA-256 `bb4338102ff3b49a81423da8a1a158b420124b055b60fa76cfb4b18677130a23` 离线生成 PCM16、单声道、22050 Hz WAV；长度分别为 13.60 与 12.37 秒。工具只在忽略缓存中编译，运行时不集成 TTS。该示例是合成人声，不是演员录音。来源与构建工具许可见 Demo `ASSETS.md`。

## 验证与尚未覆盖范围

- `pocket_vn/test/voice.test.ts`：真正完成才释放 auto、相同 cue 不同 token、迟到事实、重听、手动/跳读、暂停、失败、读档与回溯重新发起；存档无原生事实。
- `pocket_vn/test/clock.test.ts`：自动间隔已到但语音仍播时不再安排剧情 wake；完成事件重新安排唯一 wake。
- `bun test sdk/packages/pocket_vn/test demo/js/apps/lantern/localization.test.ts demo/js/apps/lantern/story.test.ts`：49 项、715 个断言通过，包含 JS audio adapter 的 9 项回归。
- `pocket_audio_plugin_test.dart`：16 项通过，包 analyze 0 issues；未带 playbackId 的音乐/音效没有 state/error 订阅，语音替换/恢复/停止按 generation 隔离。
- `novel_voice_locale_native.test.ts`：真实 QJBC 与指针/按钮输入验证自动等待、英文 UI/资源、重听、旧 token 隔离、原始语言存档、全新 Guest 的英文 Continue 与键盘显全。这里的宿主媒体完成事件由协议测试注入，不冒充设备解码。
- `demo/integration_test/novel_platform_test.dart`：同一份游戏 QJBC 在 macOS、iOS 27.2 模拟器和 Android API 35 ARM64 模拟器全部通过。实际 just_audio 解码配音，经过菜单暂停/恢复和重听，实际完成事件走 controller→JS adapter→engine→auto 推进；同时验证纹理像素、模型变形、手动存读与后台音乐恢复。

最终完整游戏日志分别为 `/tmp/pocket-voice-game-macos-final.log`、`/tmp/pocket-voice-game-ios-final.log`、`/tmp/pocket-voice-game-android-final.log`，三者均为 1 pass / 0 fail。验收 QJBC SHA-256 为 `f68194c067936bd1240ac0cd93d61b644620e9374fee8892b7ca05a0b467cb9f`，PAK 为 `f1650c25ed6347b5d6f2c60272655e2451293bc88f6e9008d462382e0cc8299c`。构建产物不是新的剧情源。

完整游戏回归曾暴露音乐恢复命令等待：普通声道被额外订阅状态，取消又经过 async* await-for 转换层。消融后普通声道不订阅，语音直接同步转换源流；上述最终三端回归验证了修复后的组合路径。恢复动画的测试按帧寻找真实顶点变化，避免只比较循环动作的两个端点。

当前不是全章录音工作台：批量导入/导出、录音、识别匹配、波形剪辑和全角色覆盖仍缺失。只有作者已绑定的行参与配音等待；无配音行按普通文字策略运行。
