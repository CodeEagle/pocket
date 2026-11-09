# Web 渲染 Worker

## 能做什么

独立 Web SDK 在显式启用时把现有 Pocket UI runtime、QuickJS UI QJBC、布局、DrawList、WASM 软件 raster 和 Canvas2D 上传移到一个浏览器 Worker。主线程保留 HTML canvas、指针/键盘/手柄设备事实、DOM IME、localStorage 与已注册的权限/原生能力边界。业务 UI、状态和控件仍属于同一份 JS 应用。

这不是把 `ui.*` 开放到官方业务 Worker。官方 `engine/worker/README.md` 明确其 Worker 没有 UI namespace。应用的 `domains.worker` 仍执行原来的独立 Worker QJBC，通过同一官方 channel 协议与 UI 通信；渲染 Worker 只是改变已有 UI 引擎的执行位置。

默认关闭，使用主线程 renderer。宿主可以在运行时设置 `renderWorker: true`（或 `config.renderWorker: true`），也可以构建时传入 `--render-worker` 来启用；`renderWorker: false` 或 `--no-render-worker` 可显式关闭。Flutter 渲染线程/原生 renderer 不在本次实现范围内；Flutter 与 Web 的硬件开关也不会因为开启渲染 Worker 自动获得授权。

## 使用预编译 SDK

构建产物应包含匹配的 `pocket-web.js`、`pocket-render-worker.js` 和 `engine/pocketjs.wasm`；应用仍是 `app.qjbc` 和 `app.pak`。消费者无需 Flutter、Rust 或自行编译 Worker entry。

```sh
bun scripts/build_web.ts --project-root=/path/to/app --outdir=/path/to/output
```

默认构建使用主线程 renderer，不会包含 `pocket-render-worker.js`。需要 Worker 的包应显式传入启用参数：

```sh
bun scripts/build_web.ts --project-root=/path/to/app --outdir=/path/to/output \
  --render-worker
```

如果要明确生成主线程包，也可以传入关闭参数：

```sh
bun scripts/build_web.ts --project-root=/path/to/app --outdir=/path/to/output \
  --no-render-worker
```

Worker-enabled 包包含 Worker asset，可由宿主显式选择，方便做开启/关闭对照。省略 `renderWorker` 时默认使用主线程：

```js
import { PocketWebRuntime } from './pocket-web.js';

const config = await fetch('./pocket.config.json').then(response => response.json());
const runtime = new PocketWebRuntime({
  canvas: document.querySelector('canvas'),
  engineUrl: './engine/pocketjs.wasm',
  qjbcUrl: './app.qjbc',
  pakUrl: './app.pak',
  config,
  renderWorker: true, // 显式启用；省略时使用主线程 renderer
  renderWorkerUrl: './pocket-render-worker.js', // 默认与 pocket-web.js 同目录
  gameInput: true, // 游戏键盘/标准手柄另行按需开启
  onError: error => console.error(error),
});
await runtime.mount();
```

显式 `renderWorker: false` 可以覆盖 config 的选择。开启后不能先对这个 HTML canvas 调用 `getContext()`；Canvas 控制权必须转交给 Worker。不支持 Worker/`transferControlToOffscreen`/OffscreenCanvas 2D 或 Worker asset 被 CSP/网络拒绝时，会明确失败，不静默启动第二个 renderer。失败或 dispose 后若要重新挂载，创建新的 HTML canvas；已转移的 canvas 不能重新转移。

使用 HTTP(S) 服务，Worker entry 应同源可达；CSP 需要允许该 module Worker。业务 Worker 的 HTTP origin allowlist 仍由宿主显式配置，和渲染开关无关。

## 输入与浏览器能力

沿用 `registerCapability()`、`setPermissionHandler()`。Worker 把调用转交到主线程的同一个注册表，不复制应用权限策略。异步处理器使用 `context.signal` 取消；隐藏或销毁时取消待处理边界请求，拒绝迟到响应。capability 返回对象即使包含 `ok` 或 `result` 字段，也属于应用数据，不能被传输层再次解释。

localStorage 的命名空间、配额和序列化仍复用现有 host storage 逻辑；只有浏览器存储访问跨线程转发。IME 的 DOM 输入框保留在主线程，编辑结果进入拥有 UI QJBC 的 Worker，再由 JS 更新界面。自定义界面仍应继承既有控件行为再换皮肤，不在主线程另建 UI 状态。

`hide()`/`show()`、resize 和 `dispose()` 都转发到唯一 owning host。调度继续由现有官方 work-state/deadline 驱动；没有新增持续轮询 ticker。业务 Worker 跟随同一生命周期暂停与恢复。

## 查看真实执行状态

```js
const { nodes } = await runtime.inspect();
const stats = await runtime.stats();
// mode/thread、frameCount、累计 frameDurationMs、逻辑尺寸、像素尺寸等
```

