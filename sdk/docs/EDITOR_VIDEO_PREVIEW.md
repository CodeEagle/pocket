# Editor 浏览器视频预览

2026-11-04：此前 `client/preview.js` 将所有 `video` DrawOp 作为不支持的
native surface 跳过；图片 atlas/PAK 的资源投影不能替代 MP4 解码。因此这不是
只改资源 URL 就能解决的问题。

## 来源和边界

先对照保留项目 `pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_flutter_ui.js`
的 AuxiliarySurface 视频字段、`pocket_syslib_pages.js` 的视频例子，以及当前
`sdk/packages/pocket_ui/src/video.tsx` / `media.ts` 的生命周期协议。旧示例的
合成帧计数不能直接当作浏览器解码器；对旧目录（排除 pocket_host、构建缓存）
检索也没有找到可直接复用的 MP4 HTTP Range 服务。这次只补浏览器资源和绘制
边界，继续使用官方 PocketJS 字节码、DrawOp 与现有 JS 播放政策，没有另一套布局。

- 浏览器创建真实、静音、playsInline 的 HTMLVideoElement 解码本地视频，再在
  Canvas 原 DrawOp 的位置按裁剪、圆角、BoxFit 和绘制顺序画出视频帧。
- 新视频帧通过 requestVideoFrameCallback 触发重绘；旧浏览器采用媒体自身的
  timeupdate 事件。没有为了播放新增 preview/input、snapshot 或帧定时轮询。
- video.play / video.pause / video.release 沿用现有 guest 事件。原生 probe
  为处理一次输入可能连续执行多次 frame；中间帧的视频命令须保留到浏览器发布
  边界，不能只读取最后一个 settled frame。整批命令先收敛再协调媒体资源。
- 离开可见 DrawList 会释放视频元素；播放意图和显式注销分别处理。video.state
  来自真实媒体事件，不用按钮文字假冒解码结果。子应用诊断带实例代次，迟到的
  旧解码回调不能污染重新打开的应用。
- GET/HEAD `/api/projects/:id/preview/media?asset=...` 返回项目视频资源。
  支持单区间 Range、suffix Range、206/416、正确 MIME；使用已验证文件描述符
  流式读取，避免整段 MP4 读入 JS 内存。只允许 assets 下的视频文件，拒绝路径
  穿越、源代码读取、目录与软链逃逸。子应用资源由已登记应用作用域解析。
- Editor 与测试共用 `sdk/scripts/native_probe_path.ts`，默认选择输入时间戳
  校验后最新的 probe，防止旧 release 二进制遮蔽修复。它是时间戳新鲜度检查，
  不等同于内容摘要证明；显式 probe 路径仍由调用方负责。

## 验收

```sh
bun test sdk/editor/test/preview_media_assets.test.ts sdk/scripts/tests/native_probe_path.test.ts
bun test sdk/editor/test/preview_video_browser.test.ts
```

资源/探针 5 项通过，覆盖 31 个资源断言。真实 Playwright bundled Chromium
验收包括 MP4 解码、Play 后 currentTime 推进、Canvas 视频内部 ROI 像素变化、
暂停后媒体时钟稳定、播放期间无持续 preview/input 轮询，以及切路由后元素清理。
它不是 source 字符串匹配测试，也不把 HTMLVideoElement 存在当作播放成功。

这些结果不等于 Safari/Firefox、远端流媒体/HLS、DRM 或真机功耗已验收。
浏览器支持的编解码器仍由浏览器决定。原生硬件插件、一般 hostSurface 不因本次
视频支持而变成浏览器可用能力。


本轮主代理实跑日志：`/tmp/pocket-web-video-assets-final.log`（资源、作用域、
探针共 6/6）、`/tmp/pocket-web-video-regression.log`（既有路由/页面/cache
3/3）、`/tmp/pocket-web-video-browser-final.log`（真实 Chromium 1/1）。
8792 已加载新代码并重新构建 `pocket-host-showcase`；真实浏览器连接该服务
再次通过，日志 `/tmp/pocket-web-video-live-8792.log`：320×180 MP4、206 Range
响应、播放时间推进、暂停 0.555 秒前后保持一致、路由清理成功。

浏览器验收点击前重新获取 Canvas 几何并等待初始 resize/布局稳定，不能用
首帧缓存坐标去点击后续布局。首轮误点和中间事件丢失的失败均保留为调试证据，
最终测试保留真实媒体时钟和视频 ROI 像素变化的断言。

全仓架构检查当前另因并行改动的 `demo/lib/main.dart` 为 130 行、超过既有
100 行薄宿主限制而失败；本轮没有修改该文件，不能将全仓检查记录为通过。
