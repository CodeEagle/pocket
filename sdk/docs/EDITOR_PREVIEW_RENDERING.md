# Editor 网页绘制：圆角拼接与屏幕密度

## 渐变动画的稳定背景模糊复用（2026-11-05）

本轮继续复用 retained parent 的 `lib/render/pocket_ui_components.dart`
绘制资源复用原则，以及已有真实 Canvas backdrop blur。之前每个淡入、
淡出帧都重新执行全屏 DPR blur，即使变化的只有玻璃上方的 Dialog 和
合成透明度。现在只在原有 scratch Canvas 中保留最近一次滤波像素，
精确比较该 surface 前面的有序 DrawOps、资源 epoch、逻辑尺寸、backing
尺寸和 blur sigma；相同时只执行本帧的 clip、opacity 和 tint 合成。

背景操作、图片内容替换/释放或尺寸变化都会失效；前景面板的 scale/fade
不失效。此前出现过 video DrawOp 的背景每帧重算，因为解码帧可以在
DrawOps 不变时更新。没有 glass 的帧清除 key，预览关闭释放 scratch
像素。多 glass 顺序仍逐个采样实际已绘画面，单一 scratch 不能命中时
保守重算。没有降低 DPR 或 blur 分辨率，没有预开隐藏弹窗。

消融删除了试验中的 32-bit hash、四份历史快照、LRU 和第二套内存预算。
最终仅复用已有的一张 scratch，不存在颜色历史缓存。直接比较完整序列
避免 hash 碰撞误用背景。资源 epoch 是浏览器解码资源真实变更计数，
不是业务层的主题状态或弹窗状态副本。

`preview_glass_cache.test.ts` 使用真实 Chromium Canvas 检查：透明度变化
三帧只运行一次 blur，像素仍按进度混合；背景红蓝变红绿、相同 asset id
图片红变蓝、资源释放为白底、resize 均正确失效；video 前缀连续两帧
均重新滤波；整个流程只使用一个滤波目标，close 后尺寸归零。video
用未就绪 DrawOp 检查保守失效边界，真实视频解码由原有视频测试负责。
只通过环境变量改读 HEAD 旧 client 的负对照失败（两帧滤波 2 次而非
1 次），未覆盖生产文件。透明 blur/TEX_TRI/PSM5 像素回归也通过。

真实 Showcase 消融使用同一份新 QJBC（591,313 bytes）、release probe、
fresh Playwright Chromium，390×844 / DPR 2，UI → For → Close，首次和
再次打开各一次。旧 client 的入场分别有 12/13 次 blur，新版均为 4 次；
其余帧复用滤波结果。绘制调用均值约 6.65/6.45ms → 2.78/2.80ms，
中位数约 6.9/6.7ms → 0.45/0.40ms。剩余重算来自真实资源/背景变化。
这是一组本机同步 Canvas 调用观测，不是 GPU 完成时间或屏幕 FPS 保证。
两种 client 的关闭都保留多个单调递减中间 opacity，直到退出后才移除。

最终三个 Canvas 回归（blur cache、texture alpha/PSM5、tint）全部通过。
真实 idle-wake 与像素测试通过，五次原生弹窗循环在独立 Bun 进程通过。
循环测试的退出判据改为 glass surface 已释放：淡出的原生语义 Text 会
提前变成 glyph image，不能据此判断 Modal 已经卸载并点击下层按钮。
缩放检查与 native Dialog 测试一致，允许整数片段每边一像素的量化误差，
同时继续验证整体增长和逐帧 blur opacity 单调性。

## 反复切换主题的图片着色开销（2026-11-05）

保留父项目的 `mini_apps/syslib/pocket_syslib_pages.js` 主题/组件组合与
`shaders/liquid_glass.frag` 作为原有行为参考；父项目没有 Editor Canvas
投影，因此这里只适配现有 `sdk/editor/client/preview.js`，不复制布局或
业务状态。实际 PocketJS 仍负责主题动画并输出 DrawOps。

