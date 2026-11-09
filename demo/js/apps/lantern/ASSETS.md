# 《雾港末班信》美术与声音来源

主线游戏的场景、Mira/Ren 人物与 CG 均为本任务通过内置 Image Gen 新生成的原创素材；没有复制对标引擎、商业游戏或画师作品。独立“立绘试映”另使用 Live2D 官方 Hiyori 样例，不属于本作原创素材；来源、准备命令与许可边界见 [LIVE2D_SAMPLE.md](LIVE2D_SAMPLE.md)。生成结果不是手绘作者署名，也不承诺后续再生成会逐像素相同。原始图保留于 `art/masters/`，运行图位于 `art/`。剧情和美术均围绕成年角色 Mira（24 岁邮递员）与 Ren（28 岁灯塔维修员）。

## 生成配方与输出

以下为归档的生成要求摘要，可用于后续再生成；不是逐字工具调用日志。整体采用精细手绘视觉小说插画：雾港、旧式沿海铁路与灯塔，冷青蓝风雨和暖琥珀灯光，适合竖屏手机，画面不含文字、界面、水印或现有 IP。场景保留下方对白区的空间。

生成会话目录标识：`01a1b110-c27f-7ca2-8fca-9fda16ae1a72`。表内文件是工具保留原始结果的 basename，项目中的 master 是其完整副本。

| 项目文件 | 模式和画面要求 | 原始生成文件 |
| --- | --- | --- |
| station.png | 新图，不透明；午夜暴风雨灯塔站控制室，玻璃窗、老收音机、信封、琥珀台灯，无人 | exec-cd6493f6-22dc-4d9b-b880-7c1cf3ea93e1.png |
| archive.png | 新图，不透明；潮湿档案室、信箱、钟表机构、潮汐图，与站内同一照明 | exec-bb2b3e6f-beb9-4bfd-b561-592bb848bca1.png |
| roof.png | 新图，不透明；灯塔屋顶栈道、风雨港湾、黄铜信号灯、栏杆纸张 | exec-dc1a9a4c-627a-4055-82a9-65ca0d07abda.png |
| dawn.png | 新图，不透明；风雨后日出的旧站台，绿色列车、雾港、长椅上的信封，无人 | exec-bda073e0-c064-4650-a2d9-74b3dfaaf939.png |
| mira-neutral.png | 新图，透明；成年中国女性，青色外套、酒红围巾、皮挎包与信封，膝部以上全身立绘 | exec-785d6ef8-677e-435c-beeb-7edd1ca14db4.png |
| ren-neutral.png | 新图，透明；成年中国男性、眼镜、工作衬衫、橄榄绿背心、工具与黄铜提灯，膝部以上立绘 | exec-0ed60b0a-1b40-4a54-9933-a79ab9bf4856.png |
| mira-worried.png | 编辑 neutral 原图，透明；只改为担忧神情，保留身份、姿态、构图、服装、光线 | exec-62055f06-e8b7-4863-9c7a-4a988b95deb2.png |
| mira-hopeful.png | 编辑 neutral 原图，透明；只改为释然和希望的神情，其余保持 | exec-f9ae9142-31b3-4190-b9ea-1bf7256d0721.png |
| ren-worried.png | 编辑 neutral 原图，透明；只改为担忧神情，其余保持 | exec-30db6d81-b80b-4128-bd56-c3bcb7df192c.png |
| ren-hopeful.png | 编辑 neutral 原图，透明；只改为释然和希望的神情，其余保持 | exec-9e12e6f3-0ae2-4c43-8da9-82f0692cd44a.png |
| truth-letter.png | 以两人 neutral 图作身份参考的新图，不透明横图；Mira 在暖光控制室打开跨越二十年的旧信，Ren 释然，窗外仍有风雨 | exec-a9f1e65c-4afe-42b3-a8a0-45fbf6ecb42b.png |
| dawn-departure.png | 两人身份参考的新横图；Mira 登上绿色列车回望，Ren 在湿润的日出站台挥别，苦甜而平静 | exec-1ca21f4b-e3de-479e-bfac-42abdc2bee8e.png |
| harbor-light.png | 两人身份参考的新横图；风雨后并肩守在灯塔栏杆前，灯光与初晴港湾，温暖希望 | exec-23322fb0-7759-4f10-8512-45555d3b1359.png |

