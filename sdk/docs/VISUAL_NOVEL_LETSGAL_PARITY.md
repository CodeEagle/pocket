# LetsGal Studio 对标与 Pocket VN 验收差距

当前执行目标与量化门槛见 [Goal 验收约定](VISUAL_NOVEL_GOAL.md)。本表 54 组及内部子项继续作为完整功能范围。

核对日期：2026-11-07。对标现行官方手册 v2.5.0，而不是把宣传片或第三方逆向项目当功能证明。官方入口：[完整目录](https://docs.avg-engine.com/llms.txt)、[当前版本功能](https://docs.avg-engine.com/updates/2-5-0)、[运行时与编辑器概览](https://docs.avg-engine.com/manual/start/what-is)。这是持续验收清单；“源码已写”“Pocket 底层有组件”均不等于 VN 功能已完成。

用户要求覆盖市面引擎优点并可在 Editor 编辑。因此下列差距属于目标范围，不能为了宣布完成而从清单删除。只有实际编辑、保存、构建、执行与玩家输入均验证通过，才能改成已验收。外部服务或平台能力需要实际可用接入和对应目标环境验证。

对标依据按领域细分：[剧情指令](https://docs.avg-engine.com/manual/writing/blocks-overview)、[可视化 UI](https://docs.avg-engine.com/advanced/visual-ui-editor)、[动态模型](https://docs.avg-engine.com/manual/creating/dynamic-visuals)、[配音与拟声](https://docs.avg-engine.com/manual/writing/voice-management)、[本地化](https://docs.avg-engine.com/manual/writing/localization)、[协作](https://docs.avg-engine.com/manual/overview/collaboration)、[构建发行](https://docs.avg-engine.com/manual/overview/build)。官方的“拟声”是伴随文字的合成短音，不是可听懂的人声 TTS；两者不能混称。

## 当前阶段与完成门槛

当前在建设单一 JS runtime、`story.json`、`novel.assets.json` 和 Pocket 播放界面。基础剧情、完整原创小游戏、Spine 和结构化 Editor 已有真实执行证据，尚未证明 LetsGal 等价。编辑器、试玩及发行版都必须消费同一文档、同一核心，使用 pinned `buildGuest`；不复制对标产品的引擎实现或专有资源，不另起一套剧情解释器；官方模型 SDK 依授权固定来源复用。

| 编号 | 能力目标 | 当前证据 / 缺口 | 升级为已验收所需结果 |
| --- | --- | --- | --- |
| F01 | 对白、旁白、稳定行 ID、逐字显示 | 核心和播放器已接通；真实 QJBC 输入通过显全、继续与中文剧情路径 | Native 输入分别显全和推进，长中文无越界 |
| F02 | 选择、条件、变量、限时抉择 | 原生 QJBC 已通过三结局、714 谜题、限时选择与暂停计时 | 实际走不同路线，超时及暂停语义正确 |
| F03 | 标签、调用片段、返回、受控循环 | 核心 call/return、错误目标和执行步数上限已有回归；复用同一解释器 | 多层 call/return、错误目标、无限循环保护通过 |
| F04 | 多种变量保留范围 | save/session/persistent 声明、新游戏重置与旧档迁移已过核心回归和严格类型检查；Editor 声明/default JSON 编辑、撤销、保存重开及同核心执行已过 Chromium 验收；持久值不被旧档覆盖，会话值跨新游戏保留并随读档/回退还原；完整 Guest 已验新游戏清零剧情变量、保留已读并停止/重启同一 BGM | 已有核心、Editor 与真实 Guest 证据，持续保留旧档兼容回归 |
| F05 | 自动播放、已读跳过、语音等待 | 自动、已读跳过和 token 关联的配音等待已过真实 QJBC 输入回归；完整游戏的真实解码/完成/自动推进链路已过 macOS、iOS/Android 模拟器验收 | 遇未读和选择停止，配音完成事实控制 auto |
| F06 | 存读档、自动/快速档、缩略图与整理 | 三个手动 slot、自动档及 JS 存读回归已过；macOS、iOS/Android 模拟器已验真实系统文件落盘→销毁宿主→新宿主继续。macOS 玩家槽位 UI 已实测；Android 当前图片皮肤版本的整理由 `demo/integration_test/novel_slot_management_test.dart` 真机桥接集成测试通过：真实 OS copy/move/swap/delete、quick slot、fresh-host load 均通过 pointer/IME；driver 等待绘制 alpha 102→255 的可点状态，未改生产代码。缩略图仍缺失。 | 保持真实系统文件与跨宿主恢复；补存档缩略图 |
| F07 | 回滚、日志及持久解锁 | 原生剧情输入已通过存读档、回滚和已读跳过；持久 meta 核心有回归 | 跨读档回滚还原变量/舞台/音频意图，解锁不倒退 |
| F08 | CG、音乐、剧情回放鉴赏 | 音乐解锁、声明式回放入口与隔离同核心 replay 已过核心、Editor Chromium 和实际 QJBC 输入回归，回放进出不修改主线自动档。macOS、iOS/Android 模拟器已验实际音乐试听、主线 BGM 原位暂停、后台暂停/前台恢复、停止试听后原 BGM 继续前进且只留一个声道 | 保持主线进度隔离；Windows 与物理设备仍待验 |
| E01 | 结构化剧本编辑 | 真实浏览器编辑、保存、重开、buildGuest 和 Native Guest 执行已通过 | 新增、编辑、复制、删除、重排后重新打开一致 |
| E02 | 叙事地图、章节蓝图、可视化连线 | 同文档起点及 jump/call/branch/choice/timeout 连接可编辑，撤销/保存/重开/buildGuest/原生指针新路线已过；自由label节点拖动/SVG连线、定位与布局保存重开及实际Guest输入已过，见[画布验收](VISUAL_NOVEL_GRAPH_CANVAS.md)；六类可执行章节蓝图的创建/历史/保存重开→Guest真实双分支及元数据消融已过，见[章节蓝图](VISUAL_NOVEL_CHAPTER_BLUEPRINT.md) | 代码表达式、扩展策略、章节预处理、折叠分组仍缺；条件/选项创建仍用JSON schema |
| E03 | 文本与 Block 双向编辑 | Pocket VN 文本格式与同一 Block 文档无损往返；真实 Chromium 已验草稿保留/冲突、导入导出、撤销、保存重开；文本编辑后 pinned buildGuest 与原生指针新对白已过 | 双向转换保留所有语义和稳定 ID |
| E04 | 实时舞台预览、继承前文与来源定位 | 同核心预览；story.start上下文重建、真实选择/输入继续、当前对白/结局及提交后的背景/层/角色配置来源定位已过浏览器与pinned Guest验收；循环断点及预览camera/timeline时钟修复。见[证据与限制](VISUAL_NOVEL_CONTEXT_PREVIEW.md) | 主线/声明回放/有效章节独立入口见[专项验收](VISUAL_NOVEL_CONTEXT_ENTRY.md)；完整动画/音频/native模型状态来源仍缺，保持部分验收 |
| E05 | 暂停、单步、断点、变量/日志/OP 时间轴 | 已接通同一preview engine的实际提交OP记录，最近200条、清空和可验证源码定位；嵌套call/return、断点、step及重入顺序通过SDK与真实Chromium回归，默认游戏不收集trace | 使用实际执行状态，断点前停止，无第二状态机；见[执行记录](VISUAL_NOVEL_DEBUG_TRACE.md) |
| E06 | 人物、资源、变量与条件检查器 | 背景/角色/音频/CG/模型 registry 可编辑；Spine 读取与纹理映射 CRUD 已过浏览器测试 | 不改程序即可编辑，缺引用有可定位诊断 |
| E07 | 场景/角色坐标、层级与所见即所得编排 | 静态角色编辑闭环已通过真实 Chromium 和 Guest。另一个隔离项目真实预览官方 Spine mesh，编辑动作/skin、位置、scale、layer 后保存重开；pinned buildGuest 与真实 NativeSession 输入确认动画三角形、几何坐标、两种场景绘制顺序及隐藏移除。Live2D 浏览器舞台预览仍不支持，因此 E07.3 仅部分验收 | 若该项要求覆盖 Live2D，接入可用原生模型 host 后验证编辑器变换和 Guest 几何；见[Spine stage preview](VISUAL_NOVEL_STAGE_SPINE_PREVIEW.md) |
| E08 | 撤销重做、项目历史、自动快照 | 32 步撤销重做、输入分组及同一栈/当前草稿的 workspace 持久化已过真实 Chromium；服务重启、未保存撤销结果/重做、无法解析的文本草稿恢复均通过。已验剧本保存成功而资源保存失败时，重开恢复剩余草稿并继续保存。源码哈希/备份恢复代数拒绝过期历史，版本比较拒绝旧窗口覆盖；项目完整备份另有演练 | JSON 文档与文本草稿恢复已验；二进制素材版本沿用完整备份，通用 UI 文档历史随 UI 编辑能力补齐 |
| E09 | 定期完整备份与恢复 | 项目外独立目录保存源码/字体/音频/模型等资产，SHA-256 校验、损坏拒绝、恢复前恢复点、最多 20 份与内容去重已有服务回归；真实 Chromium 已验源码/二进制恢复、新文件移除、revision 更新、服务重启后一分钟自动备份 | 本地定期备份链路已验；云端/外部存储目标仍未接入 |
| E10 | Git 工作流、冲突处理、多人实时协作 | 仓库有 Git，不等于产品功能；VN 工作流缺失 | 真实多客户端同步，冲突不会静默丢失编辑 |
| S01 | 背景、角色、表情、位置与尺寸 | 原生完整剧情已通过角色表情和场景切换，保存/回滚使用同一舞台状态 | 实际切换表情和角色，保存恢复一致 |
| S02 | 多层场景、视差、对象裁剪与蒙层 | 多层视差已有验收；独立物件支持矩形源裁剪、宽高比、图层和可选对白交互，与choice热点分别使用原有引擎事务。Editor编辑/拖动/撤销/保存重开及pinned Guest实际输入、Lantern窄屏/宽屏Native与macOS Profile图片/点击/存档隔离已过；见[专项验收](VISUAL_NOVEL_SCENE_OBJECTS.md) | 任意路径/alpha蒙层、alpha命中与目标平台物件验收仍缺，保持部分验收 |
| S03 | 镜头平移、缩放、震屏、滤镜、景深 | scene camera 的平移/缩放/确定性震屏接入同一 engine tick、存档和回滚；Editor 表单、保存重开与撤销通过 15 项针对性回归。独立真实 QJBC 验证背景裁切、角色几何、HUD 固定及 reduceMotion 目标取景（23 项断言）。macOS Flutter 全 UI/镜头/天气观感验收通过于 checkpoint QJBC `d34b5c…` / PAK `fa0a8…`（截图 `sdk/.pocket-build/novel-ui-camera-weather-20261107`）；它早于拨盘与 V3 存档的最终制品 `cb698f14…`，不代表最终包的逐项 A/B。滤镜、景深仍缺失 | 补滤镜/景深；目标平台与最终制品逐项验收 |
| S04 | 多轨关键帧时间线、缓动、复用预设 | camera/actor/audio cue/gain共用一个时钟；Editor标记拖拽/键盘、保存重开→pinned Guest；reduceMotion只读终点投影保持存档、音效和真实空间选项命中；内部声道边界已收紧。Android emulator Profile已通过时间线7/reduceMotion4检查点，原生position采样回退保留诊断；采样级同步、整游戏性能、真机及iOS/Windows仍待验，见[拖拽/减少动态效果](VISUAL_NOVEL_TIMELINE_ACCESSIBILITY.md) | 完成最终包跨平台与整游戏性能验收 |
| S05 | 淡化、溶解、揭示及风格化转场 | fade/dissolve 与四向 reveal 已接通 SDK/Editor；reveal 的真实 Native clip/UV、pause/skip/save-load/rollback、cut 消融及 macOS Profile 截图通过；其它风格化效果和跨平台最终包仍缺，见[方向转场](VISUAL_NOVEL_REVEAL.md) | 前后场景正确混合，中断/快进/读档均一致 |
| S06 | 粒子天气与氛围 | JS 雨滴单网格、共享雾纹理及低亮度闪电复用现有模型驱动，无新定时器。纯测试 2 项、临时 QJBC/NativeSession 73 项断言通过；Editor 与资源测试 16 项通过，覆盖撤销/重开/改名和 PNG/SVG 入 PAK。macOS Flutter UI/天气观感在较早 checkpoint `d34b5c…` / `fa0a8…` 通过；13 窗口 Native 性能采样记于 [性能报告](VISUAL_NOVEL_PERFORMANCE.md)，其制品 `ce1f8dc2…` 早于最终拨盘/V3 包。最终整合制品 QJBC `cb698f14…` / PAK `3ead2ebe…` 含天气资源，但没有该最终制品的独立天气 A/B 或物理设备验收 | 在目标平台检查最终制品的图层观感、暂停和资源释放；天气仍无物理碰撞、音频及通用粒子编辑器 |
| S07 | 网格角色动画、部位与差分继承 | 官方 Spine 加权网格真实变形已过 QuickJS 输入测试；通用部位编辑/继承缺失 | 实际变形/关键帧，不用静态图片冒充 |
| S08 | 皮肤、差分、PSD 导入、立绘预制包 | Spine skin 切换保持动作相位已回归；PSD 和立绘预制包缺失 | 部位组合、导入导出、分辨率变化下位置一致 |
| S09 | Spine、Live2D、序列帧动态立绘 | Spine 真实模型动态帧与 Editor 资源页预览通过；新增 Spine 舞台预览复用同一官方 factory/projector，并以 NativeSession 核验保存后的 Guest 几何、动画与层序。Live2D 官方 Hiyori 已过 macOS/iOS/Android 应用默认 FFI、QJBC、纹理/遮罩/变形、physics/pose、暂停恢复与释放验收；Lantern 已加入独立「立绘试映」：扉页直接进入，也可从鉴赏回看；可选择原创 Mira Spine 的 idle/alert/settle，以及明确标注来源的官方 Hiyori Live2D Idle:0/Idle:1/TapBody:0。普通 Demo 已注册默认原生 Live2D 插件；最终 QJBC `f4b9e519…` / PAK `0dafa7fa…` 的 macOS、iOS 27.2 arm64 模拟器与 Android API 35 arm64 模拟器完整 Demo 默认 FFI 交互均通过（45 / 45 / 48 秒），含双纹理/遮罩/动作、宿主暂停恢复、目录和退出释放及主线自动档不变；这些是最终完整包的独立交互证据；物理设备与 Windows 仍待验；完整 Cubism 兼容、Live2D 浏览器舞台预览及序列帧仍缺失 | 保留[Spine stage preview](VISUAL_NOVEL_STAGE_SPINE_PREVIEW.md)现有覆盖；物理设备与 Windows、完整 Cubism、Live2D 编辑器预览和序列帧仍待做 |
| S10 | 视频叠加与控制 | 最终 Guest QJBC `cb698f14eac2239213c3670565aa64e7242557a973194e5dbb047780405c1042` / PAK `3ead2ebe1661858f7b790e0d9ed932d907ea0246da6bce7e2d673fac8e6ca1a2`（24,793,712 bytes）在真实 macOS Flutter 集成通过：3 秒真实影片解码、静音、暂停/seek、磁盘 quick save 位置恢复、回滚释放、自然完播不自动推进、关闭、714 图片机关、truth ending 自动档及鉴赏回放不污染主线档。最终日志 `/tmp/pocket-novel-spatial-flutter-final-ending.log`（01:48，2 项通过）。iOS/Android、Windows 与物理设备的最终制品视频验收仍未完成 | 保持该 macOS 最终制品证据；分别验收 iOS、Android、Windows 与物理设备 |
| S11 | 场景热点与图片拨盘 | 可选 `choiceSurfaces` 将 scene 归一化矩形或图片拨盘区域映射到现有 choice option ID；同一 `selectChoice`、焦点、触屏/键盘目标及正常存档/回滚，不增剧情状态。Editor 浏览器实际保存/撤销/重开/buildGuest 通过；临时 QJBC/NativeSession 真实 NovelView 指针回归 1 项/15 断言，覆盖 scene、dial、摄像机变换、HUD 和小屏/英文长选项回退。仅服务于已存在的剧情选项，非自由场景点击事件/碰撞系统；小于44px或标签溢出时回到可滚动选项列表。没有独立 Flutter 绘制验收 | 在目标平台验收图片解码、焦点和触屏；保持无映射/窄屏时的列表回退 |
| T01 | 富文本、注音、局部停顿、链接 | 单正文范围schema、Core同源排版/命中、JS停顿/内部注记、V4历史保存与locale、Editor编辑及真实Guest/Flutter闭环已部分验收；普通Demo“信纸上的第二层海”可试玩 | 译文范围编辑、重叠/复杂排版与跨平台最终包仍开放；见[富文本验收](VISUAL_NOVEL_RICH_TEXT.md) |
| T02 | 全屏段落、浮动文字、样式切换 | 已验收三种预设：Editor编辑/undo/redo/保存重开→pinned Guest；中英文窄/宽屏Profile与存档隔离通过 | 无需改运行时代码；不含自由浮动坐标/自定义段落主题，见[样式](VISUAL_NOVEL_SAY_PRESENTATION.md)与[Flutter](LANTERN_LETTER_SHOWCASE_FLUTTER.md) |
| A01 | BGM/SFX/环境/语音、分组音量 | 总音量×音乐/音效/语音分组已接通，环境和自定义声道归音效；adapter 回归、完整 QJBC 设置/持久恢复已过；macOS 与 iOS/Android 模拟器实际播放器已验增益 0.75、位置连续和单声道未重启；Editor 单句配音绑定/玩家重听已接通 | 分组链路已有实际证据；Windows 和真机音频仍待验 |
| A02 | Loop、淡入淡出、跨曲衔接、保持进度调音量 | loop/volume、调音量不重播已验；显式音乐分组与可编辑跨曲曲线已接入，macOS/Android模拟器Profile、iOS模拟器Debug真实WAV交叠/释放/主线恢复通过，仍部分验收，见[跨曲记录](VISUAL_NOVEL_CROSSFADE.md) | 实际播放器/曲线/释放及各平台证据；原生position采样不等于连续或采样级同步 |
| A03 | 单句配音、全章管理、录音识别匹配 | 稳定行 ID 的可选 voice cue、Editor 选择/清空、重听和完成等待已过回归；全章管理、录音/识别匹配缺失 | 行 ID 与 voice 资产准确对应，批处理可回退 |
| A04 | 逐字拟声、角色音色、波形与触发密度 | JS adapter 与角色短音配置已接通；Editor 配置/undo/保存重开、坏引用/间隔拒绝及真实 QJBC 按角色请求音频已过。确定性 45 ms 合成 WAV 沿用原音频边界；macOS、iOS/Android 模拟器已验实际 44 ms 解码、同声道播完再次回到起点并前进、关闭及生命周期。旧版重复短音不重播的实测失败已由显式 restart/seek 修复，背压取消有回归 | 保持真实播放与有界触发；Windows 和物理设备仍待验 |
| U01 | 默认游戏壳、菜单、设置、工具栏 | 默认壳、菜单、三个存档位、设置、日志和 CG 已接通；原生键盘/触控剧情及选择通过；共享 `assets.skin.frame` 的图片皮肤登记、自然尺寸预览、约束校验、保存/buildGuest 资源打包已验；iPad 模拟器确认实际解码绘制 skin texture。无皮肤旧项目仍保留旧外观。手柄硬件未验 | 保持真实玩家输入与菜单可用；手柄和物理设备仍待验 |
| U02 | 可视化 UI 编辑、控件与数据绑定 | U01 的单张共享图片皮肤元数据/资产表单不等于 UI 设计器；VN 控件树、自由布局、绑定和任意玩家 UI 视觉编辑工作流仍缺 | 作者可视化组合控件、布局与数据绑定，并在实际游戏中一致运行 |
| U03 | UI 分层入退场、等待指示与主题 | 只有固定 UI 初版 | 主题/动画可配置并对存读档/overlay 正确 |
| U04 | 玩家文本/数字/布尔输入、系统确认消息 | 通用 input 指令、Editor 配置/取消边/翻译、typed submit、draft 存读档/回滚已过真实 Chromium→buildGuest→native 与完整游戏输入验收；中文/emoji composing、IME Done 不隐式提交、数值校验和布尔确认已过 macOS、iOS/Android 模拟器 Flutter TextInputClient。独立系统确认消息仍缺失，物理 IME/Windows 输入仍待验 | 保持输入完整链路；补系统确认消息及目标设备验证 |
| L01 | 文本/人物/UI/图片/语音多语言 | 旧基线的 67 行英文目录、玩家 UI 文案和语言切换已实现；当前 v3 扩写已补齐英文目录并通过故事/语言 22 项测试，新增对白的最终英文 Flutter 全路线尚待复验；输入 prompt/placeholder、稳定 ID、规范存档换语种及英文配音/三结局等价路线已有回归。真实 Flutter Guest 在同一会话的 390px 手机宽度约束下绘制英文标题、对白、菜单、设置和画廊；长英文对白排版专项已验。该验收是 macOS Flutter 内的手机尺寸约束，不代表物理手机或 OS 旋转；独立本地化图片实图仍待验收 | 保持切 locale/fallback/缺译诊断；另验物理设备和独立本地化图片 |
| L02 | 翻译导出导入、校对、AI 翻译 | 唯一 novel.locales.json、Editor 稳定字段编辑、缺译/占位符校对、当前/全集合导出和验证导入已有真实浏览器验收；AI 翻译缺失 | 稳定 ID 往返，不丢条件/选项/格式 |
| I01 | Excel、Word、文字 PDF、文本导入 | 普通 UTF-8 手稿逐行导入、说话人/源行预览、取消/同名拒绝、草稿持久化与 undo/redo、保存重开并经 pinned buildGuest→native 输入观察导入文本已验；Excel、Word、文字 PDF 仍缺失 | 保持文本闭环；补真实办公/PDF文件解析和字段映射，见[手稿导入](VISUAL_NOVEL_MANUSCRIPT.md) |
| I02 | 文本、CSV、JSON、Ren'Py、Markdown、Word 导出 | JSON、无损 Pocket VN 文本及结构化 CSV/Markdown 往返已接通；真实浏览器导出、编辑 payload、导入、损坏拒绝、保存重开并经 pinned buildGuest→原生指针验了改文。CSV v1 payload 与Markdown保持结构化无损格式；新增CSV v2直接编辑ID/说话人/正文/目标/资源列，保留缺失/空值/嵌套参数并通过浏览器导出→修改→导入→撤销重做→保存重开→真实Guest执行；对白表格已补筛选/分页、角色/正文列编辑、撤销/保存重开及同源Guest输入；稳定ID只读保留locale关联。Word DOCX脚本审阅稿已接入未保存草稿只读导出，系统读取/113页全文与分页/真实浏览器闭环已验；Ren'Py仍缺失，Word导入未实现 | 保持结构化往返不丢语义；补通用指令列和Ren'Py，Word详见[验收](VISUAL_NOVEL_WORD_EXPORT.md) |
| D01 | 项目数据集合、道具、商店、辞典、人物档案 | 共享档案与 story.inventory 已接入 SDK、Editor 和图片皮肤 Guest。真实 native 买入/退回/使用、资金/库存/上限拒绝、旧档/回退/新局及回放不改主auto通过；Editor同项目保存重开/历史→buildGuest→native闭环通过。当前v6未完成普通Flutter窗口及宿主磁盘/其它目标验收 | 保留[库存与交易证据](VISUAL_NOVEL_INVENTORY.md)及[档案证据](VISUAL_NOVEL_COLLECTIONS.md)，补当前制品宿主与平台验收 |
| X01 | 有类型的扩展方法、设置、存档、Hook/Slot | 只有核心 API；公开扩展系统缺失 | 示例扩展真实运行，生命周期和存档版本受控 |
| X02 | 动态检查器、扩展 UI、资源与隔离 | 缺失 | 编辑器与运行时插件使用同一声明，失败可定位 |
| X03 | MCP、AI 工程编辑 | Pocket Studio 有 Codex；VN tools 未接 | Agent 可读写/校验同一故事，支持差异审阅 |
| X04 | 扩展工坊、资源库、素材引用和未使用分析 | 缺失 | 实际安装/更新/移除/归属，构建只含所需资源 |
| P01 | 可复现构建、缺资源定位、真实目标执行 | 同 pinned buildGuest 已构建完整游戏，真实 QuickJS 输入完成三结局；Editor 修改后重建执行已通过 | 完整游戏 native 运行、源位置诊断和制品一致 |
| P02 | Windows/macOS/Web/移动端目标打包 | macOS 完整 GUI 游戏、键盘、像素、存读档、动画和音乐 lifecycle 通过；iOS/Android 完整模拟器游戏及音乐恢复断言通过；Windows runner/DLL/CI 检查已实现，实际运行待验 | 每个目标真安装运行，不能继承对标产品承诺 |
| P03 | Steam 成就、统计、云档、DLC/浮层 | 缺失 | 使用真实平台 SDK，在允许的测试环境验证 |
| P04 | 云工程分享、协作分发、玩家/创作者统计 | 缺失 | 实际后端和数据操作，不返回固定成功 |
| P05 | 实机录制、片段管理、声画导出 | Pocket 有既有录制能力；VN 工作流未验收 | 从 VN 实机录制可播放文件，声音、生命周期正确 |
| P06 | 自适应、安全区、键盘/手柄、可访问性 | 最终 native Lantern QJBC 回归 6 例/5 文件通过；1920×1080 手札按钮中心 x=1372，打开/继续成功，完整坐标 sidecar 的 >1023 原生路径另有 pinned-QJBC 证据。macOS 原生 renderer 与 iPad 模拟器都验证了同一会话内布局约束变化；iPad 的 1032×1376/1032×340/390×1376 对话栏分别为 720/720/334，安全区、解码背景及图片 skin、菜单推进通过。Mac/iPad 测试改变的是宿主内 Flutter constraints，不是 OS 旋转或窗口拖拽；Windows、物理设备、手柄和无障碍未验 | 扩展到 Windows/物理设备、OS 级旋转与窗口变化、手柄和无障碍验收 |

## 已识别并消融的冗余

- 编辑器与游戏共用 `story.json`，`story.ts` 只作为类型化导出；不生成第二份剧情源。
- 美术与音频映射共用 `novel.assets.json`；构建包装器只把注册图片路径送入原资源 collector，不烘第二个 PAK，不用缺图占位。
- 回滚日志只保存一份有界序列，检查点使用游标，避免每个 checkpoint 序列化整份 backlog。
- 音频 adapter 只在意图改变时请求 native；每一帧的完整快照不会反复重启同一 BGM。
- 时钟使用 Pocket 的虚拟 deadline，手动阅读完成后无需常驻空轮询。
- 玩家输入只在 engine snapshot 保存一份草稿；复用原生 InputField/HostBridge。原生交互实测后移除挡住手札的局部 FocusScope，存档/回滚无需另起控制器。

这些消融仍需随功能扩展持续验证；不能以降低能力为代价简化需求。

2026-11-07 配音/本地化/地图补齐验收见 [逐句配音](VISUAL_NOVEL_VOICE.md)、[本地化](VISUAL_NOVEL_LOCALIZATION.md) 和 [Editor](VISUAL_NOVEL_EDITOR.md)。本轮没有删除仍缺失的市场能力条目。

## 当前普通 Demo 中的体验入口

Demo 首页向下到 Mini Apps → 雾港末班信 · Visual Novel → 开始。
独立底层测试不能替代这个游戏的内容展示；下表记录玩家实际入口。

| 内容 | 实际体验路线与限制 |
| --- | --- |
| 镜头、天气、Spine | 开场及后续调查场景；Mira 使用真实 Spine 模型。 |
| 立绘试映、Live2D | 扉页「立绘试映」或鉴赏「回看 · 立绘试映」，无需通关解锁。Mira 为原创 Spine；Hiyori 明确是官方样例，与主线角色区分。六个动作选择后进入无遮挡展示态，轻触返回动作菜单。试映使用隔离 replay，不另建引擎。 |
| 场景热点、图片拨盘 | 开场后的调查枢纽；查完档案、铃箱、屋顶三处线索后回中继盘。小屏或长文不适合热点时回退可读选项。 |
| 视频 | 调查 → 档案 → 放映静音胶片；可暂停、seek、重播和关闭。这是可选支线。 |
| 玩家输入 | 获得至少一处线索后，在调查枢纽选择留回邮签；填写收件人、编号并确认署名。 |
| 存档、回退、日志 | 游戏右上角手札；游玩底栏的回退和阅读记录。 |
| CG、音乐、剧情鉴赏 | 标题页或手札进入；按通关/已听曲目解锁，首次进入不会全部可用。 |
| 配音、自动与跳过 | Mira 初登场的一句有配音，可在说话人提示处重播；不是全篇配音。底栏可自动播放和跳过已读。 |

模型已有直接试映入口；视频、玩家输入、场景热点、拨盘等仍主要嵌入正常调查故事，首轮可发现性仍需继续改善。不能把这个入口补齐写成 LetsGal 全功能已实现；多轨时间线、通用 UI 编辑、PSD 导入、多人协作及平台服务等缺口仍保留在上表。