中间色原先每次都先 drawImage 再 getImageData，强制同步读取 Canvas，
且每张资源的着色 Map 永不淘汰。现在复用资源解码时的 CPU RGBA，保持
逐通道乘色语义，取消这次 GPU 读回。缓存采用最多 8 项的 LRU，同时按
纹理面积限制为约 1M 像素（单张超过预算时最多保留一项）。资源替换、
release 和预览关闭时释放原图与着色 Canvas。

真实 Chromium 的 `preview_tint.test.ts` 连续输入 80 种颜色，验证颜色
像素、缓存面积有界、无内部 getImageData、替换与释放后的缓冲清理。
消融时仅取消 LRU，保留面积由最多 9 像素变为 82，测试明确失败；仅
恢复 GPU 读回时，无读回断言失败。两个负对照均只使用临时脚本，没有
修改共享工作区的生产文件。该测试验证投影开销，完整主题交互另由真实
native guest 与浏览器输入测试验证。

静态资源转发同时保留 native revision 快路径；旧 provider 没有 revision
时先比较缓存的像素/调色板引用，只有不同数组才比较内容，不为每帧创建
两份 Uint8Array。重连仍发送完整资源，真实变化仍作为 delta 发送。

Editor 的每个 preview.frame 通知还会重发 preview.regions 设置。旧绘制
入口不检查设置是否改变，导致每帧多画一次完整 Canvas。现在只在开关值
真正变化时重画。Chromium 回归发送 80 次相同值，确认额外 clearRect/
整帧绘制次数为 0；切换值后无论重复多少次均只额外绘制一次。该去重位于
公共投影入口，未更改业务组件来减少通知或省略真实动画帧。

真实 Modal 回归还检出了另一处投影错误：`glass` 与 application surface
都带有 id/handle，旧合成器把 glass 当成未加载的 child 删除。现在读取
native descriptor 的 kind，仅将 application（或无 descriptor 的旧帧）
作为 child slot，glass/platformTexture 等保留原始绘制位置，交给已有
宿主投影处理。不能用没有 native id/handle 的合成图片测试代替该回归。

Native `build_frame` 的变化帧也移除了重复生成 DrawList：先各调用一次
官方 `draw()` / `draw_auxiliary()` 作缓存判断，变化时从官方已有的
`current_draw_list()` / `current_auxiliary_draw_list()` 取得同一份快照再
复制给解码器，命中时不复制。原有 DrawOps 解码、资源 revision、事件与
缓存失效条件保留，没有新增另一套 renderer。父项目
`native/pocket_runtime_multi.c` 的 frame/drawlist 边界也先行检查；该适配
使用当前 pinned PocketJS 的保留快照 API，没有修改上游绘制算法。

## 问题与路径

2026-11-04，Editor `8792` 的 Mini Apps 按钮出现横向细缝。网页绘制路径为 `preview.ts` 合成 native FrameResult，然后由 `client/preview.js` 投影到 Canvas2D。它不经过 Flutter 的 `pocket_view_painter.dart`，因此与 Android Impeller 的硬矩形 scissor 优化分别维护。

PocketJS 输出的圆角填充不是一个浏览器 rounded-rect：它由四个带 alpha 的角纹理和相同颜色的矩形条拼接。子应用帧可能从 `390×844` 映射到宿主 `390×788` 的 surface，此时纵向比例为 `788/844`，原来的整数边界成为分数坐标。Canvas 对每块独立计算像素覆盖率，拼接处可能露出背景。

只读对比确认了更上游的路径差异：Flutter 按 surface constraints 调整 child runtime viewport；Web preview 当时用根 viewport 创建和调整 child，之后再缩放。最终在 child viewport 层与原生行为保持一致，移除了按 DrawOps 猜测圆角组件并取整的浏览器补偿。

## 实现约束

