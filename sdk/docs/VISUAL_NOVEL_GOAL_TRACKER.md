# Pocket VN 54 组功能追踪表

**暂停收尾（2026-11-09）**：用户要求当前安全区问题收尾后暂停进一步优化。晚挂载NovelView丢失首次安全区消息已在SDK JS HostBridge入口修复；旧Guest存档延迟负对照失败，新Guest真实Core两项/72断言及UI SDK八项通过。Android模拟器实际OS安全区及点击最终复验1项通过，未手动重发；iOS/真机/OS旋转仍未完成。所有剩余项目和恢复动作见[未完成清单](VISUAL_NOVEL_UNFINISHED_20261109.md)。完整Goal不标记完成，状态以暂停记录为准。

**Editor 草稿资源诊断增量（2026-11-09）**：移除浏览器四段重复资源引用遍历，直接复用 SDK 纯校验器；诊断去重纳入具体字段，不再用已保存服务端诊断覆盖修复中的草稿。同一 scene 的两个坏引用均显示，未保存修复、磁盘不变、撤销/重做、保存重开、同 buildGuest 编译与 Core 实际点击至结局的浏览器验收1项通过；相邻 registry/build/场景对象7项通过。E06.3 全类别覆盖仍未完成，暂不升级状态。见[资源诊断](VISUAL_NOVEL_REGISTRY_DIAGNOSTICS.md)。

**原生游戏安全区增量（2026-11-09）**：针对 iOS/Android 游戏反馈，确认 `NovelView` 的共同 stage/UI 根已消费一次全局安全区；修复顶部局部遮挡释放页面侧边距后，游戏菜单未避让局部区域和内移系统关闭按钮的问题。复用 `@pocket/ui` contour/occlusion 布局及共享 host-action reserve，旧字节码负对照 menu right=749 越入 x=744 遮挡，新字节码 right=644；原不安全位置不再触发菜单，迁移后可实际点击。390×844、412×915、844×390 再回竖屏的真实 Guest 输入与 SDK/framework 组合13项/84断言通过，VN SDK277项通过；不是物理设备或OS旋转验收。宿主已复用现有加载门，在首次可见前应用安全区并取得零时间布局帧，Flutter3.47.9专项16项通过；整包及真实FFI补验结果单独记录。见[原生安全区](VISUAL_NOVEL_MOBILE_SAFE_AREA.md)。

**独立试玩页面（2026-11-09）**：应用户反馈加入“在新页面打开试玩”真实链接，独立页自动运行已保存故事；去掉360px固定宽度并复用SDK viewport/character bounds。1440×1000、800×900、390×844完整布局、缩放不重启、选项到结局及story未变通过，原文富文本Editor回归同时通过。8791绑定实际Lantern工程，新页面实际加载无脚本错误；不计作Core/native模型、音视频或全量Editor验收。普通Demo历史PID87428目前已退出，未为本轮Editor体验重新启动游戏。见[独立页验收](VISUAL_NOVEL_PREVIEW_PAGE.md)。整体Goal保持active，Live2D清晰度延期。

**当前状态（2026-11-09）**：完整 Goal 未完成，统计为 **9 组通过 / 36 组部分验收 / 9 组待实现**。最新普通试玩为 `sdk/.pocket-build/lantern-playable-rich-text-20261109/pocket_host.app`，历史PID87428现已退出，制品为正常 `lib/main.dart` Profile 入口；签名、最终 pinned Core、四份精确资源、runnable main isolate 与 onscreen 窗口已核验，旧PID74668已退出，原存档SHA未变。新增回放“信纸上的第二层海”展示字样强调、注音、局部停顿与可点击注记；窄屏/大屏真实输入、历史注记及两结局隔离验收通过。窗口存在不代表用户前台可见，系统前台状态记录于 `ordinary-window-final.json`。Live2D清晰度继续延后；最终跨平台包、真机、Windows及整游戏性能门槛仍开放，完整Goal保持active。见[富文本验收](VISUAL_NOVEL_RICH_TEXT.md)。

**上下文预览增量（2026-11-09）**：E04.2/E04.3 部分验收：从故事起点沿同一SDK真实执行，选择/输入由作者决定后继续，显式wait推进实际时间；可见对白、结局及背景/层/角色配置可回到当前已提交来源。循环断点只放过当前一次已修复；普通预览对白完成后相机/时间轴仍继续、暂停/结束停帧已验。最终SDK255项、Editor单元36项、新浏览器与pinned Guest真实输入闭环及旧调试/输入回归通过。普通Demo PID40085、存档与资源未变，未重开试玩。当轮独立入口选择尚缺，后续进展见下；完整动画/native来源和整游戏性能仍缺，统计9/34/11不变；Live2D清晰度延后。见[验收边界](VISUAL_NOVEL_CONTEXT_PREVIEW.md)。

**独立预览入口增量（2026-11-09）**：复用同一 SDK 核心，为主线、已声明回放和有效章节蓝图提供独立起点；默认新状态，不伪造前文或玩家解锁。SDK 260 项、严格检查、真实 Lantern 只读对照通过；浏览器与 pinned Guest 的选择/输入闭环通过，最终输入类型复用修复回归及精确制品审计见[入口验收](VISUAL_NOVEL_CONTEXT_ENTRY.md)。E04 保持部分验收，完整动画/音频/native来源与整游戏性能仍开放，统计9/34/11不变。

**章节蓝图增量（2026-11-09）**：E02.4 部分验收：入口、章节引用、条件、玩家选择、赋值、终点六类节点复用现有指令和调用栈；创建/路由/历史/保存重开→pinned Guest真实点击已过，移除editor元数据后结果一致。Demo新增独立回放“第六十道光”，59/60选择抵达不同正文和结局，原120标签正文未改。代码表达式、扩展策略、章节预处理、折叠分组仍缺，E02保持部分验收，统计9/34/11不变。见[蓝图证据](VISUAL_NOVEL_CHAPTER_BLUEPRINT.md)。

**节点画布增量（2026-11-09）**：E02.3通过：自由label节点拖动、SVG端口连线、平移缩放/定位及创建/重命名/删除位置键历史接入同一story；保存重开→pinned buildGuest→真实Native输入的新路线通过，去掉editor元数据时输出一致。267项核心/Editor/历史回归、新旧图浏览器2项通过；真实Lantern120节点/183边目视检查，修正全图默认缩成细线的问题，定位不改原story。当时E02.4章节蓝图待实现，本轮基础节点部分验收见上，E02仍部分验收，9/34/11不变。该画布轮普通Demo为PID72925，最新进程见表头；Live2D清晰度与整游戏性能门槛仍开放。见[画布证据](VISUAL_NOVEL_GRAPH_CANVAS.md)。

**当前关注点**：用户明确将 Live2D 后续再看，清晰度与真实 Retina 门槛保持开放，本轮停止追加模型专项排查。上一轮真实 Idle0 / 官方 Native 对照确认 134 个 drawable 的实际渲染输入一致；严格动态历史标志比较和完整三角形键覆盖仍有明确限制，不计作画质修复。见 [同姿势证据](VISUAL_NOVEL_IDLE0_RENDER_COMPARISON.md)。I02.2 通用指令表格新增十五类指令的常用字段与复杂 JSON 编辑，浏览器→保存重开→pinned buildGuest→真实 Guest 路线通过；三项既有回归通过。结构性模式切换、缺省字段创建仍使用完整表单，整组保持部分验收。见 [表格验收](VISUAL_NOVEL_INSTRUCTION_TABLE.md)。

**跨曲音乐增量（2026-11-09）**：A02.3 已复用 timeline/audioGains 接通显式 music/effects 分组、V4存档及Editor表单/表格/曲线；Chromium保存重开→pinned buildGuest→NativeSession闭环通过。新增独立回放“风暴交给晨光”，实际Lantern字节码输入2项、完整SDK240项、剧情/双语30项通过；macOS Profile、Android API35模拟器Profile与iOS27.2模拟器Debug各自8/8真实WAV解码、双轨反向淡化、释放、主线音乐恢复及隔离存档保护通过。无新增timer/控制器/native业务状态；真机、Windows、听音与采样级同步未验，该跨曲验收时普通试玩为正常main Profile PID17165，旧PID78886在就绪核验后退出；后续最新进程见表头，macOS用户存档SHA未变；系统仍为loginwindow前台，不宣称用户已看到窗口。详见[跨曲证据](VISUAL_NOVEL_CROSSFADE.md)。A02仍部分验收，统计9/34/11不变，Live2D清晰度延后。