背景和立绘原图 1024×1536，CG 原图 1536×1024。透明立绘已检查实际 alpha，且通过 native Guest 画面验收，未以不透明方框替代透明背景。

## 固定编译器纹理约束

本轮编译器/Core 的静态 PAK IMG 上限已扩到 2048（仍须为 2 次幂）；通用纹理、sprite 和 tile 上传保持 512。原创场景/UI 目前仍采用 512 运行图，Hiyori 样例另保留原始 2048 贴图，不能把运行图准备策略当作所有图片的硬上限。`bun run prepare:art` 使用 macOS 自带 `sips -z 512 512` 从每张 master 生成运行纹理；不覆盖 master。纹理占满 UV，运行舞台/CG 的绘制宽高恢复其显示比例。`images.json` 只开启线性采样，保持 RGBA8888；512 纹理已经降低了总资源量，因此移除了原先考虑的 RGBA4444 量化，避免对透明边缘再次损失精度。

2026-11-07 最终整合构建含 21 个图片资源、13 个字体槽和 1 个 styles，共 35 个 PAK 条目；PAK 为 58,463,472 字节，SHA-256 `9fcc419358ed70f2a83ca4ef2f8808a8d1c795ff6fb2b8165e438907a2d1a1d1`。对应 QJBC 为 988,548 字节，SHA-256 `748913c419272953f049637630705f5d12c61ac07f8f6877372395faa1ae07fc`。相比此前 512 Hiyori checkpoint，PAK 增加 31,457,280 字节；高清新增的内存/启动代价仍需实测，不是无成本提升。这些是当前整合制品，不是源文件。三张共享 UI 图片合计约 3.15 MB 原始 RGBA 负载；图标共用一张 4×4 图集，旧 ornate frame 已移出运行登记。生成器输出、应用源码和资源映射是可审核输入；QJBC/PAK 是构建产物。`novel.assets.json` 是 Editor 与 Guest 共同读取的唯一映射，构建不会重新生成剧情或覆写作者编辑。

## 天气与场景互动图像

运行资源 `art/fx/sea-mist.png` 与 `art/fx/rain-streak.svg` 为雾层和雨滴纹理；GPT Image 原图、运行烘焙哈希及受限 SVG 形状来源记录在 [`art/fx/PROVENANCE.md`](art/fx/PROVENANCE.md)。雾只是一张有透明度的可移动图层，雨由 JS 有界仿真写入一个保留网格；它们不是逐雨滴 Flutter 控件。`art/ui/relay-dial.png` 是原创中继信号拨盘素材，master/runtime 哈希和生成提示见 [`art/ui/RELAY_DIAL.md`](art/ui/RELAY_DIAL.md)；图片不含数字或选项字样，运行时标签仍来自本地化故事文本。

`novel.assets.json.choiceSurfaces` 可把已有 choice 的 option ID 绑定到舞台归一化热点，也可为图片拨盘配置一组触控区域。这只驱动现有剧情选项，不会把画面对象变成自由状态、拖动或碰撞系统。画布/拨盘图片沿用普通图片收集和同一 512 纹理烘焙路径；目标不足 44px 或本地化标签放不下时，玩家仍会看到常规可滚动选项列表。Editor 和 NativeSession 实际点选证据见 [`VISUAL_NOVEL_CHOICE_SURFACES.md`](../../../../sdk/docs/VISUAL_NOVEL_CHOICE_SURFACES.md)。

