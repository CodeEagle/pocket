# Mobile dialogs

Source-first integration retains the Modal/Portal and focus-isolation pattern
from `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_pages.js`
and the existing optical provider derived from that parent's
`shaders/liquid_glass.frag`. The pinned official JS Modal continues to own
visibility, focus and dismissal. Flutter only samples/composites the backdrop;
there is no second native dialog or animation state machine.

The earlier reference is `Screen Recording 2026-11-05 at 16.23.47.mov` (4.017s,
824×1614, 60fps). Its abrupt, tinted modal appearance is replaced by a colorless
backdrop blur that fades in, with a centered scale-and-fade transition for the
JS dialog. This supersedes the earlier black translucent scrim request.

## Current panel and text rendering (2026-11-06)

`ScreenRecording_11-06-2026 12-38-13_1.MP4` (1290×2796, 120fps,
4.927s) exposed a different problem: the complete panel subtree scaled from
0.92 to 1, so glyphs and action labels were visibly compressed before settling.
The 300ms symmetric ease also spent too much of its entrance near transparent.
The retained parent supplies Modal/Portal, focus isolation and native property
animation; it does not require text to inherit a presentation scale.

Dialog and Popup now share `MobileModalPanel`: a natural-size content layout
fades in place, while only the absolute background/border/shadow paint scales
from 0.96 to 1. Text never enters the transformed glyph-triangle path merely
because the panel is opening. The shared overlay phase is 220ms with cubic
ease-out. This is a Pocket setting, not an Apple timing requirement. Backdrop
blur and content opacity follow that same phase; exit and interrupted reopen
still traverse it backward/forward without remounting or resetting the phase.
Other presence consumers keep the existing 300ms default.

The native QJBC regression checks 320/390 widths, requires untransformed text
ops in visible fractional frames, compares title/body/action x/y/w/h throughout
entry and exit, and still verifies background scale, transparent blur, reverse
exit/reopen and single confirm dispatch. A text check based only on settled
frames would miss the original transformed-glyph defect.

Fresh Settings Web Preview verification used actual pointer clicks on Reset
appearance, two open/Cancel cycles, 390×844 at DPR 2 with Playwright Chromium
and ANGLE Metal. Before: first visible backdrop at 139/184ms and settled phase
at 367/400ms. After: 114/72ms and 296/273ms, respectively. The new title remains
at x=71, y=357, w=248, h=17 through fractional opacity frames; formerly its
normal text op appeared only after the inherited transform settled. These are
browser frame-delivery observations including input overhead, not GPU timings
or a guarantee for the recorded phone. The native regression plus scalar
motion suite passed 4 tests; the default Toast/Alert/Accordion/control-presence
suite passed another 4, including 30/60Hz and idle parking. Gallery Popup also
opened and dismissed with fixed title geometry in fractional frames and no
browser exceptions. The new Demo QJBC is 643,186 bytes.

The shared Mobile backdrop reuses `GlassSurface` in a portal before the Modal
panel. Its descriptor supplies `effect: "blur"` and `opacity` from JS animation
progress. The official Modal's additional scrim is transparent: blur does not
need a second colored overlay. Default optical glass retains its existing
material; plain modal blur skips tint, refraction, rim and shader loading.

In `sdk/packages/pocket_flutter/lib/src/pocket_surface.dart`, the plain mode
uses the existing `BackdropFilter` boundary with `ImageFilter.blur`. An outer
alpha `ColorFilter` fades that filtered sample over the unfiltered scene.
Wrapping BackdropFilter in an Opacity/saveLayer would change its sampling
boundary, so progress travels in the existing surface descriptor instead.
Opacity zero omits the filter. No native ABI or additional renderer is needed.
The browser projection in `sdk/editor/client/preview.js` likewise samples the
already-painted Canvas backdrop and composites its blurred copy with the
supplied opacity. It must preserve the glass operation's position in draw order.

Component details expose one Close action. Destructive dialogs use explicit
Delete and Cancel actions. The shared transition compares its resolved key
before restarting: whole-store invalidation with an unchanged key must not
reset panel opacity on every frame.

Validation (2026-11-05):

- `flutter test test/pocket_surface_test.dart` in `sdk/packages/pocket_flutter`:
  3 passed, including real Flutter raster samples of a red/blue backdrop at
  opacity 0, 0.5 and 1. Half progress lies between clear and blurred pixels and
  near their average; the green channel stays zero and red+blue stays 255,
  proving no white/black/colored material tint is added. Existing surface clip,
  paint order and platform-texture authorization checks also pass.
- Native-renderer ablations each fail that pixel test as intended: removing
  filtered-sample alpha destroys the intermediate frame; using optical glass
  for the plain blur adds material tint. Production code is restored afterward.