**Android时间线增量（2026-11-09）**：API35 ARM64 emulator Profile 的完整时间线7检查点、独立reduceMotion4检查点通过，保留真实PNG、音量包络和退出释放trace；修正裁切图片UV边界比较及把原生音频采样position误当JS单调时钟的测试假设，未修改生产时钟/渲染/音频。原始position回退仍留作诊断，不宣称采样级同步；锁定真机未操作，iOS/Windows仍待验。SDK候选/恢复基线两个编译来源分别记录，见[平台证据与限制](VISUAL_NOVEL_TIMELINE_ACCESSIBILITY.md#android-emulator-follow-up-2026-11-09)。S04仍部分验收。

**内存归因增量（2026-11-09）**：跨曲制品的 macOS Profile 完成7页、5个模型窗口及20轮循环，只有17/20 RSS窗口稳定，门槛仍未通过；系统换出和空闲malloc区域使RSS无法直接代表活对象。独立模型错误路径已消除注销闭包/实例残留及换key后二次dispose，pinned Guest负对照2次→修复后1次、错误期间actor为0、恢复37帧网格通过；不计作正常循环RSS修复或Live2D画质改善。同运行时重载也已修复旧Core树/PAK纹理累积：3张/12字节→1张/4字节，source与bytecode负对照、失败加载保护及pinned buildGuest A→B→A真实输入通过；原生103项全绿，普通Demo更新为PID72925且存档SHA不变。见[归因证据与边界](VISUAL_NOVEL_MEMORY_ATTRIBUTION.md)。统计9/34/11不变。

**整游戏性能复核（2026-11-09，历史基线）**：`fd670…` QJBC / `54c923…` PAK 的 macOS Profile 基线完成7个页面、5个模型10秒窗口及20轮进入/退出。模型 build P95 12.957–14.536ms、超预算1.803%，RSS增长36.77MiB且仅16/20窗口稳定，仍未达标。Float32二次复制候选21项功能测试通过，但同制品A/B无一致帧耗时收益、RSS仍增长35.34MiB，已撤回生产改动，未增加缓存或降低画质/门槛。该轮普通Demo为PID78886、存档SHA未变；最新试玩进程见表头。见[消融结果](VISUAL_NOVEL_FLOAT_SNAPSHOT_ABLATION.md)。统计仍为9/34/11，完整Goal未完成，Live2D清晰度延后。

**上一轮缩略图增量**：真实存档缩略图已接通 child 图片能力、app-private PNG、JS 纹理与存档引用清理；macOS Profile、Android Profile emulator 与 iOS Debug simulator 各自通过保存/像素、同资源宽度变化、覆盖清理、宿主重建后预览和读档、binding lifecycle、正常存档不变六项检查。driver checkpoint 单测 4 项、本轮实际 native 集成 3 项通过；此前的 JS 44、宿主/存储 8、协议预算/回归 19 项属于前一轮，不重复计作本轮平台验收。宿主重建不代表 OS 进程重启，binding lifecycle 不代表 OS 后台切换。Windows、真机、OS 旋转/窗口变化、进程重启及性能仍未验收。Live2D 清晰度继续延后。F06.3 仍部分验收，54 组统计保持 **9 组通过 / 33 组部分验收 / 12 组待实现**，完整 Goal 仍 active/未完成。见[缩略图证据与限制](VISUAL_NOVEL_SLOT_THUMBNAILS.md)。

**本轮方向转场增量**：四方向 reveal 复用既有 transition/NovelClock，Editor 方向选择、撤销重做、保存重开与 buildGuest→NativeSession 通过；真实 Guest 覆盖 clip/UV、固定 HUD、暂停/skip/quick save-load/rollback，cut 消融当帧移除旧场景。macOS Profile 实际游戏四向中途截图与解码图片/HUD验收通过；新增 replay 保留旧脚本与存档游标，主线存档隔离通过。SDK 204、剧情/locale 27、Editor schema 21 项通过，既有巡演 Native 4 项回归通过。其它风格化效果、移动端/Windows 的该场景和性能仍未验收，S05 保持部分验收。见[转场证据](VISUAL_NOVEL_REVEAL.md)。

**近期已验收的独立增量**：六字输入交接避免 native/Guest 双绘；Word DOCX 审阅稿只读导出未保存草稿；桌面滚轮/触控板路由复用 JS ScrollPage；实际 macOS 窗口尺寸变化；delta-base 不再持有完整资源帧。各项的证据范围、未过门槛和历史制品均保留在本表与对应文档中，不能扩大到整体 Goal。

<details>
<summary>此前阶段摘要（历史制品与阶段观察，当前试玩以表头为准）</summary>

**当前普通试玩与验收（2026-11-08）**：Lantern v6 输入交接修复 QJBC `a5fed263…` / PAK `b08e3f07…` / metadata `0fefee84…` 已打入普通 `lib/main.dart` Profile app，PID3303，位于 `sdk/.pocket-build/lantern-playable-v6-handoff-20261108/pocket_host.app`。六项资源、签名、800×632窗口、正常main isolate及置前状态均已核验；新包就绪后结束旧PID44704，未开Editor、未清用户存档。真实六字打开首帧已从native alpha1+Guest双绘修复为native alpha0+Guest单份；ACK后原生单份，tour-only 00:29/+2与完整main/tour 02:04/+3均exit0。固定同帧去LOD候选在DPR1/2造成全身噪点/接缝，最粗选层提升一级的DPR1候选同样退化，均已拒绝；DPR2实际输出1600×1200，仍不等于物理Retina验收。Live2D清晰度、性能/RSS及整体Goal仍未通过。实体IME与普通窗口独立像素证据仍缺。对白表格及友好CSV v2的导出/列编辑/导入/撤销重做/保存重开→buildGuest→native输入通过，通用指令表格仍缺；SDK187项回归通过；剧本文件非法UTF-8的静默替换已实际复现并修复，错误导入不改草稿/磁盘/历史。新增独立真实main诊断进程的应用内全身/近景截图：800×600/DPR1、SSAA2、原始2048²实际ui.Image已核验；官方Cubism默认静态帧及完整同帧几何已导出；同几何四组Skia及实际Impeller/Metal sample1/2复验完成，DPR1五列ROI未见Metal特有额外模糊，DPR2软件图细节更多；仍不等于物理Retina或用户反馈已修复。54组统计保持9通过/33部分/12待实现。见[清晰度证据](VISUAL_NOVEL_RETINA_ACCEPTANCE.md)、[输入验收](INPUT_OVERLAY_DUPLICATE_TEXT.md)、[对白表格](VISUAL_NOVEL_INTERCHANGE.md)。

**本轮新增验收**：I02.4 Word DOCX 审阅稿已接入当前未保存草稿，导出不改变磁盘、history、revision 或 builtRevision；实际系统读取及 LibreOffice→PDF 113页验证117章节、531指令按源顺序、255句完整正文，全部页总览和首/中/末页复查通过。分块32MiB输入先缓冲再限额的问题已复现并改为按流8MiB超限取消；相关28项测试与最终浏览器→pinned Guest输入均exit0。Word应用本体兼容性、Word导入、Ren'Py和通用指令列仍待验/实现，54组统计仍为9通过/33部分/12待实现。见[Word导出](VISUAL_NOVEL_WORD_EXPORT.md)。


</details>

更新：2026-11-09。本表把 [Goal](VISUAL_NOVEL_GOAL.md) 与 [LetsGal parity 矩阵](VISUAL_NOVEL_LETSGAL_PARITY.md) 的 54 个既有 ID 拆为可执行子项。ID 不合并、不删除；每组状态取该组尚未完成子项的最保守状态。

**历史普通试玩（已被表头v6替换）**：普通 main SUPER2 Profile app `sdk/.pocket-build/lantern-playable-ssaa-20261108/pocket_host.app`，PID 46513；签名、六项 Guest 资源、800×632 窗口及 layer 0 已核验。VM listener 53331 可见但没有 authenticated URL；CUA/native pipe 启动失败，main isolate/前台像素未确认。旧 PID 15377 在新进程就绪后结束，daemon 39062 和用户存档保留，Editor 未开。full20 session 55369 exit 1：handle/三角形每次退出均归零，snapshot/dispose 8,075/8,075；RSS 稳定性未过，模型 build P95 五窗均高于 12 ms。功能组统计维持 **9 组通过 / 33 组部分验收 / 12 组待实现**；Goal 整体未完成。详情见 [子像素验收](VISUAL_NOVEL_RETINA_ACCEPTANCE.md)。

本轮模型更新：v4 scaled 候选四组 macOS Profile test-view / DPR 1、2 的真实 Core 测试全部通过；保守肤色宽度为 390 宽 114/115、1920 宽 142/142.5 逻辑像素，数值门槛通过。它们不是 physical mobile 或 OS resize/rotation 验收；全身构图质量、其他模型状态、稳定内存和全游戏性能仍待验，详见 [模型密度证据](VISUAL_NOVEL_MODEL_DENSITY.md) 与 [v4 checkpoint](LANTERN_V4_ACCEPTANCE.md)。

历史 locale 普通试玩快照（已被表头 SUPER2 普通试玩覆盖）：独立缓存 `sdk/.pocket-build/lantern-playable-locale-20261108/pocket_host.app`，PID 15377；Lantern QJBC `9c01ae0d…` / PAK `3d775a1f…`、Root UI `c91f989a…` / PAK `5955143e…`。六个内置资源与 staged assets 逐字节一致，普通 `lib/main.dart` Profile 签名有效、onscreen 800×632 窗口和 VM listener 已核验；前台游戏像素/main isolate未另行确认。未启动 Editor、未清用户存档。上一普通PID84903在新窗口就绪后准确退出。9c01新增locale检查点消冗余修复，长文四组Profile（72秒/20PNG）、native6项及Editor闭环通过；当前9c01另已完成DPR1/2四姿态固定LOD采样诊断，以及5个模型窗口/2轮释放的Profile基线；build P95为14.932–15.750ms，仍未过12ms门槛，2轮实验不评定20轮RSS门槛。较早的b4e坐标消融仍单独保留，不冒认为9c01结果。见[长文验收](LANTERN_LETTER_SHOWCASE_FLUTTER.md)、[子像素证据](VISUAL_NOVEL_RETINA_ACCEPTANCE.md)与[固定LOD采样](VISUAL_NOVEL_MESH_EDGE_ABLATION.md)。

本轮 Retina 观感修复：已确认 pinned Core 提前将 mesh XY 取整；新增 float mesh DrawList 保留 Core→PFB→Flutter 子像素坐标，普通图片/旧协议不变。最终 `b4e05229…` Guest / `3d775a1f…` PAK、native `86a75823…` 在 329×600/DPR2 Profile 真实 Core 模型回归通过；同帧局部对照改善，见[子像素验收](VISUAL_NOVEL_RETINA_ACCEPTANCE.md)。当前系统仅报告自然 DPR1，物理 Retina 与几何边缘抗锯齿仍未闭合，不升级整组画质或性能状态。

本轮采样消融已撤回两条候选：局部 LOD 的实际画质变化很小，短跑绘制批次增加 45.3%；原图原生 mip 的 DPR1/2 四姿态 Metal 对照均通过功能检查，但目视更柔，边缘与内部相对 4×诊断图的误差均劣于旧采样。生产 painter 已恢复原 aggregate 实现，两条实验分支均删除。AppKit 实测当前唯一显示器为 1920×1080、backing scale 1；没有整屏低分辨率后拉伸的源码证据，也没有物理 Retina 验收。本轮不提升画质或性能状态；下一步评估有界的人物片段 2×离屏渲染，须另过像素、混色、成本和释放门槛。见[原生 mip 消融](VISUAL_NOVEL_NATIVE_MIP_ABLATION.md)、[LOD 消融](VISUAL_NOVEL_LOD_DENSITY_ABLATION.md)与[像素链审计](VISUAL_NOVEL_RENDER_BACKEND_AUDIT.md)。

历史 v4 路线/迁移、四尺寸模型、画廊、视差、音频与存档共享文本池证据见[集中验收记录](LANTERN_V4_ACCEPTANCE.md)，不得把旧制品证据归给当前试玩。主线仍为 218 条 say / 9,961 汉字；旧高清性能基线模型 build P95 约 20 ms，60 Hz 未达标；20次handle归零的旧记录不等于新稳定RSS门槛通过，详见[性能记录](VISUAL_NOVEL_PERFORMANCE.md)。

本轮普通试玩已启用该性能候选，但以下数据来自此前冻结候选，不能当作最终 b4e 制品性能：仅 Demo 显式启用已有静态拓扑缓存，SDK 默认关闭。同一测试源码/PAK 的 ON→OFF 对照中，五个模型窗口 build P95 由 19.516–20.009 ms 降到 12.908–14.930 ms；超预算帧由 32.28% 降到 1.17%，仍未达到 12 ms / 1% 门槛。实际模型交互/像素通过；正常 20 轮 handle 全部归零，但 6 个 RSS 窗口不稳定，内存门槛未通过，不提升组状态。见[当前拓扑消融](VISUAL_NOVEL_TOPOLOGY_CURRENT_ABLATION.md)。

状态含义：**待实现**表示没有证据表明该子项已接入；**待运行验收**表示实现路径存在但指定的运行证据未取得；**部分验收**表示已有真实证据，但该子项或同组仍有明确缺口；**通过**表示本行列出的功能子项均有 parity 所要求的证据。组内出现 `通过` 的子项不代表整组或 Goal 通过。模拟器不替代物理设备，现有目标平台以外的服务和设备继续保留在目标内。

当前 Android 增量：strict v4 归档 Profile APK 在 ARM64 Android 模拟器完成真实 Spine/Hiyori、两张 2048² 纹理、遮罩、动作、模型暂停/恢复与释放、主线存档隔离验收；保留实际 1080×1920 / DPR 2.625 截图及 Guest 指纹。生命周期由测试注入，未证明 OS 后台操作；全身脚部仍被页脚遮挡，物理手机触摸/IME、平台性能仍待验，不升级整组状态。见 [v4 Android 证据](LANTERN_V4_ACCEPTANCE.md#android-profile-package-preparation)。

最新构图增量：`c2df4275…` Guest 在 macOS Profile 的 390×844 DPR2 与 1920×1080 DPR1 均完成三种全身动作、近景、释放及主线存档隔离；六张全身 PNG 目视确认头/手/脚完整。这修复了已观察到的页脚遮脚，但不是 Android 新构图、物理手机或全部尺寸通过；不改变整组状态。见[全身构图验收](LANTERN_MODEL_FULL_BODY_FRAMING.md)。

## 核心、存档与玩家控制（F01–F08）

| ID | 可追踪子项及状态 | 组状态 | 下一可执行动作 | parity / 证据 |
| --- | --- | --- | --- | --- |
| F01 | `F01.1 通过` say/旁白、稳定 ID、逐字显全和继续；`F01.2 部分验收` 中文剧情路径；`F01.3 部分验收` 超时、真相、列车、守灯三结局长对白及Mira/Ren布局通过窄/宽屏真实Guest | 部分验收 | 7行×2尺寸的原生完整文本、text/clip/Continue几何与实际点击推进已通过；仍需Flutter像素和真机输入映射，其他可选支线尚未逐行量测 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[玩家输入](VISUAL_NOVEL_INPUT.md)、[长对白原生验收](VISUAL_NOVEL_DIALOGUE_BOUNDS_NATIVE.md) |
| F02 | `F02.1 通过` 条件/变量选择和不同路线；`F02.2 通过` 三结局及 714 谜题；`F02.3 通过` 限时选择与暂停计时 | 通过 | 保留完整 native route 作为回归，发生 story/engine 修改时重跑并记录制品 hash | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[游戏验收](VISUAL_NOVEL_GAME.md) |
| F03 | `F03.1 通过` label/jump 和嵌套 call/return 的真实指针输入、快照位置与变量顺序；`F03.2 通过` 错误目标拒绝；`F03.3 通过` 两层调用返回及受控无限循环的真实 Guest 错误、事务回滚和后续恢复 | 通过 | 引擎或 Guest 管线改动时重跑控制流 Guest 回归，并保留错误目标拒绝测试 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[控制流 Guest 验收](VISUAL_NOVEL_CONTROL_FLOW_NATIVE.md)、[引擎](VISUAL_NOVEL_ENGINE.md) |
| F04 | `F04.1 通过` save/session/persistent 生命周期与 newGame 重置；`F04.2 通过` 旧档迁移、meta 优先和持久值不倒退；`F04.3 通过` Editor 声明/default JSON 的撤销、保存、重开；`F04.4 通过` 同核心执行、读档/回退与新游戏保留范围 | 通过 | 将旧档兼容样本继续纳入每次 save format 变更验收 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[变量生命周期](VISUAL_NOVEL_VARIABLE_LIFETIMES.md)、[存档格式](VISUAL_NOVEL_SAVE_FORMAT.md) |
| F05 | `F05.1 通过` auto 与已读跳过；`F05.2 通过` 配音完成事实驱动推进；`F05.3 通过` 未读/选择和暂停时停止或恢复 | 通过 | 后续改动继续用完整真实音频路线确认完成事件而非仅验证 RPC | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[语音](VISUAL_NOVEL_VOICE.md) |
| F06 | `F06.1 通过` auto/quick/manual slot 的真实文件恢复；`F06.2 部分验收` slot 管理、copy/move/swap/delete 与 quick load；`F06.3 部分验收` 原生截图缩略图（macOS Profile、Android Profile emulator、iOS Debug simulator 保存/覆盖/清理、同资源宽度变化、宿主重建后预览和读档六项检查通过）；`F06.4 待运行验收` Windows 与物理设备仍无目标证据 | 部分验收 | 在 Windows 和物理设备补同一存读/整理路线；另验收 OS 旋转/窗口变化、OS 进程重启、后台切换、性能和外部纹理场景 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[slot](VISUAL_NOVEL_SLOTS.md)、[存档格式](VISUAL_NOVEL_SAVE_FORMAT.md) |
| F07 | `F07.1 通过` 回滚和已读状态基本回归；`F07.2 部分验收` 396b 实际 Guest 旧档 load 与 rollback 对照完整 variables/stage/audio intent 通过；`F07.3 部分验收` 同一 last_train 路线解锁→旧档load→rollback→再解锁→replay，四类非空进度集合不回退、主auto JSON不变且无额外写请求 | 部分验收 | v5 f40f Guest 已补验非空 record_seal:true，在旧档/回滚/重播中保留；四类进度集合及主auto写入隔离也通过。其它目标/完整流程仍待验，NativeSession注入storage不证明host磁盘持久化 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[引擎](VISUAL_NOVEL_ENGINE.md)、[变量生命周期](VISUAL_NOVEL_VARIABLE_LIFETIMES.md)、[跨操作原生验收](VISUAL_NOVEL_ROLLBACK_META_ACCEPTANCE.md) |
| F08 | `F08.1 通过` 音乐解锁、试听及原 BGM 暂停/恢复；`F08.2 部分验收` CG/鉴赏体验与 replay 隔离主线存档；`F08.3 待运行验收` Windows 和物理设备音频/回放 | 部分验收 | 在 Windows 与至少一台物理手机执行试听、后台恢复和 replay 前后主线存档比较 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[鉴赏回放](VISUAL_NOVEL_GALLERY_REPLAY.md)、[音频混音](VISUAL_NOVEL_AUDIO_MIX.md) |

## Editor 创作与工程工作流（E01–E10）

| ID | 可追踪子项及状态 | 组状态 | 下一可执行动作 | parity / 证据 |
| --- | --- | --- | --- | --- |
| E01 | `E01.1 通过` structured story 编辑、保存/重开、pinned buildGuest 与 Native Guest 执行；`E01.2 通过` 新增/编辑/复制/重排/删除、撤销/重做、保存重开、pinned buildGuest 与真实 NativeSession 输入执行 | 通过 | Editor instruction CRUD/history 变化时重跑全流程并保留 story/QJBC/PAK 指纹 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[Editor](VISUAL_NOVEL_EDITOR.md)、[authoring](VISUAL_NOVEL_AUTHORING.md)、[工作流验收](VISUAL_NOVEL_EDITOR_INSTRUCTION_WORKFLOW.md) |
| E02 | `E02.1 通过` 同一 story 文档中 jump/call/branch/choice/timeout 连接编辑；`E02.2 通过` undo、保存重开、buildGuest 和指针新路线；`E02.3 通过` 自由label节点画布、拖动/端口连线、平移缩放/定位、布局历史与保存重开及pinned Guest实际输入；`E02.4 部分验收` 六类可执行章节蓝图：创建/路由/历史/保存重开与pinned Guest双分支通过，元数据消融一致 | 部分验收 | 补代码表达式节点、扩展策略、章节预处理和折叠分组；条件与选项目前是既有JSON schema编辑 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[Editor](VISUAL_NOVEL_EDITOR.md)、[章节蓝图](VISUAL_NOVEL_CHAPTER_BLUEPRINT.md) |
| E03 | `E03.1 通过` Pocket VN 文本与 Block 无损往返及稳定 ID；`E03.2 通过` 草稿冲突、导入/导出、撤销、保存重开；`E03.3 通过` 修改文本后 pinned Guest 与真实指针输入 | 通过 | 变更 interchange 格式时继续测所有 opcode、metadata 与稳定 ID 往返 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[文本互换](VISUAL_NOVEL_INTERCHANGE.md) |
| E04 | `E04.1 通过` 同核心 debug preview；`E04.2 部分验收` 主线/声明回放/有效章节入口独立执行，选择/输入停等、继续、wait与预算已验，默认不继承未执行前文；`E04.3 部分验收` 当前对白/结局及已提交背景/层/角色配置来源可定位，完整动画/native来源仍缺 | 部分验收 | 扩展动画/音频/native来源检查；章节依赖须实际执行或显式初始化；保持当前路径事实与未执行分支的区别 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[上下文验收](VISUAL_NOVEL_CONTEXT_PREVIEW.md)、[独立入口](VISUAL_NOVEL_CONTEXT_ENTRY.md)、[Editor](VISUAL_NOVEL_EDITOR.md) |
| E05 | `E05.1 通过` 暂停、单步、断点和变量事实；`E05.2 通过` 实际执行提交后产生的有界 OP 时间轴 | 通过 | 保留断点前停止、失败事务丢弃、双observer重入FIFO、200条上限及源码定位回归；默认无订阅不分配逐OP记录，存档格式不变 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[执行记录](VISUAL_NOVEL_DEBUG_TRACE.md)、[Editor](VISUAL_NOVEL_EDITOR.md) |
| E06 | `E06.1 通过` 背景/角色/音频/CG/模型 registry 编辑；`E06.2 通过` Spine model/texture 映射 CRUD；`E06.3 待运行验收` 缺资源与无效条件的可定位诊断覆盖 | 部分验收 | 对每类 registry 各保存一个坏引用，确认错误定位到具体 story/asset 字段且不会生成有效 Guest | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[Editor](VISUAL_NOVEL_EDITOR.md)、[Spine](VISUAL_NOVEL_SPINE.md) |
| E07 | `E07.1 通过` 静态舞台拖动、均匀缩放、旋转、层级、撤销/重做和重开；`E07.2 通过` buildGuest 后验证 image/textureTriangle 几何与绘制顺序；`E07.3 部分验收` 官方 Spine 动作/skin 舞台预览、变换编辑、保存重开及 buildGuest→真实 NativeSession 输入/三角形几何通过；Live2D 浏览器舞台预览仍不支持 | 部分验收 | 若 E07.3 覆盖 Live2D，接入真实可用的原生预览 host 后再验角色变换；当前 Spine 结果不代表 Live2D 或整个子项通过 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[舞台编辑](VISUAL_NOVEL_STAGE_AUTHORING.md)、[Spine stage preview](VISUAL_NOVEL_STAGE_SPINE_PREVIEW.md) |
| E08 | `E08.1 通过` 32 步撤销/重做、分组、workspace 草稿持久化；`E08.2 通过` 服务重启、冲突版本拒绝与失败保存后的草稿恢复；`E08.3 待实现` 通用 UI 文档历史；`E08.4 部分验收` 二进制素材沿用完整备份，不具备同一历史栈版本追踪 | 部分验收 | 先接入 UI 文档变化到同一可持久化 history，再验证素材 revision 与源码版本可一起恢复 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[历史](VISUAL_NOVEL_HISTORY.md)、[备份](VISUAL_NOVEL_BACKUPS.md) |
| E09 | `E09.1 通过` 本地完整备份、SHA-256、恢复点、去重、保留上限和定期调度；`E09.2 待实现` 云端/外部存储目标的真实上传、验证和恢复 | 部分验收 | 选定真实可用的外部存储 provider，走一次上传、损坏拒绝、恢复前保存恢复点及还原 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[备份](VISUAL_NOVEL_BACKUPS.md) |
| E10 | `E10.1 待实现` VN 项目 Git init/commit/branch/pull 工作流；`E10.2 待实现` 多客户端实时编辑；`E10.3 待实现` 具有可审阅冲突和不丢改动的合并 | 待实现 | 先定义真实项目文件的 Git 冲突场景，用两个客户端编辑同一稳定 ID 并保留双方可恢复改动 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[研究基线](VISUAL_NOVEL_RESEARCH.md) |

## 舞台、动画、场景与媒体（S01–S11）

| ID | 可追踪子项及状态 | 组状态 | 下一可执行动作 | parity / 证据 |
| --- | --- | --- | --- | --- |
| S01 | `S01.1 通过` 背景/角色/表情/位置尺寸与场景切换；`S01.2 通过` 保存与回滚共用舞台状态 | 通过 | story 结构或舞台状态变更时保留场景切换及 load/rollback 回归 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[舞台变换](VISUAL_NOVEL_SCENE_TRANSFORMS.md) |
| S02 | `S02.1 通过` 多层背景/视差的SDK、Editor及真实Guest/Flutter截图闭环；`S02.2 部分验收` 独立对象矩形裁剪、contain宽高比、图层与共享相机几何已验，任意蒙层仍缺；`S02.3 部分验收` 可选物件在对白中用既有变量事务交互，Editor编辑/拖动/历史/保存重开→pinned Guest真实命中已验，区别于choice热点；Lantern两种尺寸原生输入及macOS Profile图片/点击/存档隔离通过 | 部分验收 | 补任意路径/alpha蒙层及alpha命中；在手机与Windows执行同一对象流程，保留当前矩形裁剪和保存兼容回归 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[场景物件](VISUAL_NOVEL_SCENE_OBJECTS.md)、[像素验收](LANTERN_PARALLAX_FLUTTER.md)、[choice surfaces](VISUAL_NOVEL_CHOICE_SURFACES.md) |
| S03 | `S03.1 通过` camera 平移/缩放/确定性震屏及 save/rollback；`S03.2 通过` Editor 表单和 reduceMotion QJBC 目标取景；`S03.3 待实现` 滤镜与景深；`S03.4 待运行验收` 最终 Guest 制品的目标平台 A/B | 部分验收 | 先实现共享 scene 的滤镜/景深最小编辑闭环；随后以最终制品逐目标验证 camera 与 HUD | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[camera](VISUAL_NOVEL_CAMERA.md)、[camera Editor](VISUAL_NOVEL_CAMERA_EDITOR.md) |
| S04 | `S04.1 通过` 多轨 camera/actor/audio cue/gain 预设、Editor 表单/标记拖拽/键盘、取消/撤销/保存重开→pinned Guest；邻帧仅1ms时可正确再次拖动；`S04.2 部分验收` 一个 engine tick 承载镜头/角色/音效/音量，232 SDK/29剧情、八项Native、macOS四检查点、Android emulator时间线7/reduceMotion4检查点通过，reduceMotion终点投影保持真实存档/时钟/音频，空间选项按投影camera实际命中；采样级同步及其它平台仍待验；`S04.3 通过` 同预设复用、取消/结束清理、save/load/rollback、cut消融；默认投影路径无分配，无第二时钟/缓存；SDK内部音效/预览/语音声道禁止作为gain目标 | 部分验收 | 在 iOS/Windows 和物理设备最终包复验，整游戏性能另测 | [多轨时间线](VISUAL_NOVEL_TIMELINE.md)、[音量包络](VISUAL_NOVEL_AUDIO_ENVELOPES.md)、[拖拽/减少动态效果](VISUAL_NOVEL_TIMELINE_ACCESSIBILITY.md) |
| S05 | `S05.1 通过` fade/dissolve 双纹理场景混合；`S05.2 部分验收` 四向 reveal 的 SDK/Editor/Native 与 macOS Profile 画面通过，其它风格化效果仍缺；`S05.3 部分验收` 中断/cut、pause/skip、save/load/rollback 与结束清理有引擎及 Native 证据，跨平台最终包仍待验 | 部分验收 | 用最终制品在 iOS/Android/Windows 复跑同场景；补其它风格化效果与平台帧时/内存，不能用几何通过替代性能 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[方向转场](VISUAL_NOVEL_REVEAL.md)、[视频/转场](VISUAL_NOVEL_VIDEO.md) |
| S06 | `S06.1 通过` 单网格雨滴、共享雾纹理和低亮度闪电；`S06.2 通过` Editor 背景绑定、strength/flash 和资源打包；`S06.3 待运行验收` 最终包画面、pause/resume 与释放；`S06.4 待实现` 碰撞、环境音和通用粒子编辑 | 部分验收 | 在最终 Guest 制品上测暂停/恢复/离场的雨雾绘制和资源释放；之后补一项可编辑粒子碰撞或音频行为 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[天气](VISUAL_NOVEL_ATMOSPHERE.md)、[性能](VISUAL_NOVEL_PERFORMANCE.md) |
| S07 | `S07.1 通过` 官方 Spine 加权网格真实变形；`S07.2 待实现` 通用部位编辑/继承；`S07.3 待运行验收` 关键帧变化与人物部位组合在实际模型中的结果 | 部分验收 | 用同一 Spine 项目编辑一个部位差分，保存后运行不同关键帧并比较真实 mesh 输出 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[Spine](VISUAL_NOVEL_SPINE.md) |
| S08 | `S08.1 通过` Spine skin 切换保持动作相位；`S08.2 待实现` PSD 导入；`S08.3 待实现` 立绘预制包及差分组合；`S08.4 待运行验收` 分辨率变化后的角色位置/裁切 | 部分验收 | 先定义带许可清单的原创分层立绘输入，验 PSD/差分组合及 390/1920 宽布局位置 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[Spine](VISUAL_NOVEL_SPINE.md) |
| S09 | `S09.1 通过` Spine/Live2D 真实变形、动作和原生生命周期；`S09.2 部分验收` 官方 Hiyori 原始 2048²、v4 四组 DPR 1/2 test-view Profile 矩阵及脸宽数值门槛已通过；全身构图质量、更多模型状态和其它平台仍待验；`S09.3 部分验收` Spine 浏览器舞台姿态预览已通过，完整 Cubism 兼容、Live2D 舞台预览和序列帧仍缺失；`S09.4 待运行验收` Windows、物理设备与目标构图复验 | 部分验收 | 逐图核验 full-body 遮挡/构图，再在 Windows 与物理设备复验内存、动作和 viewport；保留 Live2D 舞台宿主与序列帧缺口 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[Live2D](VISUAL_NOVEL_LIVE2D.md)、[Spine stage preview](VISUAL_NOVEL_STAGE_SPINE_PREVIEW.md)、[DPR证据](VISUAL_NOVEL_MODEL_DENSITY.md)、[v4验收](LANTERN_V4_ACCEPTANCE.md) |
| S10 | `S10.1 通过` macOS 真实解码、静音、pause/seek、quick-save 恢复、回滚释放、自然结束、关闭；`S10.2 待运行验收` iOS/Android/Windows/物理设备最终包视频链路 | 部分验收 | 用最终制品逐目标复跑同一 3 秒 clip，断言位置恢复、自然结束不推进剧情及关闭释放 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[视频](VISUAL_NOVEL_VIDEO.md) |
| S11 | `S11.1 通过` scene hotspot/dial 映射已有 choice ID、Editor 保存/撤销/重开和 NativeSession 命中；`S11.2 待运行验收` Flutter 图片解码、焦点及真实触屏；`S11.3 通过` 窄屏/长选项退回列表。通用对象点击/碰撞属于 S02，不计作 S11 已实现能力 | 部分验收 | 在 macOS 与物理触屏设备检查拨盘图片解码、焦点及目标 choice；保留窄屏列表回退断言 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[choice surfaces](VISUAL_NOVEL_CHOICE_SURFACES.md) |

## 文本与音频（T01–T02、A01–A04）

| ID | 可追踪子项及状态 | 组状态 | 下一可执行动作 | parity / 证据 |
| --- | --- | --- | --- | --- |
| T01 | `T01.1 部分验收` 单正文标量范围、语义颜色/strong、同一Core叶节点及Editor范围编辑；`T01.2 部分验收` Core注音、预留行高和完整base显隐通过，初版仅CJK/Latin简单排版；`T01.3 部分验收` 定时/手动局部停顿、内部注记链接及多行命中通过，外部动作链接未实现；`T01.4 部分验收` V4池化保存、历史/回滚/locale范围与占位符边界、真实注记输入及原存档隔离通过 | 部分验收 | 补译文范围可视化编辑、重叠/复杂文字排版及目标平台最终包验证；长段paint切片/复制热路径须实测后优化，不把measure-cache消融充当整游戏性能通过 | [富文本实现与验收](VISUAL_NOVEL_RICH_TEXT.md)、[Core/重建证据](INLINE_TEXT_IMPLEMENTATION.md) |
| T02 | `T02.1 通过` 全屏段落与实际窄屏滚动；`T02.2 通过` 浮动文字、普通对白及回溯几何；`T02.3 通过` Editor 模式切换/undo/redo/保存重开、pinned Guest 实际输入 | 通过 | 保留中英文329×600/DPR2与1280×900/DPR1四组Profile、20张PNG及主线存档隔离；自由位置/自定义主题不在此三种预设能力内 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[样式与Editor](VISUAL_NOVEL_SAY_PRESENTATION.md)、[Flutter验收](LANTERN_LETTER_SHOWCASE_FLUTTER.md)、[locale消融](VISUAL_NOVEL_LOCALE_CHECKPOINT_ABLATION.md) |
| A01 | `A01.1 通过` music/SFX/voice 分组增益及实际恢复；`A01.2 部分验收` 环境音及自定义声道当前归 SFX，需明确并验证独立控制语义；`A01.3 通过` Editor 单句 voice cue；`A01.4 待运行验收` Windows 与物理设备播放/生命周期 | 部分验收 | 先确认并实测环境音是否必须有独立音量组；再在 Windows 和物理设备播放 BGM、环境声、SFX 与 voice 并检查位置恢复 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[音频](VISUAL_NOVEL_AUDIO.md)、[音频混音](VISUAL_NOVEL_AUDIO_MIX.md) |
| A02 | `A02.1 通过` loop 与 volume transport；`A02.2 部分验收` 调音量不重播、原生正进度已验，采样连续性未证；`A02.3 部分验收` 可编辑双音乐轨交叉淡化，macOS/Android模拟器Profile及iOS模拟器Debug真实WAV通过 | 部分验收 | 完成iOS Profile/release、Windows、真机与听音；记录真实切换及释放边界，不将采样position视为单调JS时钟 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[跨曲证据](VISUAL_NOVEL_CROSSFADE.md) |
| A03 | `A03.1 通过` 稳定行 ID 单句 voice cue、Editor 绑定/清空、重听和完成等待；`A03.2 待实现` 全章配音管理；`A03.3 待实现` 录音/语音识别与台词匹配 | 部分验收 | 先补一个按稳定 ID 批量导入/校对整章配音的可回退工作流；录音识别需用真实输入/服务另验 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[语音](VISUAL_NOVEL_VOICE.md) |
| A04 | `A04.1 通过` 按角色短音配置和 45 ms 合成 WAV 的真实播放/重播；`A04.2 通过` Editor 间隔、引用和保存重开；`A04.3 待实现` 波形编辑/可视化触发密度；`A04.4 待运行验收` Windows 与物理设备播放/背压 | 部分验收 | 加一个实际 WAV 波形与逐字触发密度编辑/预览用例，再在 Windows 与物理手机验真实音频队列 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[拟声](VISUAL_NOVEL_GLYPH_AUDIO.md)、[语音](VISUAL_NOVEL_VOICE.md) |

## 游戏 UI、输入与本地化（U01–U04、L01–L02）

| ID | 可追踪子项及状态 | 组状态 | 下一可执行动作 | parity / 证据 |
| --- | --- | --- | --- | --- |
| U01 | `U01.1 通过` 壳、菜单、设置、日志、CG、存档和图片皮肤 registry；`U01.2 部分验收` 皮肤尚需逐项核对扉页/对白/选择/手札/设置/存读档/日志/鉴赏八类界面及按下/禁用/聚焦态；`U01.3 通过` Native 键盘/触控；`U01.4 待运行验收` 手柄和物理设备 | 部分验收 | 按八类界面逐张记录实际屏幕图和所有按钮状态，以中英文检查截断；再用手柄设备操作同一菜单 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[皮肤](VISUAL_NOVEL_SKIN.md)、[响应式](VISUAL_NOVEL_RESPONSIVE.md) |
| U02 | `U02.1 待实现` VN 控件树/自由布局设计器；`U02.2 待实现` 控件数据绑定和可视化编辑；`U02.3 待运行验收` 设计结果与游戏运行 UI 一致；单张 frame skin 表单不计作 UI designer | 待实现 | 先以同一 story/runtime schema 设计最小控件树和 data binding 原型，完成编辑→撤销→保存重开→Guest 绘制闭环 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[研究基线](VISUAL_NOVEL_RESEARCH.md) |
| U03 | `U03.1 部分验收` 固定 UI 已存在；`U03.2 待实现` UI 分层入场/退场主题；`U03.3 待实现` 等待指示和可配置动画；`U03.4 待运行验收` save/load/overlay 恢复与减少动态效果 | 部分验收 | 给一个非模态 overlay 设定主题和入退场，检查等待态、save/load 与 reduce-motion 下界面恢复 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[响应式](VISUAL_NOVEL_RESPONSIVE.md) |
| U04 | `U04.1 通过` text/number/boolean 输入、Editor 配置、取消边和 typed commit；`U04.2 通过` draft save/load/rollback 与 composing/IME Done 行为；`U04.3 待实现` 独立系统确认消息；`U04.4 待运行验收` 物理 IME 与 Windows 输入 | 部分验收 | 先接入一条系统确认消息并验证变量未提交/确认后才提交；随后用物理手机和 Windows IME 操作长输入 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[输入](VISUAL_NOVEL_INPUT.md)、[输入验收](VISUAL_NOVEL_INPUT_ACCEPTANCE.md) |
| L01 | `L01.1 通过` 英文目录、玩家 UI、语言切换和 locale save rebase；`L01.2 部分验收` fallback/缺译诊断与独立本地化图片尚需全链路；`L01.3 待运行验收` 物理手机与 OS 旋转后的中英文/图片布局 | 部分验收 | 加一张 locale-specific image 注册并切换中英文，在物理手机检查长文本、fallback 和资源选择 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[本地化](VISUAL_NOVEL_LOCALIZATION.md) |
| L02 | `L02.1 通过` 单一 locale catalog、稳定字段编辑、缺译/占位符检查及 CSV/集合导入导出；`L02.2 通过` Pocket text/CSV/Markdown 结构化往返；`L02.3 待实现` AI 翻译工作流 | 部分验收 | 先用外部服务或本地受控 provider 实现可审阅 diff 的 AI 翻译草稿，再验证稳定 ID 和占位符不变 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[本地化](VISUAL_NOVEL_LOCALIZATION.md)、[互换格式](VISUAL_NOVEL_INTERCHANGE.md) |

## 文件导入导出、项目数据与扩展（I01–I02、D01、X01–X04）

| ID | 可追踪子项及状态 | 组状态 | 下一可执行动作 | parity / 证据 |
| --- | --- | --- | --- | --- |
| I01 | `I01.1 部分验收` 普通文本解析已实测，Excel/Word/文字 PDF 尚缺；`I01.2 部分验收` 文本源行/说话人预览、坏编码/同名拒绝、确认和原文保留已验，办公/PDF字段映射尚缺 | 部分验收 | 选真实 XLSX 和 DOCX 样例，补其解析和可审阅字段映射，不把文本导入证据扩大到其他格式 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[手稿导入](VISUAL_NOVEL_MANUSCRIPT.md) |
| I02 | `I02.1 通过` JSON、Pocket text、结构化 CSV/Markdown 语义往返；`I02.2 部分验收` 友好表格列编辑：对白表格的筛选/25行分页、角色/正文列编辑及同源Guest闭环通过；友好CSV v2列编辑、缺失/空值保留及同源Guest闭环通过；通用十五类常用字段/复杂 JSON 表格及同源 Guest 闭环通过；结构性模式与缺省字段创建沿用完整表单；`I02.3 待实现` Ren'Py 导出；`I02.4 通过` Word DOCX 审阅稿：未保存草稿只读导出；系统原生读取、113页全文/版面及真实编辑器→Guest闭环通过 | 部分验收 | 表格保留原脚本/locale；继续补 Ren'Py 及完整结构化字段工作流；DOCX 是脚本审阅稿，不代表 Word 导入或全部格式完成 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[互换格式](VISUAL_NOVEL_INTERCHANGE.md) |
| D01 | `D01.1 通过` 同一 story.inventory 的货币、商品、价格与数量变量 schema；`D01.2 部分验收` 图片行囊、剧情买卖/使用/拒绝及辞典档案 native 交互通过；`D01.3 部分验收` Editor CRUD/交易表单/撤销重做/保存重开→同一buildGuest→native 交易、读档/回退/新局通过 | 部分验收 | 补当前 v6 普通 Flutter 窗口及宿主磁盘/平台验收；保持已过功能证据，不用注入storage或Editor截图替代 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[库存与交易](VISUAL_NOVEL_INVENTORY.md)、[共享档案](VISUAL_NOVEL_COLLECTIONS.md) |
| X01 | `X01.1 部分验收` 仅有核心 API；`X01.2 待实现` 有类型的公开扩展方法/设置/Hook/Slot 声明；`X01.3 待运行验收` 扩展示例生命周期与存档版本 | 待实现 | 先设计一项带类型声明、配置字段和存档版本的自定义 command extension，并运行正常/错误加载流程 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md) |
| X02 | `X02.1 待实现` 动态扩展检查器；`X02.2 待实现` 可编辑扩展 UI 与资源声明；`X02.3 待实现` Editor/runtime 共用隔离及失败诊断 | 待实现 | 在 X01 示例上实现同一声明驱动的 Inspector 字段和 runtime provider，再验隔离错误定位 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md) |
| X03 | `X03.1 待实现` VN MCP/AI 工程工具接入；`X03.2 待实现` 读取、写入、校验同一 story；`X03.3 待实现` 变更差异审阅和拒绝路径 | 待实现 | 先暴露只读 story 查询与 diagnostics，再用一次 Agent 修改演练展示差异、校验和可回退提交 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[市场调研](VISUAL_NOVEL_RESEARCH.md) |
| X04 | `X04.1 待实现` 扩展工坊/资源库安装、更新、移除；`X04.2 待实现` 资源来源/许可/归属；`X04.3 待实现` 构建按引用清理未使用资源 | 待实现 | 定义 package manifest 与来源许可字段，用可卸载测试扩展验证安装/更新/移除及 PAK 资源集合 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md) |

