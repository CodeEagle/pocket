# Editor 预览连接与重连

Editor 的预览页面通过一个 EventSource 接收原生 PocketJS 的 FrameResult。
按需渲染的 Guest 在没有输入、动画或资源更新时可以长期不发送帧。

## 来源与修复边界

先检查了保留的父工程 `pocketjs_flutter_demo/lib/` 与
`pocketjs_flutter_demo/pocketjs_super_app_demo.html`（排除 `pocket_host/`）。
父工程没有 Editor 的 HTTP/SSE 连接实现；本次沿用 SDK 已有的
`editor/server.ts`、`editor/preview.ts` 与 `editor/client/preview.js`，
不增加渲染器、传输协议或重连状态机。

服务端的 `idleTimeout: 120` 原先也作用于静止的 SSE 响应。
[Bun 的流式响应说明](https://bun.com/docs/runtime/http/server#idletimeout)
明确指出，空闲超时会中断正在传输的流。现在只有成功返回
`text/event-stream` 的预览响应调用 `server.timeout(request, 0)`；
普通接口、错误响应仍使用原来的超时与错误处理。

浏览器仍使用 EventSource 自带的自动重连。暂时断线显示“重连中”，
收到实际重放帧后恢复就绪；原生运行错误和非法帧仍通过错误通道报告。
EventSource 进入 CLOSED 时报告连接已关闭，不会一直显示重连中。
断线时使排队中的旧 MOVE/UP 失效，并发送尽力而为的 CANCEL；正常输入
失败仍报告错误，失效手势不会在恢复连接后重放。

## 消融与验收

复用 `editor/test/fixtures/counter`，通过同一 pinned buildGuest 编译成真实
QJBC/PAK，由原生 pocket_probe 执行，Playwright Chromium 只投影帧与发送输入。
`editor/test/preview_stream_idle.test.ts` 启动实际 Editor HTTP 服务，等待真实
计数器首帧后静置 125 秒，不轮询、不输入，然后检查只建立过一次 SSE，
并点击按钮验证 `count=0` 变为 `count=1`。

客户端重连的传输故障注入与界面提示另由浏览器回归覆盖；这类传输 fixture
只验证连接与消息处理，不作为 Guest 执行证据。

2026-11-09 验收结果：生产配置下静置 125 秒始终只有一个 SSE 请求，
没有断线或重连提示，之后真实鼠标点击使 Guest 输出 `count=1`。
消融使用同目录临时副本，仅移除请求级超时豁免并把 HTTP 空闲阈值缩短为
1 秒以加速复现：同一真实 Guest 的静置断线断言失败，出现重连状态。
临时副本已删除；没有增加定时心跳、持续渲染或第二套重连计时器。

相关回归：`preview_stream_reconnect_browser.test.ts` 2 项通过（传输夹具）；
`preview_pointer.test.ts`、`preview_pointer_recovery.test.ts` 共 2 项通过
（真实原生输入）；`editor_server.test.ts` 10 项通过。固定端口 8791 的
本地 Editor 已重启，Chromium 打开工作区显示“就绪”，无页面 JS 异常。

## 父页 Frame 通知不复制纹理像素

继续复用当前 `sdk/editor/preview.ts` 的原生 SSE `FrameResult` 和
`sdk/editor/client/preview.js` 的 Canvas2D 投影。来源检查了保留父工程
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`（排除
`pocket_host/`）的 `pocketjs_super_app_demo.html`、
`web_wasm_preview/index.html`、`lib/core/pocketjs_bundle_runner.dart`；其中
旧网页预览是概念面板，旧 Dart runner 是另一套 Flutter Demo 宿主。该工程
没有 Editor SSE、浏览器纹理通知或 Lantern Editor Preview 实现可供复用，
因此没有从中迁入第二套宿主或 renderer。

原先客户端先从 SSE 解码资源、绘制 Canvas，再将同一个完整 FrameResult
通过 `preview.frame` `postMessage` 给 Editor 父页；父页仅用这条消息标记
预览就绪。现在只在父页通知的 `resources` 中传递
`asset/revision/width/height/psm/linear/pixelsBytes/paletteBytes`。原始
纹理内容仍保留在 SSE 输入和 Canvas 解码缓存中；`getFrame()` 返回收到的
帧（旧流为数字数组，下面的 Worker 流为转交后的 Uint8Array）。
`preview.capture.result` 与标注消息保持原协议。
DrawOps、events、inputBounds、presentationTokens 和 releasedResources
仍随父页 frame 通知传送，避免改变就绪、输入区域与首次呈现屏障。

`editor/test/preview_frame_notification.test.ts` 在真实 Playwright Chromium
中验证 PSM5+palette 的 Canvas 像素、`getFrame()` 原资源数组、父通知中
像素/调色板字段缺失及准确字节数、相同 asset 的 revision 替换和资源释放。
验证命令：`cd sdk && bun test ./editor/test/preview_frame_notification.test.ts --timeout 30000`。
这验证数据边界与渲染语义；实际性能验证见下节。

## 大资源流的浏览器 Worker 边界（2026-11-09）

Lantern 首次可见帧包含四张 512×512 RGBA 纹理。原来 4 MiB 的像素被展开为
约 12.5 MB 的 JSON 数字，再由渲染线程解析、解码并复制给父页。仅删除父页
副本仍有长任务；单独缩小 JSON 也不能稳定消除停顿。

公共 Editor 链路现做两项适配，所有 App/Game 共用：

- 浏览器用 `resources=base64` 明确协商紧凑纹理编码，首次发送和重连重放
  复用同一个序列化入口。未协商的订阅仍收原数字数组；native FrameResult、
  recording、资源 revision/cache 与 snapshot API 保持 canonical 数据。
- 正式预览文档启用一个浏览器 IO Worker，Worker 内仍用原生 EventSource
  接收和自动重连，在同一处解析 JSON、解包纹理后转交 ArrayBuffer。
  渲染线程接收 Uint8Array，继续用原来的 Canvas/DrawOps、输入和呈现 ACK。
  没有复制重连计时器、布局、业务状态、资源缓存或 PocketJS runtime。
  关闭预览终止 Worker；不支持 Worker 的宿主沿用直接 EventSource。

原生 SSE 的错误/就绪状态仍交给已有连接状态和 pointer CANCEL 逻辑。
资源准备后才绘制、再经过原有双 RAF 呈现 ACK，不提前宣布准备成功。
没有预加载隐藏游戏或降低纹理分辨率。

同一固定 8791 服务、同一 Showcase/Lantern QJBC、Playwright Chromium
156、375×812 / DPR2 下，通过真实列表点击测量。临时 instrumentation
只测 JSON.parse 和 postMessage 的同步耗时、longtask、RAF 间隔；不遍历
或序列化大像素数组来统计数据，避免测量本身制造卡顿。

| 本机观测 | 原链路 | 紧凑编码 + Worker |
| --- | ---: | ---: |
| 首次纹理帧 JSON | 约12.5 MB | 约5.7 MB |
| 渲染线程帧 JSON.parse | 约16 ms | 移至 Worker |
| 父页复制4 MiB像素 | 约19 ms | 无像素副本 |
| 一次打开的渲染线程 longtask | 196 ms | 连续两次均无超过50 ms任务 |
| 点击到标题的观测 | 1.568 s | 1.031 / 1.202 s |

消融中只精简父通知仍测到157 ms长任务；只加紧凑编码的不同运行仍有
90–181 ms长任务，因此保留 Worker IO 边界。启动等待受 native Guest/IO
和本机负载影响，旧链路另一次为3.772 s；上述单次耗时不构成启动 SLA，
也不证明显示器/GPU达到60fps。Flutter 手机绘制链路不在这项测量范围内。

`preview_frame_notification.test.ts` 还验证：旧数组格式、紧凑 PSM5 palette、
RGBA、无 fromBase64 的回退、无 Worker 的回退；真实 SSE Worker 不在主线程
调用帧 JSON.parse、转交纹理像素、断线重连重放、revision替换与release。
原有 tint 和 pointer重连回归也通过。真实 Preview 完成 Start → 手札 →
继续阅读，并检查回到正文的截图，没有页面 JS 异常。证据保存在
`sdk/.pocket-build/editor-lantern-stream-20261109/`。

## 启动等待不能占住 SystemUI 帧队列

浏览器 Worker 的长任务消融并未覆盖后端排队。用户在实际 Chrome 仍观察到
启动停顿后，继续检查 `handleSystemRuntimeRequest → createChildRuntime`：
原先在处理 root Guest 的 `system.runtime.create` 时，直接等待子 Guest 的
探针启动和 bytecode/PAK 加载。该调用位于 Preview 的串行帧/输入队列中，
因此连已经由 JS 产生的 loading 提示，也要等子 Guest 加载完才能发到浏览器。

使用已编译的 Showcase revision 19 与 Lantern 原生 Guest，在独立临时测试
服务中只把 Lantern 的 `loadBytecode` 传输延迟 2 秒，不替换 Guest、渲染器
或应用逻辑。修复前观测到连续 2.255 秒没有帧，loading 提示在点击后
2.268 秒才出现；加载期间滚动 160 像素后，列表文字 y 坐标仍为624。
这项故障注入证明原生启动等待阻塞了 root 的帧和输入，不能由浏览器
JSON/纹理优化解决。测试服务使用系统分配的临时端口，日常 Editor 保持8791。
原始结果与测试脚本保存在 `sdk/.pocket-build/editor-lantern-startup-20261109/`。

本段修复前也检查了保留父工程的 `lib/core/pocketjs_bundle_runner.dart`、
`lib/ui/mini_app_host_page.dart` 与 `native/pocket_runtime_multi.c`（排除
`pocket_host/`）：旧版有同 runtime 路由和原生多 sandbox，但没有当前
`system.runtime.create` 的 Editor 队列边界。应用打开策略与 loading 状态
继续由已有 JS SystemUI 管理，Preview 仅适配原生子进程的异步完成事实。

异步启动适配后的同条件实跑：loading 提示约33 ms出现；在350 ms处输入
滚动160像素，读取延迟尚未结束时，列表文字 y 从624变为464。之后仍等待
真实子 Guest 加载、绘制和呈现 ACK，再进入 Lantern 标题页（约3.18秒，
包含故意注入的2秒延迟），没有提前伪报加载成功或浏览器 JS 异常。
这里验证的是等待期间可见且能响应，不承诺缩短实际资源读取时间。
现有 loading 卡片是阶段文字，没有百分比、旋转动画或取消按钮；测试通过
底层列表输入响应验证宿主未被启动等待阻塞，不把静态文案当作流畅度证据。

将子 runtime 的登记和初始事件处理也收回原串行队列后，重复慢加载验收仍可
在等待中滚动（624→464），标题约3.33秒出现。无注入延迟的独立实跑约
1.25秒进入标题。随后真实鼠标操作“启程 → 手札 → 继续阅读”通过，等待
实际 station 背景资源和转场稳定后检查截图，背景铺满视口且正文、人物和
交互控件正常。上述样本用于功能验收，不作为跨机器性能保证。

自动回归 `preview_child_startup_nonblocking.test.ts` 用可控探针延迟检查
root 连续帧、输入返回和 dispose 后无迟到登记；它验证调度边界，不冒充
真实 Guest 执行证据。消融把同一测试临时指向修复前 HEAD 的 `preview.ts`，
在“root 帧和输入检查必须发生于子 bytecode 仍在加载期间”的断言处失败；
恢复修复版本通过，临时源码与测试副本均已清理。保留原来的按需 tick、
JS 打开策略及首帧 ACK，只移除了对串行 root 帧队列的不必要占用。

最后在固定8791重启服务，并在用户实际 Chrome 窗口点击 Lantern：先显示
loading 卡片，再进入完整标题页。当前工作区有并行的 Profile manifest
修改导致新构建失败（`app.presentation` 未被当前编译器接受），因此本轮
使用保留的成功 revision 19；未覆盖并行修改。相关7项回归全部通过；
AGY `gemini-4-argon-medium` 对本次改动和安全区提交统一只读审核，无阻断发现。