效果图、精修边框、主按钮和图集的完整 GPT Image 提示词、master/runtime 哈希与烘焙步骤见 [REFINEMENT.md](art/ui/REFINEMENT.md)。效果图是实现参考；游戏仍以独立文本、图片皮肤和真实控件运行。

## 原创音频与字体

`bun run prepare:audio` 执行 `scripts/generate_audio.ts`，使用固定种子噪声和正弦合成生成 PCM16、22050Hz WAV，无采样第三方录音。三个配乐各 24 秒，环境风声 8 秒；其余是站钟、中继开关/故障、列车离站音效。新增的 `text_narrator`、`text_mira`、`text_ren` 是约 45ms 的低音量正弦/三角合成提示音，由 JS 按真实可见的文字进度选择并限速播放；它们不是配音或 TTS。

`bun run prepare:voice` 为 Mira 的 `arrival_02` 原创对白生成中文和英文示例配音（13.60 / 12.37 秒）。它使用固定 eSpeak NG 1.52.0 源码及 SHA-256，由离线 CMake 工具生成普通 PCM16 单声道 WAV；运行时没有 TTS 依赖。这是可听懂的合成人声示例，不是演员录音，也未克隆任何人的声音。生成脚本直接读取 `story.json` 和唯一的 `novel.locales.json`，不维护另一份台词。eSpeak 是构建工具，其源码和构建缓存受 GPL-3.0-or-later 许可且被忽略，不打包进游戏。工具版本与源校验见 `scripts/generate_voice.ts`；输出波形来自本项目原创文本。

界面精修后的主字体与 Flutter 绘制字体均为 Noto Serif CJK SC，使标题与正文贴近效果图中的书信排印风格。`scripts/prepare_font.ts` 固定上游 revision `f8d157532fbfaeda587e826d4cd5b21a49186f7c` 和原字体 SHA-256 `2a2eae2628df83556c54018c41e20fa532c1b862c5256ae8b3f23feb918d12ca`，并用固定 `fonttools==4.60.1` 子集化；[上游 SIL OFL 许可](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Serif/LICENSE) 的完整副本附于 `fonts/LICENSE-NotoSerifCJK.txt`。运行 `bun run prepare:font`，再走同一 `buildGuest`；`pocket.json.fonts` 将同一文件交给 pinned compiler 的 regular/bold 主字面，Flutter 注册 `LanternSerif` 并通过已有 fallback 链绘制，避免英文测量和绘制字体不同造成裁切。JSON 台词和 CG 标题通过 `fonts.json` 声明进入字形收集。之前的 Sans 许可保留用于历史来源说明。

## Original Spine rig

`models/mira.spine.json` and `models/mira.atlas` are original Pocket authoring
sources over the existing Mira textures. They use a weighted 3×5 mesh, root,
torso and head bones, three expression skins, and idle/alert/settle motions.
No third-party model or Spine Editor application binary is bundled. Parsing,
pose calculation and mixing use the pinned official Spine runtime 4.3.13;
its license and integration conditions are recorded in
`sdk/docs/VISUAL_NOVEL_SPINE.md`. Model support does not grant a Spine license.

## 原创视频演出

`assets/videos/archive-route-reel.mp4` 是从本项目原创生成的
`art/archive.png` 制作的无声移动画面：镜头在 3 秒内缓慢推近档案室邮路图。
它不是实拍、第三方影片或测试色条；没有添加路线标记、台词或音轨，运行时
继续使用既有静音视频播放器。可复现的 FFmpeg 8.1.1 命令、实际编码参数和
SHA-256 记录于 [`assets/videos/PROVENANCE.md`](assets/videos/PROVENANCE.md)。
影片只为档案室支线营造一次旧胶片回放；剧情仍由玩家核对纸面七号线，影片
不会提交 `found_route` 或自动推进故事。原画生成来源见上表；没有引入第三方
素材许可或额外音源。