## 构建、发行平台与无障碍（P01–P06）

| ID | 可追踪子项及状态 | 组状态 | 下一可执行动作 | parity / 证据 |
| --- | --- | --- | --- | --- |
| P01 | `P01.1 通过` pinned buildGuest 完整游戏和三结局输入；`P01.2 通过` Editor 修改后重建并运行；`P01.3 待运行验收` 源位置诊断、资源错误定位与源/制品一致性逐项对照 | 部分验收 | 对一条 Editor 修改故事生成 source map/manifest 诊断样例，按源定位修正资源后重建并比较 Guest/PAK 来源 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[Editor](VISUAL_NOVEL_EDITOR.md)、[游戏](VISUAL_NOVEL_GAME.md) |
| P02 | `P02.1 通过` macOS 完整 GUI、键盘、像素、存档、动画和音频；`P02.2 通过` iOS/Android 完整模拟器路线；`P02.3 待运行验收` Windows 实际安装执行；`P02.4 待运行验收` Web target；`P02.5 待运行验收` iOS/Android 物理设备及其 IME/音频/生命周期 | 部分验收 | 先在 Windows runner 执行完整游戏路线并保存日志，再确认 Web target 的实际支持/失败；两者均不能被模拟器结果替代 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[平台](VISUAL_NOVEL_PLATFORMS.md) |
| P03 | `P03.1 待实现` Steam achievements/statistics；`P03.2 待实现` cloud saves；`P03.3 待实现` DLC/overlay 的真实平台 SDK 接入和允许环境验证 | 待实现 | 用真实 Steam 测试应用/沙盒账号完成一次成就、云档上传恢复和 overlay 往返；不得用固定成功响应 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[市场调研](VISUAL_NOVEL_RESEARCH.md) |
| P04 | `P04.1 待实现` 云端工程分享/协作分发；`P04.2 待实现` 玩家/创作者统计；`P04.3 待实现` 实际后端持久读写与权限 | 待实现 | 定义真实云项目分享和事件 schema，以两个授权客户端执行分享、更新、拒绝和统计查询 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md) |
| P05 | `P05.1 部分验收` Pocket 有通用录制能力，但 VN 流程未验；`P05.2 待实现` VN 片段选择/管理；`P05.3 待运行验收` 带声音文件输出及应用后台/恢复 | 待实现 | 用实际 VN Guest 录一段对白/音乐/视频操作并导出可播放文件，检查音画同步、后台恢复和文件归属 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md) |
| P06 | `P06.1 部分验收` 六种约束尺寸、1920px 菜单目标、iPad 屏幕尺寸约束及安全区已有部分证据；`P06.2 部分验收` macOS 实际窗口尺寸变化已验；OS 旋转仍待验；`P06.3 待运行验收` Windows 与物理设备；`P06.4 待运行验收` 手柄导航和可访问性标签/焦点/减少动画完整审计 | 部分验收 | 在物理 iPad/手机执行 OS 旋转与 IME 后逐项测控件越界；另用手柄完成菜单、选择、日志和设置路线 | [矩阵行](VISUAL_NOVEL_LETSGAL_PARITY.md)、[响应式](VISUAL_NOVEL_RESPONSIVE.md)、[坐标 sidecar](INPUT_COORDINATE_SIDECAR.md) |

