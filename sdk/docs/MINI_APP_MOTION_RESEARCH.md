# Mini App 呈现动画研究（2026-11-04）

## 已确认

- `system-surfaces.tsx` 的 JS 呈现使用 420ms 对称 cubic ease-in-out。以 843px 行程计算，前 50ms 只移动 5.69px，中段 60Hz 单帧最大约 96.27px。这是曲线计算，不是 FPS 实测。进场中关闭会反向走时间线，位置连续，但速度会突然反向。
- 当前容器高度固定，只更新 translateY；不能把它误报为每帧 resize child viewport。
- 独立 native probe 测量中，动画约每 19.5–22.7ms 产生状态。Playwright Chromium 测量中，SSE 仍约每 20ms 产生状态，但部分状态在浏览器批量到达：约 11 个退出状态只在 rAF 观察到 4 个。无头浏览器数据不代表真实设备 GPU/vsync，也不是全平台 FPS 结论。
- 未发现资源逐帧重复传输/解码；变化资源共 13–14 个唯一 asset/revision。完整 DrawOps JSON 单帧约 74–99KB，仍有浏览器投影优化空间。

## 对照 iOS 的方向

Apple 的 [Animate with springs](https://developer.apple.com/videos/play/wwdc2023/10158/) 强调位置、速度连续，以及打断/换目标时保留速度；无回弹的弹簧同样可以用于自然收束。不能声称 iOS sheet 有一组跨版本固定的公开时长和弹簧参数。

[Designing Fluid Interfaces](https://developer.apple.com/videos/play/wwdc2018/803/) 强调低延迟和可中断交互。[Customize and resize sheets in UIKit](https://developer.apple.com/videos/play/wwdc2021/10063/) 展示 detents 和层叠呈现。这些原则可由 JS 实现，不需要把业务动画迁到 Dart。

优先级：先修启动呈现链路；再对浏览器按 rAF 只绘制最新状态做消融（资源更新及首帧 ACK 不可随中间帧丢失）；之后用可保留速度的 JS 弹簧替代固定曲线，对比点击响应、逐帧位移和能耗。拖拽关闭、背景层叠缩放属于后续交互能力，不能靠曲线替换自动获得。当前尚未实施这些动效优化。

## 已修正的独立启动问题

Editor 空闲后再打开 Mini App，输入 turn 的零 delta 没有更新空闲时钟基线。新建请求之后的下一帧可能带入旧空闲时间，使按虚拟时间计数的 host request 提前超时，最终出现 `SystemUI did not respond to platform.apps.open`。

`preview.ts` 仅在 native 已报告完全空闲（nextWakeDelayMs 为 null 或负数）时，于输入边界重锚时间基线；活跃 timer、连续拖动不重锚。代码旁保留约束说明。`preview_idle_mini_app.test.ts` 使用真实 qjbc、native probe 和浏览器呈现 ACK，验证空闲后打开应用。主代理运行 idle、pointer、preview 三组测试合计 5 pass / 0 fail。
