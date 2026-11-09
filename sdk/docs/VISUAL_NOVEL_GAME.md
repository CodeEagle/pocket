# Pocket 视觉小说：故事内容与集成

## 内容来源与适配

按 source-first 要求检查了保留父项目 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`，全程排除 `pocket_host/`。检查范围包括 `mini_apps/`、`docs/`、`lib/`、`test/`、`tests/` 和 `web/`。保留树中未找到视觉小说脚本、对白分支、故事变量、结局或 VN 存档实现；这是本次原创故事与 VN 核心的明确能力缺口，不存在可直接迁移的剧情。

本项目保留的通用行为来源及适配方式：

| 保留来源 | 保留行为 | 本次适配 |
|---|---|---|
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/app_nav/main.js` | JS 持有页面状态并响应命名动作 | 玩家选择由 JS StoryDefinition 驱动 label/变量；Dart 不持有路线状态 |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/app_game_detail/main.js` | JS 更新游戏状态、绘制 HUD，并通过宿主边界取得输入/场景事实 | 叙事状态与事件留在 VN JS core；renderer 和 native 音频只接收场景/播放请求 |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/docs/03_DUAL_HOST_UI_COMPONENTS_SPEC.md` | 保留 UI 控件/焦点/输入语义作为交互参考 | 由游戏 UI 实现选择、回看、回滚、存读和阅读控制，不迁移出一套 Flutter 剧情状态机 |

故事运行时直接使用 `@pocket/vn` 的公开类型与 engine API；不复用或新增第二套解释器、表达式执行器、业务状态机或 Dart UI。剧情源以 `demo/js/apps/lantern/story.json` 为唯一 canonical JSON 文档，`story.ts` 只负责导入并将该文档标为 `StoryDefinition`，以便 app、测试和后续 Editor 共用同一份可序列化数据。AST 条件是 JSON 节点，不包含函数、任意脚本或 `eval`。

## 原创故事

`demo/js/apps/lantern/CONTENT.md` 记录人工完整 walkthrough、玩法条件、资源逻辑键和能力节点矩阵。故事《雾港末班信》包含开端、可变顺序的三处调查、证据组合谜题、16 秒风暴选择与三种收束。正确结局要求同时取得邮路 7、单响 1、分钟末位 4，按顺序输入 714，并通过对 Mira 的信任选择；第一次错误允许复试，第二次错误锁住中继，末班车和留站路线仍可通关。超时会先疏散乘客，再安全地把剧情导向末班车收束。

主要内容键：

- 背景：`station`、`archive`、`roof`、`dawn`。
- 角色：`mira` 与 `ren`，表情使用 `neutral`、`worried`、`hopeful`。
- CG：`truth_letter`、`dawn_departure`、`harbor_light`。
- 音频请求：`music_storm`、`music_letter`、`music_dawn`、`roof_gust`、`station_bell`、`relay_break`、`relay_click`、`train_depart`；Mira 的 `arrival_02` 使用 `voice_mira_arrival_02`，英文目录将同一 cue 映射为 `voice_mira_arrival_02_en`。

这些是 StoryDefinition 使用的逻辑键；资源文件、renderer 映射、实际播放成功情况属于游戏/宿主集成事实，不由剧情文档假定。音频事件是播放请求，story 不会把请求误记成音频已播放。

### 当前主线与试映内容计数

以下计数直接从 `demo/js/apps/lantern/story.json` 的 `script` 计算；指令总数包含 scene、video、jump 等所有 DSL 指令。

| 内容 | Labels | 指令 | Say | Choice |
|---|---:|---:|---:|---:|
| 主线 | 53 | 213 | 67 | 13 |
| 独立立绘试映 | 11 | 39 | 10 | 3 |
| 当前合计 | 64 | 252 | 77 | 16 |

试映通过无结局门槛的 `model_showcase` replay 进入，运行在独立回放引擎，不改主线存档。Mira Spine 与 Hiyori Live2D 各自有三个动作选项；六个动作分支都会先展示一条本地化 say，再返回对应动作目录，给模型留下不被选项遮挡的展示时刻。目录可互相返回，当时主线的 53 labels、213 条指令、67 句对白和 13 个选择保持不变。该数字是旧试映接入时的历史计数。v3 主线排除独立胶片为 71 labels、218 条对白、9,961 汉字；新增因果后续并修复六条漏播对白。最终 QJBC 57ba6efd… / PAK bcbe0d4c… 的完整原生路线、v1/v2 旧档迁移和普通 macOS Profile Demo 均为历史验收，详见 [叙事](LANTERN_NARRATIVE.md)和[迁移证据](VISUAL_NOVEL_SAVE_REVISION.md)，其他平台门槛继续保留。

