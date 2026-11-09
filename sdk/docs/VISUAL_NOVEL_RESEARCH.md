# Pocket 视觉小说引擎：市场调研与验收基线

> 调研日期：2026-11-07。许可证、兼容性和能力描述以本文件所链接的官方文档/发行仓库为准；版本会变化，合并第三方代码前必须复核对应版本的 `LICENSE`、依赖及资源条款。本文件不是法律意见。未列价格，避免把短期价格当作架构依据。
>
> 本文件是持续更新的产品与验收基线：后续每次完成一项能力，在对应验收行记录实现入口、实际运行证据和未覆盖项；不能用静态检查替代真实 Guest/Host 行为。

## 产品方向

目标是在 Pocket 中实现可复用的视觉小说运行引擎和可编辑的完整能力 Showcase 小游戏。覆盖写作、剧情状态、场景演出、音频、存读档、阅读辅助、UI、本地化、调试、可访问性、扩展和打包。实施阶段只安排依赖顺序，不削减完整目标。

**首要架构选择：游戏、编辑器、调试预览共用一个 `StoryDefinition`（项目保存为 `story.json`）和一个 JS 运行时。** 图编辑器通过结构化事件编辑同一文档；角色、变量、资源、选择、条件、命令有明确类型和稳定 ID。预览调用此 JS 核心，并从同一 story/assets 构建。不维护第二份图数据、第二套剧情状态机或编辑器专用运行时；在核心开放受控的断点、变量查看和定位接口前，不通过 `eval` 执行用户脚本。