- `preferredViewportSlots` 为同一 child 选择聚焦 surface，否则选择第一个可见 surface；`syncChildViewports` 按该区域尺寸调整 native child viewport。实际尺寸未变化时不发送 resize，隐藏 child 保留最后尺寸。child 的业务布局继续由 PocketJS 执行。
- resize 后必须 pump child，处理新布局与其产生的 host requests；后台可见 child 只执行 settle，不继续前台动画计时。
- 不在浏览器通过角纹理 UV、颜色、连续矩形猜测组件类型，不对全部 DrawOps 坐标取整。先前的局部圆角识别补偿已被删除，避免错误匹配 sprite 和改变半透明填充。
- 保留角纹理本身的透明度与滤波。不要用关闭全部图像平滑、删除 clip 或重新推算圆角形状的方式消除接缝。
- clip 仍来自 native DrawOps。输入区域同时受 native 十位坐标范围和 root viewport 约束；子应用从画布底部进入时，只能把已进入画布的区域暴露给输入。
- `renderCurrentFrame` 的 backing store 使用屏幕 DPR 的整数上取整作为统一 supersampling 因子；FrameResult、输入和截图协议仍用逻辑坐标。`setTransform` 只负责映射到 backing pixels。DPR 清晰度与 child viewport 修复是两个独立处理，不能把清晰度提升当作接缝修复的证据。
- 浏览器还可能把整个 iframe 按 CSS 比例缩放。屏幕截图与原始 canvas 像素是不同验收对象，排查时应同时记录逻辑尺寸、backing store 尺寸、CSS 尺寸和 DPR。

### 分数浏览器缩放的条带接缝（2026-11-06）

Chrome 页面缩放会让 `window.devicePixelRatio` 变成分数。旧投影按
`round(width * dpr)` 与 `round(height * dpr)` 分别生成 backing 尺寸；例如
390×844 在 DPR 1.8 下为 702×1519，使 x/y 变换比例不同（1.8 与
1.79976）。PocketJS 的圆角控件由同色的中间条和上下条 DrawOps 拼接，边界
落在不同 coverage 行时会露出暗横线；同一问题也会出现在输入框。

现在对整个逻辑帧使用 `ceil(devicePixelRatio)` 的单一整数 supersampling
因子（DPR 1.8 → 2，780×1688），再由浏览器对完成的 Canvas 栅格做一次缩放。
这保留了 DrawOps 的原始坐标、tile 纹理透明度和 native clip，没有关闭图像
滤波或猜测 rounded-rect。`preview_density_seam.test.ts` 用真实 native
Showcase FrameResult 在 DPR 1.8 逐行采样按钮内部；当前投影为零坏行，旧
fractional-density 消融稳定出现坏行，作为负对照。

## 验证与消融

相关测试位于 `sdk/editor/test/`：

- `preview_density.test.ts`：真实浏览器验证 DPR 变化、逻辑输入与截图尺寸。
- `preview_density_seam.test.ts`：真实 native Showcase 在分数 DPR 下验证圆角条带无接缝，并运行旧 density 的负对照。
- `preview_pointer.test.ts`：验证多指、滚轮和丢失 capture 后的输入顺序。
- `preview_viewport.test.ts`：验证 child 按区域调整尺寸、重复 resize 去重、隐藏 child 尺寸保持、转场裁剪和输入映射。
- `preview.test.ts`：真实 native Profile → Lobby → Showcase 完整链路。自动点击前等待区域几何稳定，不能在入口动画的首个带标题帧就使用其坐标。
- `preview_rounded_seam.test.ts`：针对真实 native Profile 的圆角片段检查像素。负对照必须确实出现接缝，才能说明测试验证了修复。

2026-11-04 最终运行以上 6 个测试文件，合计 **8 pass / 0 fail**，包括标注区域、DPR、指针、真实 native 打开/返回、viewport 同步和圆角像素检查。架构边界检查与 `git diff --check` 也通过。根代理另用 Playwright Chromium 打开 `http://127.0.0.1:8792/` 对应的真实 Profile 预览并截图，按钮内部未见横缝。

现场旧投影的按钮边界曾测得 `[69,109,237]`、`[99,131,240]`，与不透明内部颜色 `[49,93,235]` 不同；移除圆角取整补偿后，viewport 同步版本仍通过像素检查。此前单行取样和转场期间的按钮定位曾被测试主动检出，未计入通过结果。像素检查应覆盖拼接边两侧和裁剪外实际 RGB，不能用白底本来就为 255 的 alpha 作为无泄漏证据。

验收命令（仓库根目录）：