### 当前普通试玩 checkpoint

普通 macOS Profile Demo 当前运行于独立缓存 `sdk/.pocket-build/lantern-playable-v4-strict-20261108/pocket_host.app`（PID 4789）。内嵌 Lantern QJBC/PAK SHA-256 分别为 `8defe742d93c066cabbaf7e2c8f665f854c05c8ee03c40e706f1578cae9cb962` / `8126d148c8f71d573dbae11927647150d8d96922f88bab48074d018299369c08`；Root UI QJBC/PAK 为 `472720425817eb7f3153887d455ebf70b90515b951b0fe07ce4509ffdfdad89f` / `5955143ed323987400f8db937ccf96f9206be94e5259479c8688b0710c7a4fba`。Metal 与 VM service 已就绪、open 激活请求已接受，Editor 未启动。前台像素检查仍未完成：computer-use native pipe 未能启动，因此不能据此声称已目视确认扉页或游戏画面。strict v4 的模型 390×DPR2 Profile 与视差 Profile 各自通过（50 秒、22 秒）；全四矩阵仍是 e037 checkpoint 的历史证据。当前运行与构建日志为 `/tmp/pocket-lantern-v4-playable.log`、`/tmp/pocket-lantern-v4-playable-build.log`，缓存 `playable.json` 保存进程和制品指纹。

Parallax 截图中 `已读跳过` 曾被误判为只显示一个字；后续 ROI 像素分析确认三张截图的四个字形 mask 完全相同。该结果排除这次疑似缺字，不替代其它界面的截断与可操作性验收，详见[视差像素验收](LANTERN_PARALLAX_FLUTTER.md)。

## 内容级验证

`demo/js/apps/lantern/story.test.ts` 通过 Pocket VN engine 实际执行剧情，覆盖谜题成功、一次失败后重试成功、连续失败后锁定、末班车/留站结局、超时默认路线、结局/CG 元数据和故事存档恢复。测试同时从 canonical JSON 导入，以发现故事文件与 TS 类型入口之间的漂移。共享能力的底层边界（比如 malformed save 校验和偏好 API）由 `sdk/packages/pocket_vn/test/` 的 core tests 验证；游戏 UI 是否把这些能力显示为玩家可操作入口由 Demo 集成验收。

内容级命令：

```sh
cd demo/js/apps/lantern
bun test story.test.ts
```

此验证证明引擎能按玩家选择改变变量、可见选项、剧情位置和结束元数据；它不单独证明每个逻辑键都有已加载图片，也不替代真实宿主音频输出或编译后 native Guest 的端到端验收。

## 真实集成与验收入口

- `demo/js/tests/novel_native.test.ts` 使用固定工具编译出的 QJBC/PAK 和真实 native Guest，经过指针输入到达三结局，并验证存读、回溯、已读跳过、舞台变化和音频请求；请求本身不证明声音输出。
- `novel_keyboard_native.test.ts` 与 `novel_viewport_native.test.ts` 验证键盘确认/选择/返回、触控和视口；`spine_native.test.ts` 验证官方 Spine 执行与真实网格变化。
- `demo/integration_test/novel_platform_test.dart` 由实际 SystemHost 启动游戏，验证解码纹理像素、模型变形、存读与生命周期。原始 Spine 游戏已经在 macOS、iOS 和 Android 模拟器验收；新增逐句配音/重听/完成等待的最终组合运行结果记在 [平台验收](VISUAL_NOVEL_PLATFORMS.md) 与 [逐句配音](VISUAL_NOVEL_VOICE.md)。Windows 仍待实际系统运行。
- 唯一 `novel.locales.json` 当前覆盖 77 行英文、16 个选择、三个结局以及五个回放标题。语言切换保留剧情位置/偏好，存档统一为原始文本，读取时再映射当前语言。新 guest 的 Continue 恢复流程由 `novel_voice_locale_native.test.ts` 验证，不能据此声称 OS 磁盘重启验收。
- 真实播放器 WAV 传输/完成测试是 `demo/integration_test/novel_audio_test.dart`，示例配音的原创文本及固定离线合成工具来源见 Demo `ASSETS.md`。

这里记录已实现的小游戏能力；市场对标的其余编辑、演出和发行能力仍保留在 [完整差距表](VISUAL_NOVEL_LETSGAL_PARITY.md)，不把现有测试外推为全部功能已经齐备。