## Goal 级跨组门槛（不新增或替换 54 个 ID）

这些门槛仍属于 [Goal](VISUAL_NOVEL_GOAL.md) 的完成条件，不能因为逐组有证据而跳过。

| 门槛 | 当前状态 | 下一可执行动作 | 依据 |
| --- | --- | --- | --- |
| 主线内容：≥200 条主线 say、≥8,000 中文叙事字符、≥12 个改变后续状态的决策、≥2 种真实可交互解谜、三条结局路线实玩 | 部分验收：当前 v4 story SHA `aa21d89c…`，主线闭包 218 条 say / 9,961 汉字；v4 NativeSession 三结局/画廊路线 1/1、v1/v2/v3 迁移 3/3。12 节点因果表已核验，两类谜题有自动输入证据；人工体验与可回看全路线记录待补 | 保留 12 节点因果表与 v4 Guest 日志，继续记录三路线完整游玩画面并检查叙事连贯性 | [Goal](VISUAL_NOVEL_GOAL.md)、[v4验收](LANTERN_V4_ACCEPTANCE.md)、[parity](VISUAL_NOVEL_LETSGAL_PARITY.md) |
| 玩家可发现性：扉页 ≤3 次选择进入、首轮 ≤5 分钟主动触达 8 类能力 | 部分验收：v3 扉页一次点击进入，8 类 Guest 交互自动路线通过（巡演4项，约2.65秒驱动）；包含自然结局解锁CG并滚动到实图。自动驱动不替代首次玩家5分钟阅读/发现，视频/音频真实播放与Live2D Core也另验 | 对首次玩家做无提示计时，记录每类能力的首次主动触达步骤；调整扉页入口后再次计时 | [Goal](VISUAL_NOVEL_GOAL.md) |
| 模型画质：Spine/Live2D 各 ≥3 个状态；Hiyori 2048²、DPR 1/2 像素检查、全身/近景阈值和无遮挡 | 部分验收：v4 test-view 四矩阵通过；近景脸宽 114/115/142/142.5 逻辑 px，阈值达标；全身构图、所有状态、物理设备与全平台未验 | 逐图核验全身动作是否被菜单/对白遮挡，再在物理设备测完整模型状态、内存和 viewport | [Goal](VISUAL_NOVEL_GOAL.md)、[DPR证据](VISUAL_NOVEL_MODEL_DENSITY.md)、[v4验收](LANTERN_V4_ACCEPTANCE.md)、[模型渲染](VISUAL_NOVEL_MODEL_RENDERING.md) |
| 八类 UI 图片皮肤、可点按钮状态及中英文不截断 | 待运行验收：皮肤 registry/view 链路存在，仍需逐屏截图对照并覆盖 focus/press/disabled。parallax 三截图中 `已读跳过` 四字的 glyph mask 完全一致，排除了此前视觉复核的缺字判断；这不代表全 UI 通过 | 对扉页、对白、选择、手札、设置、存读档、日志、鉴赏逐项保存中文/英文截图及输入结果 | [Goal](VISUAL_NOVEL_GOAL.md)、[皮肤](VISUAL_NOVEL_SKIN.md)、[响应式](VISUAL_NOVEL_RESPONSIVE.md)、[视差像素验收](LANTERN_PARALLAX_FLUTTER.md) |
| ≥10 类 Editor 工作流完成编辑→undo/redo→保存→重开→buildGuest→真实 Guest 输入 | 部分验收：若干 authoring/registry/stage/camera/audio/input/import 组合已有证据，通用 UI 设计器和全类别计数缺失 | 逐类别建验收矩阵，第一轮先闭合现有 10 类而非以表单数量代替工作流数 | [Goal](VISUAL_NOVEL_GOAL.md)、[Editor](VISUAL_NOVEL_EDITOR.md) |
| macOS/Windows/iOS/Android、物理手机、六种 viewport、安全区及 OS 旋转/窗口变化 | 部分验收：macOS 和 iOS/Android 模拟器有完整路线，Windows/物理设备/OS 级变化仍待验 | 安排 Windows 真实运行与一台 iOS、一台 Android 物理设备测试；保留 360×800 至 2560×1440 六种尺寸和 OS 级旋转记录 | [Goal](VISUAL_NOVEL_GOAL.md)、[平台](VISUAL_NOVEL_PLATFORMS.md)、[响应式](VISUAL_NOVEL_RESPONSIVE.md) |
| 60 Hz 性能：build P95 ≤12 ms、raster P95 ≤8 ms、>16.67 ms 帧 ≤1%；冷启动桌面 ≤3s/手机 ≤5s，各 3 次 | 部分验收：Painter 单方法微基准已有实测；当前 macOS 模型 build P95 12.957–14.536 ms、超预算1.803%，RSS门槛也失败，端到端目标未达 | 用 release/profile 同一最终制品测模型、天气、文本、菜单各 ≥5 个 10s 窗口并记录设备/帧数；另做三次冷启动 | [Goal](VISUAL_NOVEL_GOAL.md)、[性能](VISUAL_NOVEL_PERFORMANCE.md) |
| 生命周期与内存：20 次模型进退、handle/时钟/音频归零、驻留增长 ≤10% 且 ≤20 MiB | 待运行验收：有释放/重入功能回归，缺完整循环和内存曲线 | 对相同制品执行 20 次进入/退出，记录前 5 次基准中位数、之后稳定驻留值、峰值及退出 handle 数 | [Goal](VISUAL_NOVEL_GOAL.md)、[Live2D 动态](VISUAL_NOVEL_LIVE2D_DYNAMICS.md) |
| SDK 消融：同制品/场景/设备单变量 A/B，功能/像素/输入回归保持 | 部分验收：painter hash 删除的真实 `shouldRepaint` 微基准已记录；整游戏性能波动和其余候选需逐项归因 | 每个候选记录代码差异、before/after hash、设备、单变量、语义/像素/输入回归和端到端窗口；未改善就撤回 | [Goal](VISUAL_NOVEL_GOAL.md)、[性能](VISUAL_NOVEL_PERFORMANCE.md) |