```sh
bun test sdk/editor/test/preview.test.ts sdk/editor/test/preview_viewport.test.ts sdk/editor/test/preview_rounded_seam.test.ts sdk/editor/test/preview_density.test.ts sdk/editor/test/preview_pointer.test.ts sdk/editor/test/preview_regions.test.ts --max-concurrency=1 --timeout 60000
python3 sdk/scripts/check_architecture.py
git diff --check
```

这不是全仓测试结论。单独的 `preview_mini_app.test.ts` 在本轮后续重编译时被共享工作区中 Lobby fixture 的 `SafeAreaScaffold` export 缺失阻断，未将较早的通过结果用于本轮最终计数；真实 native 打开/返回由 `preview.test.ts` 使用预构建 demo assets 验证。

本记录区分现场现象、实现策略和已经取得的测试证据；若后续改变策略，应同步更新代码旁注释与本记录，保留可重复的负对照。

## 原生 Mini App 的安全区失效通知

同日 Android 截图暴露了另一条宿主几何问题：Mini App 入场时，child RenderBox 从屏底移到屏顶，但宽高约束和系统窗口 metrics 没有变化。首报的 `safeArea.top=0` 可能一直保留。只在初始化或系统 metrics 改变时测量不足以覆盖这种移动。

`PocketSystemHost` 比较 compositor slot 的 bounds、visibleClip 和 logicalViewport，只在几何改变时递增 `geometryRevision`，经已有 `PocketGuestSession` 传入 `PocketView`。child 在布局后重用 `_safeAreaForHost` 测量自身与物理系统安全区的交集，并通过已有 display.viewport 链路上报；没有复制 root inset、轮询或新增原生 ABI。既有上报缓存继续避免发送重复值。

JS 继续使用已有 `SafeAreaScaffold`：独立 child 默认消费一次安全区；已有安全区父容器内的页面使用无 inset 的组合入口。宿主几何修复与 JS Page padding 分工明确，避免在每个 Demo 页面硬编码状态栏高度或叠加第二层 padding。

Duo 展开时的要求是只避让右上角状态区域，顶部其余部分保持可用。不能把局部 `occlusion` 转成整条 top padding 或整页 right padding；Page/关闭按钮应依据实际 ReservedRegion 与自身矩形的交集处理局部避让。宿主只报告真实 viewPadding 和区域，不按机型名称编造状态图标矩形；缺少 OS 局部区域数据时不能声称已经获得它。上述宿主 geometryRevision 与 viewport/system-host 两组测试由主代理复跑，合计 8 项通过。

最终明确区分 Duo 两种状态：折叠时保留右侧安全区；展开/部分展开时，系统会提供全高中央 division 拓扑（可能 inactive）及右上局部 occlusion。真实样本的旧式 `safeArea.right` 在这两种状态都可能为 84，因此独立 Page 使用 `pageInsets()`：仅当中央分区有效、局部角落区域精确解释右侧 inset 时，释放正文的保守 right 投影。原始 `safeArea` 和通用 `reservedInsets()` 不变；没有分区、分区在窗口外/贴边、区域或 inset 不匹配时均保守回退。不是按屏宽或机型名称识别状态。

关闭按钮继续先消费保守 inset，再通过 `avoidDisplayOcclusions()` 处理实际相交的局部区域。Page 的 app-bar trailing 区与 Page padding 使用同一套派生 inset，额外保留移开后关闭按钮的空间；正文不参与局部控件平移。主代理复跑 JS 几何/Duo 测试 9 项通过，native fixture 在 390/320 两种尺寸同一 runtime 更新 geometry 后验证 app-bar 不重叠。真实样本来源 `demo/js/tests/fixtures/duo_geometry.json`；本轮没有重新安装真机或跑完整的 Duo 折叠/展开 UI 验收。

关闭按钮保留同心圆：可见外圆 30px、内部 14/10/6px；44px 点击区在普通、focus 和 active 状态均透明，避免自动聚焦绘制出 44px 的光晕。奇偶一致可消除部分半像素中心问题，但不能代替高密度 native mask。

## Native mask 与浏览器 DPR

Canvas backing store 的 DPR 不会增加 native 原始纹理的信息量。PocketJS 的 disc/border mask 会依据 runtime 的 rasterDensity 生成更高分辨率纹理，而逻辑尺寸保持不变。Editor 的服务入口专门配置 rasterDensity=2；公共 PreviewManager 默认值仍为 1。此设置改善生成的圆角/阴影 mask，不会把外部低分辨率图片变成高清，也没有在 DPR 变化时重建并丢弃用户运行状态。Flutter 真机仍沿用其设备像素密度路径。

