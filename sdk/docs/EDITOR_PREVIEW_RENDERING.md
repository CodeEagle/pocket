# Editor 网页绘制：圆角拼接与屏幕密度

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
- `renderCurrentFrame` 的 backing store 跟随屏幕 DPR；FrameResult、输入和截图协议仍用逻辑坐标。`setTransform` 只负责映射到 backing pixels。DPR 清晰度与 child viewport 修复是两个独立处理，不能把清晰度提升当作接缝修复的证据。
- 浏览器还可能把整个 iframe 按 CSS 比例缩放。屏幕截图与原始 canvas 像素是不同验收对象，排查时应同时记录逻辑尺寸、backing store 尺寸、CSS 尺寸和 DPR。

## 验证与消融

相关测试位于 `sdk/editor/test/`：

- `preview_density.test.ts`：真实浏览器验证 DPR 变化、逻辑输入与截图尺寸。
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