## 推进规则

1. 先做 `待实现` 子项的最小共享 schema/SDK/Editor 闭环；再对 `待运行验收` 项执行实际 Guest、服务、设备或外部平台动作。
2. 每次状态升级只更新新增证据对应的子项；保留早期 checkpoint、旧格式兼容及平台限制，不能用旧制品结果替代最终制品证据。
3. `通过` 只针对表内所列子项；54 组全通过也不能替代本节的 Goal 级故事、画质、UI、Editor、平台、性能和 soak 门槛。


2026-11-08 incremental evidence: [desktop scrolling](VISUAL_NOVEL_DESKTOP_SCROLL.md)
now passes actual pinned Guest and macOS Profile signal→JS→frame checks, including
nested input ownership and six-character opening regression. This is injected
input, not physical mouse/trackpad or OS-window/Retina acceptance. No group or
cross-group quality/performance gate is upgraded by this increment.


2026-11-08 further evidence: [native density/window](VISUAL_NOVEL_NATIVE_DENSITY.md)
passes actual macOS window sizes with one retained real Guest; P06.2 moves to
partial only (mobile OS rotation, physical drag/Retina remain missing).
[Delta-base resource ablation](VISUAL_NOVEL_DELTA_BASE_RESOURCE_ABLATION.md)
proves one 8 MiB Dart-side transient hold removed in a same-process native
fixture. Neither result passes the cross-group model-quality or RSS gate.


Latest ordinary Demo deployment includes candidate189ec94e's minimal transient
resource hold removal, with native8/8, controlled weak-reference A/B and actual
model-showcase Profile regression. Final normal-main app PID85465 is observed
foreground; Editor remains closed. Twenty-cycle stable-RSS is **not passed**:
the follow-up ended incomplete after harness/UI interruptions. Current model
build P95 observations13.369–14.328ms remain above12ms, and physical Retina /
visual-quality gates remain open. Full Goal scope and group totals are retained.


## Actual Idle0 official-renderer comparison

See [same-pose evidence](VISUAL_NOVEL_IDLE0_RENDER_COMPARISON.md). The actual
Profile Guest capture passed; both 2048² atlases and bounded 2× SSAA were active.
Official GL showed no obvious sharper facial detail in the controlled 1×
comparison. Raw dynamic-history flags and full triangle-key coverage retain
explicit limitations. No production quality fix or physical Retina acceptance
is claimed; the user-reported clarity issue remains open. Group totals and
the full Goal scope are unchanged.
