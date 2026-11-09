# Pocket Game 模板

星尘捕手是可运行的轻量小游戏起点，使用官方 onFrame 和 Focusable；保留现有输入行为和游戏状态，在此基础上换皮肤与扩展玩法。

## 网络与游戏的业务 Worker（AI 开发规则）

- 首次加入官方 `net.http` 网络功能时，AI 自动补齐 `worker.ts`、`pocket.json` 的 `domains.worker`、HTTP node/channels，以及 `runtime.worker` / `net.http` 声明。请求、流式接收和解析走官方 Worker IO，UI 通过 channel 接收进度和结果。
- 宿主读取构建后的 Worker descriptor 后自动装载业务 Worker；官方 Worker HTTP 还需可信宿主配置精确的 `workerHttpOrigins`。不要生成通配授权、启动即联网或 UI frame loop 内请求。
- 游戏寻路、AI 决策、地图生成和批量重计算按需要放入业务 Worker；UI、输入、动画、计分及生命周期仍复用现有 JS 状态和 `onFrame`。简单小游戏不创建空转 Worker，不逐帧复制完整世界状态。
- `renderWorker` 是独立的 Web 渲染开关，默认 `false`；网络和游戏功能不能顺带打开它。是否开启应依据目标游戏的实测。
- 当前初始模板不自带 `worker.ts`。以上“自动”指 AI 开发功能时负责补齐并验证接入；构建器不会扫描并改写现有 `fetch` 或 `dio.request`。`--dio` 选择的原生 Dio 插件会自动使用独立 IO Worker isolate，保持 `dio.request` 接口；它不是 `domains.worker` 或渲染 Worker 开关。Dio 继续使用 `network` 权限及插件 `allowedOrigins`，纯 Dio 功能无需额外创建 JS Worker。
- 采用同一 pinned QJBC/descriptor 管线，不新增另一个 JS runtime。验证真实请求/计算、channel 返回值、错误、取消和隐藏/恢复，不能以文件存在代替可用性验证。独立 Worker 执行域不等于所有宿主都使用独立 OS 线程，也不保证 FPS 提升。

完整接入与来源见 SDK 的 `docs/PROJECT_TEMPLATES.md`、`docs/WEB_WORKER_IMPLEMENTATION.md` 和 `docs/WORKER_IO_IMPLEMENTATION.md`。这些路径相对 SDK 根目录，不是生成项目目录。