Ink/Inky/InkJS 是值得保留的中间件候选：Ink 是 MIT、面向互动叙事的语言，中间件以 JSON 作为编译产物，也有 JavaScript runtime；但 Pocket 的 pinned PocketJS/QuickJS 编译与 guest 能力尚未通过兼容性验证。因此当前把 Ink 用作能力和语言设计参考，不预先引入第二个 runtime。若未来做互操作，优先做导入/导出或验证后的单一适配，不允许 StoryDefinition 和 Ink 两种格式在运行时各自维护业务状态。[Ink 官方说明](https://www.inklestudios.com/ink/)、[Ink 官方仓库与运行说明](https://github.com/inkle/ink)

Pocket 的宿主仍只承载绘制、输入/IME、生命周期、资源解码和明确注册的原生能力传输。剧情状态、编辑器、UI 组合、自动/跳读策略和记录由 JS 持有；Dart 插件只提供 JS 无法直接完成的 IO/播放边界，不再创建一套剧情策略或播放器状态机。音频是需要真实补齐的宿主能力：本次仓库检索可见 `demo/pubspec.yaml` 声明 `video_player`，但没有找到 Pocket VN 可用的 BGM/SFX/voice API；这不是“静音也算完成”的理由。

## Source-first：保留父 Flutter demo 的可复用行为

已检查 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`，检索和阅读均排除 `pocket_host/`。保留内容没有 VN 引擎、对白/分支脚本或存读档系统；新引擎是已确认的能力缺口。以下行为可作为迁移行为与回归案例来源：

| 保留来源 | 可复用行为 | Pocket 必要适配 |
| --- | --- | --- |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/app_ui_showcase/main.js` | JS 组合屏幕、聚焦/动作处理、弹层、滚动和组件状态；用户动作走命名 action | 用 StoryDefinition 事件驱动同一 JS UI；VN 菜单和对白 UI 不另建 Flutter 业务树 |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/app_nav/main.js` | JS 持有共享状态、行动按钮、页面/子应用导航 | 引擎剧情变量与路由由 JS 状态模型拥有；原生边界只报告事实/传输请求 |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_flutter_ui.js` | 控件构造器将 JS 语义事件映射到宿主 UI 控件，可实现按钮、焦点、弹层等原生交互 | 只取控件/输入桥行为；不把旧 Widget 映射协议当作剧情模型，也不新增重复 UI 框架 |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_router.js` | 页面生命周期与多个转场描述在 JS 中定义，支持进出场和反向转场 | 转为 VN 场景的纯 JS 转场时间线/命令；验证帧变化和转场中输入的真实行为 |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/app_game_detail/main.js` | JS 拥有游戏状态与 `onUpdate(dt)` 更新；通过 Canvas2D 绘制 HUD，并通过 host scene/input 边界获取原生事实 | VN 运行时事件和变量留在 JS，文本/肖像/背景绘制复用 Pocket 绘制管线；需要的音频 IO 通过明确 native capability 接口 |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart` | 旧 demo 将焦点、选择、弹层和页面转场映射到 Flutter 组件，可作为交互语义核对材料 | 仅保留行为参考；Flutter 组件树中的业务状态/编排不迁移成新 SDK 的第二状态机 |

实施验收应证明：选择、动作、变量变化确实由 JS 运行后改变画面/剧情；从 `StoryDefinition` 编辑保存、经 pinned `buildGuest` 构建，再由 native Pocket probe/Host 执行完整主线。不能把父 demo 的 3D HUD 或旧 Flutter renderer 当作已具备 VN 引擎的证据。

## 市场调研：产品角色、强项与许可边界

| 产品 | 产品角色 / 作者体验 | 覆盖能力与可借鉴处 | 许可与 Pocket 可复用边界 |
| --- | --- | --- | --- |
| **Ren'Py** | 集成式 VN 引擎、专用脚本、Launcher/脚本创作工作流。对白与角色对象易读，复杂逻辑可用 Python；适合做完整 VN 而不是单独对白库。 | choices、变量/流程、ATL 位置/缩放/旋转/颜色动画、音乐/SFX/voice channels、存档和回滚、自动/已读跳过、对话/UI/图片/字体本地化。官方列出桌面与 Android/iOS；HTML5/WebAssembly 当前标为 Beta。 | 官方称 open source / 可商业使用；大部分 MIT，但明确包含 LGPL 部分且分发要满足 LGPL，二进制还含多种有单独许可的依赖。适合能力参考，若复用代码按文件和依赖清单逐项审查。[License](https://www.renpy.org/doc/html/license.html)、[保存/加载/回滚](https://www.renpy.org/doc/html/save_load_rollback.html)、[变换](https://www.renpy.org/doc/html/transforms.html)、[音频](https://www.renpy.org/doc/html/audio.html)、[本地化](https://www.renpy.org/doc/html/translation.html)、[平台](https://www.renpy.org/) |
| **Naninovel** | Unity 上的商业 VN framework/runtime + scenario DSL、Story Editor、VS Code 编辑支持；它不是独立通用宿主。 | `@command`、文本、label、分支/choices；角色/背景 actor、动画/转场、BGM/SFX/voice；game/global/settings 三类持久状态、quick/manual save、rollback snapshots、read-only skip、auto-forward；脚本、音频、背景、UI 本地化。 | 专有 EULA 许可，允许把引擎嵌入玩家产品并商业分发，但禁止独立转售/分发，也禁止用于制作竞争的引擎、framework、工具或服务。只作功能与架构参考，不复用代码/资源。[EULA](https://naninovel.com/eula.html)、[剧本](https://naninovel.com/guide/scenario-scripting)、[状态](https://naninovel.com/guide/state-management)、[状态与 skip 配置](https://naninovel.com/guide/configuration)、[音频](https://naninovel.com/guide/audio)、[本地化](https://naninovel.com/guide/localization.html) |
| **TyranoScript / TyranoBuilder / TyranoStudio** | 需分开看：TyranoScript 是多平台 VN 脚本引擎；商业 TyranoBuilder 是其上方 GUI 创作工具；免费的 TyranoStudio 提供项目管理、预览、console、变量监视、代码编辑、资源管理、坐标预览和打包。 | 标签/脚本可表达分支、变量、背景、角色、音频、keyframe 动画、Live2D；系统 UI 可换肤、存档/读档/日志/backlog/skip；TyranoScript v600+ 提供文本抽取、CSV 翻译和运行时切语言。 | TyranoBuilder 官网说明它是基于 TyranoScript 的 GUI 工具。[官网产品区分](https://tyranobuilder.com/about/)、[Builder FAQ](https://tyranobuilder.com/faq/)。TyranoScript 官方当前条款称免费、商业用途不受限、可为创作修改，但禁止再分发引擎自身，因此不能简单标作 OSI 开源，也不能将“免费”当作可随 Pocket 引擎再分发。[Runtime 条款](https://raw.githubusercontent.com/ShikemokuMK/tyranoscript/master/LICENCE.txt)、[Studio 与创作功能/条款](https://tyranoscript.com/studio/)。Builder 不支付引擎分成不等于源码开放；VN Maker EULA 同样不适用于 Tyrano。 |
| **Visual Novel Maker** | 商业一体化编辑器/游戏制作软件；官方旧版帮助中心记载场景编辑、数据库、JavaScript/CoffeeScript 与插件，以及 Web/桌面/Android/iOS 的导出。帮助页面标注 2017，应作为历史能力参考，目标发行版需再次确认。 | 图形化场景命令、label/jump/条件/变量、音效、角色变换、Live2D、message、choices、save/load；系统命令含 unread skip、自动消息、语速、音量等；支持翻译流程。 | EULA 授权个人使用软件制作原创游戏并允许按附录分发游戏；限制逆向/转让软件，随软件的标准资源只可嵌在用 VN Maker 制作的作品中。不可把随附素材带到 Pocket Showcase。[EULA](https://store.steampowered.com/eula/495480_eula_0)、[能力与历史平台列表](https://asset.visualnovelmaker.com/help/Visual_Novel_Maker.htm)、[场景命令](https://asset.visualnovelmaker.com/help/Scene_Content_Commands.htm)、[系统命令](https://asset.visualnovelmaker.com/help/System_Command.htm) |
| **Unity + Yarn Spinner** | Unity 是通用商业游戏引擎；Yarn Spinner 是叙事语言、编译/运行库和引擎集成，不是独立 VN 渲染引擎。Yarn VS Code Editor 提供错误检查、图视图、运行预览、项目设置/命令定义、CSV 和导出格式。 | screenplay 风格 `.yarn` 节点/命令/函数/选项；Runner 把 lines/options/commands 提供给自定义 presenter；变量和本地化 string ID/CSV 可关联 voice/assets。存档、rollback、整体 UI、场景和打包归宿主/Unity。 | Unity 官方明确 Unity 本身不是开源（公开少量 package 不代表引擎 OSS）。Yarn core 和 Unity integration 为 MIT；Godot GDScript 与 Unreal 适配器用 YSPL，官方 YSPL 禁止将源码用于分发竞争 dialogue/narrative authoring engine，除非获得其他商业条款。Pocket 产品会与此类工具重叠，故这些 YSPL 代码不能作为可分发引擎依赖。[Unity 源码许可 FAQ](https://unity.com/products/source-code)、[Yarn 许可矩阵](https://www.yarnspinner.dev/license/)、[YSPL 原文](https://raw.githubusercontent.com/YarnSpinnerTool/YarnSpinner-UnrealEngine/main/LICENSE.md)、[Yarn 编辑器](https://yarnspinner.dev/editor/)、[Yarn Unity runtime](https://yarnspinner.dev/docs/unity/) |
| **Ink / Inky / InkJS** | Ink 是互动叙事语言/compiler/runtime；Inky 是作者编辑器/边写边玩工具；inkjs 是兼容 JS runtime/compiler port。Ink 被明确设计成可嵌入其它游戏的 middleware，不负责完整 VN UI/演出。 | 强在可读的分支文字、choice/divert、条件/变量、可复现运行状态与 JSON 编译产物；Inky 方便试写和直接试玩。应用自定义角色、背景、转场、音频、存档 UX、日志/阅读设置。 | Inkle 官方称 ink、Inky 与 Unity 集成 MIT；官方仓库说明 Ink runtime 包含 JavaScript-based engine、可读 JSON，且并非 end-to-end game engine。可继续评估作为互操作能力；是否能在 pinned PocketJS Guest 中运行仍待实际验证。[Ink 官网/许可/定位](https://www.inklestudios.com/ink/)、[Ink runtime/JSON/API/MIT](https://github.com/inkle/ink)、[Inky editor](https://github.com/inkle/inky) |
| **Godot + Dialogic** | Godot 是 MIT 开源通用游戏引擎；Dialogic 是 Godot 插件而非独立 runtime。Dialogic 2 有可视时间线和文本编辑两种视图，可创建事件块、变量/人物、预览剧情，便于参考编辑器交互。 | 时间线事件、conditions、choice/jump、人物与姿势/动画、text effects、audio/voice、auto advance/skip（可在 unread 停止）、backlog/history、存档槽/截图/额外数据、CSV timeline/character/glossary 本地化。 | Godot MIT；Dialogic GH 仓库 MIT（随附字体需单独看 Apache 条款）。Dialogic 2 官方当前文档标记 alpha/development，要求 Godot 4.5+；能力可作成熟度参考，不移植 GDScript/Control UI 到 Pocket。[Godot 许可](https://docs.godotengine.org/en/stable/about/complying_with_licenses.html)、[Dialogic 2 官方文档/Alpha 声明](https://docs.dialogic.pro/)、[Dialogic 仓库/许可](https://github.com/dialogic-godot/dialogic)、[读写 timeline](https://docs.dialogic.pro/timeline-text-syntax.html)、[自动跳读](https://docs.dialogic.pro/auto-skip.html)、[存档](https://docs.dialogic.pro/saving-and-loading.html)、[本地化](https://docs.dialogic.pro/translation.html) |
| **Kirikiri / KAG** | Kirikiri 是可扩展 runtime；KAG 是以 TJS2 编写、提供标签式对话剧情/选择的 ADV/VN 系统；两者不是同一层。新版 Kirikiri Z 文档属于 Wamsoft derivative，KAG3 文档多为历史文档，不能把不同仓库的许可和平台支持混为一谈。 | 标签/label/choice/jump、系统存档/读档/thumbnail、read/unread 进度处理；引擎有图层、声音、转场、插件，扩展功能丰富。适合作为传统 tag runtime 和场景能力参考。 | 本次引用的 Wamsoft Kirikiri Z 明确采用 modified BSD 并要求核对 bundled dependencies；这不代表所有 Kirikiri2/KAG3 组合都同许可。古老 KAG 文档说明其内容与引擎/版本有边界，存档兼容性会受 label/subroutine 改动影响。[Kirikiri Z 许可](https://wamsoft.github.io/krkrz_dev/en/guide/Copyrights/)、[依赖许可列表](https://wamsoft.github.io/krkrz_dev/en/guide/BundledLicenses/)、[KAG 与 TJS2 边界](https://ghpages.uyjulian.pw/kag3-documents/e/contents/Intro.html)、[KAG 存档](https://krkrz.github.io/krkr2doc/kag3doc/contents/SaveData.html)、[KAG 既读/未读](https://krkrz.github.io/krkr2doc/kag3doc/contents/ReadUnread.html) |

### 横向能力对比

表中“宿主负责”表示所选材料本身是 middleware/插件，没有证据证明提供完整 VN 玩家体验；“未核实”不等于没有。每个引擎详情行附官方能力依据；版本/平台不在这些链接明确保证的范围内时，不外推结论。

| 能力 | Ren'Py | Naninovel | Tyrano | Visual Novel Maker | Yarn Spinner | Ink | Dialogic 2 | Kirikiri/KAG |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 写作与编辑 | 专用可读 DSL + Python；集成 Launcher | `.nani` 文本 + Story Editor / 外部编辑 | Tag/脚本；Builder GUI、Studio 代码编辑/预览/调试 | 图形化场景/数据库 + JS/CoffeeScript | `.yarn` 文本 + VS Code graph/preview/diagnostics | `.ink` + Inky 即时预览，导出 JSON | 双视图：可视/文本 timeline，文本可编辑 | KAG 标签/文本文件，TJS2 扩展 |
| 分支和状态 | 变量、label、choices、Python | label、命令、choices、定制命令/表达式 | 标签/label、变量、宏/子程序 | 条件、switch/变量、label/jump/循环 | nodes/options/commands/variables；游戏状态由宿主集成 | choices/diverts/condition/variables；状态可 JSON 序列化 | event timeline、choices/conditions/variables、jump/call | labels/links/jumps、TJS2 |
| 演出/动画 | 显示层、ATL transform、screen language | actor/背景/动画/特殊转场 | 背景/角色层、keyframe、Live2D | 背景/角色变换、效果、Live2D | presenters/commands 由游戏接入 | 宿主负责 | 背景/人物/pose/animation/text effects | layer/transition/plugins |
| 音频 | 多 channel：music/sound/audio/voice，音量 preference | BGM/SFX/voice、资源加载配置 | BGM/SFX 与自定义控制；Builder 还支持 Live2D 等 | 播放音乐/音效、设置/voice 相关选项 | line IDs 可关联 voice/assets；播放 UI 由宿主负责 | 宿主负责 | Audio/Voice event | Sound subsystem、格式插件/音频 API |
| 存档/回滚/阅读历史 | game state + load + rollback；另有日志/skip preferences | Game/global/settings state；quick/manual save、rollback steps | save/load/backlog；skip 通过内建 UI | save/load、backlog、read/skip/auto | 宿主负责整体存档/回滚 | runtime story state 可保存；VN 存档 UI/回滚由宿主负责 | save slot/thumbnail/extra info、History；auto-skip 可按 unread 控制 | 栞 saves、progress/read-unread；label 变更影响兼容性；rollback 未在本次引用的 KAG 页面核实 |
| Auto / Skip | auto-forward、seen-only/all skip 配置 | auto-play、默认 read-only skip | skip 与系统配置 | unread skip、auto message、voice wait 设置 | 宿主负责 | 宿主负责 | auto-advance、auto-skip、遇 unread 可关闭 | skip/读速与既读状态 |
| UI 与本地化 | screen language；剧情、UI、图片、字体翻译 | 可换 GUI；scripts/audio/backgrounds/UI 多语言 | 自定义 system UI/HTML/CSS，CSV 文本抽取与语言切换 | 自定义 UI / database / 翻译工作流 | 自定义 presenter + CSV/id/voice localization | UI 完全由宿主决定 | 字符/时间线/glossary CSV 翻译 | layer/标签/插件，项目自定义 |
| 调试、扩展和打包 | Python hooks、screen language、launcher build | C# custom commands/actors/serializers；Unity targets | 插件/tag 与 Studio 实时 tag console、variable watch、坐标预览、打包 | JS/CoffeeScript 插件、desktop/mobile/web packaging（历史文档） | command/function definitions、IDE graph/preview、集成至引擎 | middleware/API/JSON；宿主自行组装 | custom events、信号、代码 API；宿主 Godot 打包 | TJS2/插件 API，工具链与平台需按所选发行版核验 |

## Pocket 的实现优先级与编辑器决策

下面是完成顺序，**每项均属于目标产品的验收范围**。市场调研支持采用可读剧情、稳定标识、类型化命令、运行时预览、变量调试和可移植的数据边界；它不支持把某一个外部引擎整个嵌入 Pocket。

1. **数据模型和 JS story runtime**：单一 `StoryDefinition`/`story.json`；稳定 node/line/choice IDs；有校验的类型化 text、choice、condition、set-variable、jump/call、wait、stage、audio、gallery/glossary 等事件；运行时保存剧情位置、调用栈、变量与已访问标记。含可控表达式/命令 registry，不通过 `eval` 跑任意项目文本。
2. **真实可编辑的 Story Editor 与 debug preview**：创建/打开/保存 story.json；结构化人物、变量、资源、标签、选择与条件；图/时间线编辑可增删移动重排连线并保存回同一文件；引用、重复 ID、不可达节点、循环、死端、缺资源/翻译等诊断；当前故事试玩、暂停、step/continue/reset、断点、变量/剧情指针查看、跳转到节点。编辑状态和试玩状态须可互相核验；编辑→buildGuest→native 执行是端到端验收路径。
3. **完成 VN 主线表现**：标题/章节、背景/场景、角色立绘与表情/位置/层级、分步打字与富文本标记、有限时/等待/输入、可选分支/结局；淡入淡出/滑动/缩放、震动、character enter/leave 等脚本可控转场；CG/场景回放画廊和多结局解锁。
4. **正式音频与阅读体验**：通过薄 native plugin 接入播放边界；JS 管 BGM/SFX/voice cue、分组音量、打断/衔接策略和与对白的同步；BGM loop/fade、voice 按 line ID 选择性播放、voice 等待 auto 行为、静音和音量设置。真实播放是引擎验收，不以记录一条 host request 代替听到/观测到输出。
5. **玩家工具和状态持久化**：标题/设置/存档/读档/暂停/日志/backlog/快捷存档/自动存档；至少多个手动 slot，时间/章节/最近对白/可选缩略图；读档恢复人物、场景、背景音乐、路线变量、回滚历史；有限步 rewind / rollback 保持同一语义，不只回退文字指针；独立保存语言/音量/显示/辅助设置；global persistent progress、结局/CG unlock。
6. **已读、自动播放、跳过**：每行文本有稳定 ID；仅当对白完整显示/被点击完成时登记为已读，跨存档保留；skip 默认仅跳过已读，单独开关可读全剧情并有明确告知；auto advance 等待可配置并尊重玩家输入、语音播放完成和 choices；分支遇未读文本停止已读跳过；跳过过场/语音策略可配置。
7. **本地化、适配和无障碍**：story 和界面资源分开导出/导入 CSV；stable IDs、diff 检查、缺失/多余翻译报告、运行时即时切换/fallback；人物名、UI、字体、图片、语音资源按 locale 对应；长文/扩展后 reflow、动态字体、横竖屏/安全区、窄屏输入与焦点；键盘/触控/手柄完整操作，清晰 focus 与可访问语义；文字大小/对比度/文本速度、减少动画/闪烁、暂停、voice 字幕等玩家选项。
8. **扩展与分发**：公开有版本的类型化 JS command/asset provider/renderer adapter 接口，扩展不改变核心剧情引擎；资源清单、校验、可复现打包、运行时缺资源清楚报错；使用 pinned Guest compiler/engine 与资源 pipeline；能从 demo 项目导出并由目标 Pocket host 执行。平台只承诺当前 Pocket 实际支持并已跑通的 target，不把被参考引擎的平台列表转成 Pocket 承诺。

### 视觉编辑器的优先采用模式

- **图/时间线 + 属性编辑 + 源文本可追溯**：Dialogic 用同一 timeline 结构同时提供图形/文本视图；Yarn Editor 的 node graph、预览、语法诊断、项目表单、命令定义；TyranoStudio 的实时执行标签/变量、资产管理/坐标预览；这些组合表明编辑器不能止于“放几个 block 的截图”。Pocket 应实现可移动/可连线的事件图、选择的类型化属性面板、角色/变量/资产 inspector、在线预览以及错误面板，任何编辑动作都写回 `story.json`。 [Dialogic timeline 与双编辑视图](https://docs.dialogic.pro/)、[Yarn Editor](https://yarnspinner.dev/editor/)、[TyranoStudio 工具](https://tyranoscript.com/studio/)
- **作者先验可理解**：给剧情事件用创作者语言（对白、选项、条件、变量、角色进退场、背景、音频 cue、等待）；把低层绘制/Host 方法藏在命令面板和扩展 registry 中。对未识别/未来事件保留可编辑的原始 JSON，不静默删除/改写。
- **调试闭环与制作/发行一致**：在真实 runtime 运行当前保存版本，报错中能点回节点/资源，变量视图和执行指针实时刷新；同一个项目 `story.json` 从 editor preview 到 buildGuest/native demo 原样构建；调试接口只暴露有限受控能力（暂停、继续、单步、断点、变量只读、跳到安全节点），不向编辑器注入另一套解释器。
- **先让故事能完整生产**：编辑器不得只实现静态预览；需要完整新增/编辑/删除/复制/重排节点、选择分支、条件与变量值、人物与表情资源、音频/背景引用、语言文件、存档演示内容；保存/导出导入后重新打开且继续试玩结果稳定。运行时未支持的功能在编辑器显示有名的 unavailable/error 状态，不生成成功占位。

## 非目标与边界

- 不造第二个 Flutter/Dart 业务层、声明式 UI 引擎、绘制/布局引擎或故事状态服务；不把 Showcase 业务代码绑进 public SDK，也不读取/复用旧 `pocket_host/`。
- 不复制 Naninovel/VN Maker/TyranoBuilder 受限源码或软件内置素材；TyranoScript 当前许可禁止 runtime 再分发；Ren'Py 和 Kirikiri 的复合依赖需先做单独许可证清点；Yarn YSPL 适配器不得未审许可就作为竞争引擎依赖。
- 不把“免费工具”、“允许卖用该工具做的游戏”、“OSI 开源”和“可再分发/改编 runtime”当作同一件事。具体引用仅对应上表产品/版本；不替代律师 review。
- 第一版不重建通用 2D/3D game engine、编辑器 IDE 平台、云翻译/协作服务、资产市场或完整 Live2D SDK。Live2D/高级 2D puppet 需要一个隔离扩展接口、单独评估授权和 Pocket host 的可行性；基础 Showcase 必须具备可信的立绘/表情/层级/动画，不允许以不支持为名把所有表现能力缩成静态文字。
- 版本控制关注唯一 story definition 和资源 manifest；不维护不同作者格式的平行剧情库。Ink importer/exporter 是后续可选互操作工作，不是眼下主线的第二 runtime。

## 完整 Showcase 小游戏验收矩阵

矩阵是完成目标的验收条件，不是“最低功能集”。验收都要求从 Editor 保存的真实 story.json 运行；涉及运行行为须走编译后的 JS Guest 和 native Pocket Host，使用玩家输入观察画面/剧情/声音/持久数据。矩阵中的“演示证据”需在实现时补充可重复的脚本化或录制步骤；不允许删掉失败项或把目标改成只通过静态检查。

| ID | 覆盖范围 | 可验收行为（全部以真实游戏与编辑器验证） |
| --- | --- | --- |
| E1 | 项目/故事编辑 | 新建/打开项目，编辑人物/立绘、背景、音频 cue、变量、章节、对白、富文本、选择/条件、标签/跳转；新增/复制/删除/重排节点和连线；保存、关闭、重新打开后内容和 ID 不变。 |
| E2 | 图视图/检查器 | 从入口到所有结局看到可读节点图；拖动节点/连线、选择节点后 Inspector 双向更新；结构化角色/变量/资产编辑反映在剧情节点；没有只读展示图、没有互不同步的图和 `story.json`。 |
| E3 | 导入导出/诊断 | 导出/导入同一 `story.json` 与 CSV 翻译文件后，稳定 ID、分支和数据值不丢失；检查重复 ID、缺少资源/标签/条件变量/翻译、断路选择和不可达结局，并可从诊断跳回有问题节点。 |
| E4 | 预览调试 | Editor preview 用引擎 core 可启动同一 story；暂停/继续/单步、设断点/清断点、检查/追踪变量、跳到安全节点、重新开始都改变真实运行状态；错误带节点 ID/命令/资源定位，不 eval 自由文本。 |
| R1 | 成品剧情/route | 从标题进入含至少三个玩家选择、条件可见/禁用选项、两个以上由不同变量组合决定的 route、至少三个可解锁结局的完整故事；每个路线输入序列都有可重复期望结局，变量在 dialogue 和条件中可观察。 |
| R2 | 变量/条件/命令 | 故事演示 bool/number/string、赋值和增减、比较/逻辑表达式、变量插值、条件 choice、label/jump/call/return、一次有界重复和自定义注册 command；非法表达式和缺失变量在编辑时诊断，运行时安全报错，不执行任意脚本。 |
| R3 | 场景/角色 | 可动态切换至少两个背景、两名角色、每人多个表情/位置/层级；背景/角色替换与进入离开/变换在 JS 帧中可见；资源缺失显示明确错误。 |
| R4 | 演出 | 一段剧情至少真实演示淡入/淡出、移动/缩放或位移、抖动/震动、文字打字与即时显示、等待/点击继续；可快进/中断时事件队列保持顺序；reduce motion 偏好会压制适当动效。 |
| R5 | 特色叙事表现 | 包含 CG/解锁回放画廊和 glossary/codex（点击/焦点可展开解释）；从 gallery 进入回放后可回到原进度；角色立绘/CG 的交互由 JS 控制且由真实 Pocket 绘制，不用静态占位假装动态能力。 |
| R6 | 音频/voice | Native Host 实际播放循环 BGM、one-shot SFX、两句按 line ID 关联的对白语音；BGM/SFX/voice/master 分别调节、静音、切换场景淡出/切歌；自动播放是否等当前语音由设置决定。Host request 只能作为传输证据，必须额外观察实际输出/媒体播放状态。 |
| R7 | 存档/读档/自动存档 | 至少 3 个手动槽和 1 个 quick slot，显示章节/对白/时间信息（若使用缩略图则确为实时保存帧）；另有章节切换/重要节点 auto-save；读档准确恢复剧情位置、route 变量、屏幕上的人物/背景、当前 BGM、已读进度。删槽、空槽、损坏/旧 schema 数据都有正确结果。 |
| R8 | Rollback/Log/Backlog | 在 choice 前回退，再选择另一分支，恢复到正确对白/演出/变量；多步 rewind 达到设置深度并在首次不可回退处安全停止；回滚之后日志保留真实读过的历史、load 之后日志与 state 一致；backlog 点击旧对白可显示其角色/语音（若有）并回到当前剧情。 |
| R9 | 已读/Skip/Auto | 完读后重新进入同一 line 显示为已读；未完成离开不误标已读；read-only skip 跳过已读到未读即停止；all skip 明确受用户设置且可随时中断；auto advance 适应文字长短，可被点击/键盘取消，并按设置尊重语音完成与 choice 等待。 |
| R10 | 玩家系统 UI/设置 | 有主菜单、新游戏/继续、暂停/系统菜单、存档/读档、日志、设置和结局；显示语速、auto delay、BGM/SFX/voice、语言、文字大小、动画减弱等实际生效选项；游戏设置持久保存但不被载入旧游戏档回滚覆盖。 |
| R11 | 本地化 | 至少两种语言覆盖对白、选择、UI、人物显示名、glossary；有稳定行 ID 的 CSV 导入/导出，运行中切换/fallback；模拟缺项/格式错误可定位；长译文、中文/拉丁混排和安全区域变化自动布局不截字、不误换行。 |
| R12 | 无障碍/多输入 | 所有菜单、选择、日志、设置可触控并可用键盘/方向键/手柄操作；当前焦点可见，选项有语义 label；字号/对比度/语速/减少动画功能生效；pause/resume、隐藏对话框/恢复行为正确。 |
| R13 | 本机与生命周期 | JS Guest 运行完整主线且由真实 Host render；启动、后台、恢复、路由离开/返回期间没有剧情重复推进或丢音/持久化错乱；最终结局能返回标题并重新开档。按 Pocket 当前支持的平台逐项跑通，没验证的平台如实标 unsupported。 |
| R14 | 扩展/API | 通过受控 registry 添加自定义可等待 command 和一个 asset provider，编辑器给其可编辑字段/文档提示，runtime 正常同步完成；非法插件/未知 command 显示明确诊断，不破坏核心加载/存档。 |
| R15 | 构建与发布 | Editor 使用 pinned `buildGuest` 构建从其保存的 `story.json` 得到 guest bytecode；同一产物可经 native probe/Pocket Showcase 打开并输入驱动到预期结局；资源 manifest、许可证和版本元数据进入 bundle；重新构建可复现，未支持能力会明确报告。 |

## 后续更新记录

| 日期 | 更新 | 实际验证证据 |
| --- | --- | --- |
| 2026-11-07 | 建立市场基线、源码适配、Pocket 架构选择和完整功能/Editor 验收矩阵。 | 以官方产品/许可文档和保留父 demo 源码完成初始核查；验收矩阵仍是完整目标，不因当前实现范围缩小。 |
| 2026-11-07 | 增补同一 StoryDefinition/asset registry 编辑器、bounded undo/redo、同-core debug preview 与 registry-only 图片预览的状态。 | `sdk/editor/test/novel.test.ts` 与 `sdk/editor/test/novel_history.test.ts` 共 6 项通过；Playwright 实际编辑多字符对白、undo/redo、保存、编辑资源路径、预览立绘/背景/CG，并观察核心计时推进。可视节点拖线画布、本地化/无障碍完整审计、完整 Guest/native 主线仍待验收。 |
