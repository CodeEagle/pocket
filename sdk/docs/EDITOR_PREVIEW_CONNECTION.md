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