两种执行模式都读取实际 owning host。`frameCount` 是成功完成的 `host.advance` 次数；`frameDurationMs` 是这些调用的累计耗时，包含 runtime advance、present 和画布上传，不能当成 GPU 执行时间。观察 FPS 需比较一段时间内的 frameCount 增量，而不是直接使用应用 tickHz。

主线程不持有渲染 Worker 的 WebAssembly 实例或另一棵 UI tree；调试也通过消息读取真实引擎。输入/控制消息最多 64 个未完成请求，浏览器 capability 边界最多 32 个；超额明确拒绝，dispose 保留独立清理通路。

## 来源、必要适配与消融

先检查保留父工程（排除 `pocket_host/`）：

- `web_wasm_preview/index.html:204-260` 的 `wasmWorkerStepEcho` 是同步环形缓冲演示；实际 `renderLoop` 在主线程。
- `lib/core/ffi_bridge.dart:1994-2025` 明确是 Worker echo 模拟。
- `lib/core/pocketjs_bundle_runner.dart` 与 `lib/render/pocket_ui_components.dart` 的 Dart 场景/Canvas 路径不适合迁回 JS-owned UI 架构。

本次保留 `targets/wechat/template/wechat-host.js` 的 QJBC boot、输入、资源、二进制桥、调度与绘制。`targets/web/render_worker.js` 只提供 Worker 环境的浏览器适配；`render_worker_transport.js` 保留主线程 DOM 与设备边界；`render_observations.js` 是两种模式共用的真实诊断入口。唯一的 capability 注册表仍在既有 host 模块。

消融采用同一份编译 QJBC/PAK，分别关闭/开启渲染 Worker。主线程 WASM 实例化计数、实际节点变化、画布截图、帧数/耗时共同验证执行位置；不把另一个应用、另一种 raster 或静态桥接测试当作加速证据。不经每帧 postMessage 复制 RGBA，OffscreenCanvas 由 owning Worker 直接呈现。

## 运行验证

维护者先生成匹配的 browser host 与 Worker entry，复用现有固定引擎：

```sh
bun build targets/web/browser_runtime.js --target=browser --format=esm \
  --outfile=.pocket-build/web-engine/pocket-web.js
bun build targets/web/render_worker.js --target=browser --format=esm \
  --outfile=.pocket-build/web-engine/pocket-render-worker.js

POCKET_SOURCE_BUILD=1 \
POCKET_COMPILER_PATH="$PWD/.cache/pocketjs/tools/build.ts" \
POCKET_WEB_ENGINE="$PWD/.pocket-build/web-engine/pocketjs.wasm" \
POCKET_WEB_RUNTIME="$PWD/.pocket-build/web-engine/pocket-web.js" \
bun test scripts/tests/web_render_worker_browser.test.ts
```

测试使用 Playwright 管理的 Chromium。Safari、移动浏览器和真实游戏负载需要分别测量；本地轻量场景的 FPS 不代表所有游戏都会提速。

## 本轮实测结果

同一 QJBC/PAK 在 Playwright Chromium 中完成两种模式对照：主线程 WASM 实例化次数从 1 变为 0，实际节点和画布均随输入改变。键盘、DOM IME、storage 往返、自定义 capability、权限、resize、隐藏/恢复与不支持环境明确报错均通过。业务 Worker 在两种模式下各连续完成 12 次真实 HTTP 请求，覆盖超过 8 个 ACK 槽位后的复用。

本机一次约 1 秒轻量场景采样如下；这是 `host.advance` 完成频率，不是 GPU 或屏幕显示 FPS：

| 模式 | 采样时长 | 完成帧数 | 完成频率 | 平均 advance 耗时 |
| --- | --- | --- | --- | --- |
| 主线程 | 1056 ms | 18 | 17.05 次/秒 | 0.52 ms |
| 渲染 Worker | 1053 ms | 14 | 13.30 次/秒 | 0.99 ms |

此样本没有证明 FPS 提升。它证明 UI 引擎与绘制已离开主线程；线程通信有成本，是否改善主线程响应和重负载表现应在目标游戏中测量。Worker 路径默认关闭；只有目标场景测出收益后，才用 `renderWorker: true` 或 `--render-worker` 开启。Safari、移动端和 Flutter 渲染下放尚未获得本轮验收。

验证记录：构建/分发/输入单元检查 17 项、155 断言通过；真实业务 Worker HTTP 两种模式 2 项、54 断言通过；渲染位置与交互对照 1 项、44 断言通过。合并运行期间曾出现 HTTP 第二模式 120 秒超时，单独重跑及加入阶段定位后的双模式重跑均通过，尚未稳定复现；不据此宣称浏览器矩阵或压力可靠性已全量验收。

默认关闭后的回归通过 7 项测试、87 个断言：省略 `renderWorker` 时使用主线程 renderer，显式启用 Worker，以及缺少渲染 Worker 能力时明确失败均已覆盖。

## 默认开关的性能评估

当前默认关闭，与最新重复负载对照的结论一致；应用可在目标负载验证后选择开启。见 [完整测量方法、结果和限制](WEB_RENDER_WORKER_EVALUATION.md)。