- `sdk/native/patches/modal-transparent-backdrop.patch` adds the optional scrim
  class to the pinned official Solid Modal. `prepare_upstream.py` registers it;
  the worker verified both initial application and already-present bootstrap.
  The old implementation ignored `backdropClass` and always painted a dark
  0.62-alpha scrim. Default Modal callers retain that behavior.
- Demo assets rebuilt with the pinned compiler (root QJBC 588,270 bytes).
  Fresh real Editor 8792 / native probe / Playwright Chromium input opens
  UI → For in both Light and Dark, reaches `effect=blur, tintOpacity=0,
  opacity=1`, paints exactly one Close and dismisses successfully, with no
  browser exceptions. Screenshots: `/tmp/pocket-colorless-modal-live.png` and
  `/tmp/pocket-colorless-modal-dark.png`. These settled screenshots complement
  the intermediate-frame tests; they do not by themselves prove motion timing.
- Fresh debug `pocket_probe` executes
  `sdk/packages/pocket_ui/test/mobile_dialog_native.test.ts`: 1 passed at
  390px and 320px. Real panel geometry grows through intermediate frames
  (approximately 270→290 including shadow bounds), while blur opacity advances
  0→1 with tint zero and no dark scrim. It also covers whole-store invalidation
  and a parent `<Show>` mounting/unmounting the dialog, as in Showcase details.
  At partial opacity native text may be emitted as glyph/image operations;
  intermediate detection therefore uses panel geometry and surface payloads
  instead of requiring semantic Text ops before the settled frame.
- `bun test sdk/editor/test/preview_glass_browser.test.ts`: 2 passed, including
  Canvas pixel checks and a real pinned guest repeatedly opened/closed with
  Playwright Chromium. Existing switch loading/rollback, manual slider motion
  and back-arrow native regressions also passed (2 tests).
- Ablation removed an unnecessary object memo experiment: restoring the
  original JSON-string memo still passes the native entrance test, preserves
  dynamic opacity, and suppresses identical surface registration payloads.
  Glass and PlatformTexture retain the established string ABI. Final Demo
  root QJBC after this ablation is 588,416 bytes.

## Web Preview 首次打开的绘制消融（2026-11-05）

用户确认首次卡顿发生在 Web Preview。沿用 retained parent
`lib/render/pocket_ui_components.dart` 的缓存绘制资源原则及现有 Canvas
DrawOp 投影，不在业务层预开一次 Dialog，也不引入第二套弹窗状态。

`sdk/editor/client/preview.js` 消除两项冷路径工作：

- `effect=blur, opacity=0` 直接完成空合成，不创建整屏 DPR 离屏画布，
  不运行不可见的模糊。非零帧仍使用原始分辨率真实 backdrop blur。
- TEX_TRI 的统一 alpha 与 TEX_QUAD 一样交给 Canvas.globalAlpha；RGB
  tint 纹理跨淡入帧复用。此前 TEX_TRI 将 alpha 烘焙到整个纹理，首次
  缩放/淡入会产生多份字库或圆角纹理及上传，暖缓存掩盖这部分开销。

`preview_triangle_alpha.test.ts` 使用 fresh Chromium 及真实 Canvas 像素与
上传计数：输入纹理自带 alpha，31 个变动 alpha 帧只需 source + RGB tint
两次上传；透明 blur 首帧不分配离屏画布、不提交 filter，重新归零也不计算。
回退 TEX_TRI alpha 分离的负对照产生 32 次上传并失败；回退透明 blur
早退的负对照也失败。生产代码未在负对照期间被临时覆盖。

另外试验了将模糊画布从 DPR 尺寸缩至逻辑尺寸：在 fresh Chromium 的
合成测试中未得到稳定耗时收益，未采用该画质折中。同步 Canvas 调用计时
和双 requestAnimationFrame 耗时均不能单独代表 GPU/屏幕呈现时长。

范围校正：后续真实 native Dialog 采样的缩放仍为轴对齐 TEX_QUAD，
`textureTriangle=0`（首玻璃帧 image=84，稳态 image=40）。因此 TEX_TRI
alpha 消融验证的是旋转纹理绘制边界的冗余，不能解释这次常规 Dialog 的
首次卡顿。实际资源包含 3 个 512×128 PSM5 字库页面及小尺寸圆角 mask；
第二次打开也有相同资源序列。本轮另将 PSM5 palette 展开改为同字节序的
32-bit RGBA entry 拷贝，减少字库页面在主线程的逐通道展开。PSM5 带原生
alpha 和非整字 palette 尾部的 Canvas 像素回归通过。

