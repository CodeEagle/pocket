# Editor 网页原生编辑桥接

## 修复前的实际证据

2026-11-04，真实 Chromium 连接 8792 的 Showcase，点击首页 `Tap to type`
后输入 `Pocket web`：activeElement 仍为 CANVAS，DOM 可编辑控件数为 0，
Guest 仍绘制 `Draft: (empty)`。日志 `/tmp/pocket-web-input-before.log`。

原因是两个不同协议被混用了：Canvas keydown 转发的是官方 core
`input.text`，而 Showcase 的 `@pocket/ui` InputField 使用宿主编辑会话协议
`textInput.open/update/close` 与 `textInput.edit/submit/closed`。发送键盘
commit 到前者不能更新后者，也不能让非编辑性的 Canvas 获得原生 IME 编辑能力。

## 来源和职责

先检索保留的 `pocketjs_flutter_demo`（排除 `pocket_host` 和构建缓存）。
`pocketjs_super_app_demo.html:2105` 创建的 textarea 仅用于复制源码，没有
可复用的浏览器 IME 桥。权威行为来自当前
`sdk/packages/pocket_ui/src/ui.tsx` 的 InputField/parseTextInputParams/
deliverTextInputEvent，以及 `pocket_flutter` 的宿主编辑会话边界。

浏览器补充真实 DOM 编辑适配器，沿用既有 JS 会话、文本、选区、composing、
revision/jsRevision 和实例代次。UI、页面滚动与受控值政策继续归 PocketJS；
不向 Dart 增加网页状态机，不用 Canvas keydown 手动拼接字符串取代原生编辑。

矩形或裁剪更新只移动输入位置，不能重写原生 value/selection 打断 composing；
主动 JS force 更新与编辑回声须区分。原有 core input.text 键盘通道仍供其对应
组件使用，不能向同一个 host 编辑会话重复投递 commit。


## 实现与消融

`client/preview.js` 使用一个按需激活的原生 textarea 承接浏览器编辑；每次
发送完整编辑事实与递增 revision，不再对 host 会话通过 Canvas keydown
重复拼字。`preview.ts` 把既有视频事件暂存统一为有序 `pendingBrowserEvents`，
同时保留中间 settled frame 中的文本会话事件，减少一套重复的队列与清理逻辑。
浏览器事件和页面绘制驱动同步，没有输入探针、周期 DOM 扫描或常驻刷新轮询。

root/child 输入事实均校验实例 generation token；子应用矩形投影到实际 slot。
rect-only 更新不替换文本、选区或 composing，过期回声不覆盖当前编辑。
完整 update 可以在网页刷新、本地 textarea 丢失但 Guest 会话仍打开时恢复编辑；
单纯的矩形更新不会恢复焦点。浏览器关闭或编辑失焦沿用 closed/submit 事实。

## 本轮实际验收

```sh
bun test sdk/editor/test/preview_input_browser.test.ts
bun test sdk/editor/test/preview_video_browser.test.ts sdk/editor/test/preview_pointer_recovery.test.ts sdk/editor/test/preview_regions.test.ts
```

主代理执行结果：输入真实 Chromium 验收 **1/1**，含英文、直接 insertText、
Backspace、选区替换、中文 Unicode、composition 事件协议、失焦、iframe
重载后的已有值再输入。日志 `/tmp/pocket-web-input-browser-final.log`。
composition 构造事件不是操作系统候选窗的实机验收。视频/指针恢复/手势区域
回归 **3/3**，日志 `/tmp/pocket-web-input-regression.log`。子代理另执行既有
preview.test.ts，报告 **3/3** 通过。

首轮中文测试暴露的是测试光标预期错误：替换 hello 中选区得到 hio 后，
光标在 i 后、o 前；该位置插中文不应预期追加在末尾。用例明确将光标移至末尾
再验收末尾插入，没有削弱真实 Guest Draft 断言。

用户确认使用 **8793**，已重启该实例加载新适配器，保持其原 workspace、
project-root 和 flutter-root 参数。主代理真实连接
`http://127.0.0.1:8793/api/projects/pocket-host-showcase/preview`：
英文、中文、退格、全选替换实际通过，DOM textarea 和 Guest Draft 均为
“已修复”（`/tmp/pocket-web-input-live-8793.log`）；保持会话打开后重载页面，
重新点击已有值并继续输入后两端均为 `Refresh中文 OK`
（`/tmp/pocket-web-input-live-refresh-8793.log`）。8792 是修复前的复现地址，
不将它误报为本轮已重启的服务。未修改 Dart/Flutter 或编译 Guest 源码。