## 重复主题/开关的实际绘制时延验证（2026-11-05）

为区分 JS 状态提交、native FrameResult 往返和 Canvas 绘制，使用临时
`sdk/editor/test/.tmp_showcase_render_measure.ts`，以当前
`demo/assets`（root bytecode 587,987 bytes，同时加载其 profile/lobby
子应用 pak/qjbc）和 pinned Playwright Chromium 进行真实点击。native 使用
新构建的优化 probe：
`sdk/native/target/release/pocket_probe`（不是 debug probe）。临时 wrapper
只给每个 `op: "frame"` 请求记录发送到 native 子进程、收到完整响应之间的
单调时钟时长，未改变协议或生产代码。

浏览器注入的测试 instrumentation 只包裹主预览 Canvas 的
`CanvasRenderingContext2D.clearRect/save/restore`：在 depth=0 的
`clearRect` 开始计时，在最后一个 restore 回到 depth=0 时结束。它测量
`renderCurrentFrame` 的同步 Canvas2D 投影段，不包含浏览器合成器/GPU swap
或屏幕扫描；Chrome 的计时粒度使很短的样本量化为 0 或约 0.1ms。p50/p95
使用排序样本的最近秩，不作 60fps 或帧预算达标声明。

真实操作为 Settings 中 Light/Dark 快速交替 9 次，以及 Mobile UI → Controls
中 Enabled 快速点击 9 次（最终状态分别 Dark、Disabled）；两组均确认
最终 pending input 为 0、无页面异常，并在 settle 后等待 250ms，确认没有
新的 preview.frame 通知或 Canvas draw。

| 交互 | Canvas draw 样本 | draw p50 / p95 / max | DrawOps | resources | Frame payload max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Theme 9 次交替 | 42 | 0 / 0.100 / 0.100 ms | 282（min=max） | 0 | 39,505 B |
| Enabled 9 次点击 | 35 | 0 / 0.100 / 0.100 ms | 364（min=max） | 0 | 50,244 B |

同一 run 的 native `op: "frame"` 独立 wrapper 记录 270 个完整 frame 响应：
round-trip walltime p50 **0.952ms**、p95 **3.471ms**、max **40.429ms**；
最大 native frame 为 364 DrawOps、9 resources、120,177 B JSON 响应。这个
walltime 包含 probe 子进程边界和 native guest 执行，但不等于 Canvas paint
时长；两者必须分开看。

这项验证是临时 instrumentation，不向 preview API 增加 telemetry。它证明
当前重复输入路径的同步 Canvas 投影耗时和 idle 后无额外绘制；不能推断
浏览器合成、GPU 交换、真实设备刷新率或所有资源/host-surface 场景的成本。

## 2026-11-05 modal 组合 harness 的未解决问题

独立的真实 guest modal/Chromium 连续打开关闭通过；最新 colorless blur +
scale/fade 的 native、Flutter raster 和 browser 定向回归也通过。但在同一 Bun
进程先运行 `preview_timing.test.ts` 再运行 real modal 时，仍有独立的组合回归
问题：最后一轮独立 Bun 进程 baseline 0/5，modal-only 3/3。失败时 probe 会以
code 0/EOF 退出，最后收到 `frame`/`schedule`，没有收到 `quit`，且部分样本仍有
一个 SSE subscriber；另有样本先失去 subscriber 后触发 idle eviction。

检查了延迟 DOWN 的 fulfill 顺序：MOVE/UP 已在 DOWN 响应之后发送。等待
operationTail、await server.stop(true)、先 page.close、先 preview.close 的实验
都不能稳定消除失败，因此没有加入固定 sleep，也没有将其解释为已证实的
Modal JS、NativeProbe 或 Bun 缺陷。没有足够因果证据保留新的 NativeProbe
close/stdin.end 生命周期补丁；相关临时诊断和进程已清理。此问题仍未定位，
本轮定向 UI 通过结果不等于完整组合 suite 通过。