相同 fixture 的首玻璃帧 probe RTT：debug 首次/第二次 45.47/44.85ms，
release 为 8.13/7.18ms。该差异主要来自构建 profile，不能据此称为首次
冷资源卡顿；当前默认 resolver 实际选择的是新鲜 release，未修改选择策略。


## Web Preview idle 唤醒与双向转场（2026-11-05）

继续检查 retained parent 的
`mini_apps/syslib/pocket_syslib_pages.js` 中 modal / portal 组合及
`native/pocket_runtime_multi.c` 的 frame 边界。父项目没有 Editor 的
pointer HTTP / Canvas 调度，因此本次只适配现有 PreviewSession 与公共
Mobile 组件，保留 pinned guest/core clock 和官方 Modal 的焦点隔离。

首开延迟的可复现根因位于 `sdk/editor/preview.ts`：native 在 DOWN
外部边界结算 idle 时间，并给下一次 display delta 留下同量 credit；
旧 UP 分支却重置 `lastTickAt`，丢弃用于抵扣的 idle 间隔。随后定时帧
先消耗残余 credit，JS 转场长时间停在零。删除 UP 的这次计时重置，
与已有 `tickNow(0)` 不移动 display baseline 的规则保持一致。

无永久 onFrame 的真实编译 fixture 先用相隔 220ms 的两个样本确认
700ms 后没有新 frame，再由 Chromium pointer DOWN/UP 打开 Dialog。
轻量浏览器 trace 仅记录 frame、opacity 和时刻，避免通过 CDP 反复复制
完整字库资源扰动被测动画。release probe 下首次/再次打开首个非零
opacity 约 51.4 / 51.3ms，并保留淡入中间帧。仅恢复 UP reset 的进程内
负对照等待约 1076ms，frame delta=57，前 12 帧 opacity 均为零。
测试收紧为 <180ms，且必须包含非终态 opacity。

用户随后要求放慢节奏、关闭沿入场反向播放。MobileDialog / MobilePopup
共用最小 JS presence 逻辑：单一 linear phase 使用官方 virtualNow 推进，
时长 0.3 秒，smoothstep 输出同时驱动背景 blur opacity、panel opacity
及 scale。关闭反向推进同一 phase，到零后才释放官方 Modal；中途
close / reopen 从当前 phase 反向，不重新从端点开始。退出期间 action
检查 requested 状态，避免重复触发 confirm / select。route inactive
立即清理；零进度即取消也立即卸载，避免透明焦点层停留。

Showcase details 移除外层按 open 立即卸载的 Show，保留一个 MobileDialog
实例，由 UI 库统一决定退出完成时的卸载。没有 Demo 定时器或 Dart
动画状态。virtualNow 是确定性 simulation clock，不能把配置的 300ms
直接等同于所有宿主的 GPU 呈现时长；真实浏览器测量另行记录。


真实 Showcase 复验：使用新构建的 root QJBC（590,550 bytes）、优化版
`pocket_probe` 和 fresh Playwright Chromium，390×844 / DPR=2，UI → For，
首次及再次打开都出现 0→1 的多个中间帧。首个透明样本到全显分别约
276.5 / 275.1ms；关闭采样有十余个单调递减 opacity，含约
0.966、0.874、0.5、0.074、0.009，之后才移除 glass / Modal。测试要求
关闭至少包含一个非端点 opacity 且不得逆向增加；两个循环均通过。
这是 Canvas 通知/绘制时刻的观测，不作为 GPU 帧率保证。

Demo 使用正常 buildGuest 流水线重编译，优化 native probe 重建成功。
本地 Editor 8792 已重启并通过自身 build API 重新构建当前源码，状态为
build ready，现有网页刷新即可加载。公开 SDK 无 Demo 依赖的架构检查
与 diff whitespace 检查通过。


最终回归：`mobile_dialog_native.test.ts` 在 390/320 两种宽度通过
（1 test），覆盖约 300ms 入场/退场、关闭途中 reopen 连续反向，以及
重复 confirm 只执行一次。最终 immediate-open guard 调整后 Demo 再次
正常重编译，root QJBC 为 590,574 bytes。`mobile_ui.test.ts` 4 项、
透明 blur / TEX_TRI / PSM5 的 Chromium 绘制回归 1 项通过。


最终时钟/输入补测：新 release probe 下
`preview_timing.test.ts` 两项全部通过，覆盖慢输入下 move 合并及连续
输入时 elapsed ledger；此前并发编辑造成的 native 编译失败已消除。
既有 `preview_pointer.test.ts` 的真实多指、wheel、capture/失败恢复一项
也通过。本轮未宣称全仓测试通过。
