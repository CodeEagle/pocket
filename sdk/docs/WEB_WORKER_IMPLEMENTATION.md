# 独立 Web Worker：官方 QJBC 执行与浏览器传输

## 来源与边界

先检查保留父工程 `pocketjs_flutter_demo/web_wasm_preview/index.html`；其中 `wasmWorkerStepEcho` 是环形缓冲演示，没有可复用的独立 Worker QJBC 执行路径。本实现复用固定 PocketJS `99924de47c62fa36f526a8791055d91cbbdb3836` 的 `engine/worker/src/worker.c`、`quickjs.c`、`framework/src/io.ts` 和 Worker channel 协议，未引入第二套应用运行时。

浏览器原生 Worker 加载同一个 `pocketjs.wasm`，在独立 QuickJS realm 内执行 `app.worker.qjbc`。Blob bootstrap 是宿主传输代码；应用不通过 `eval`、`importScripts` 或 `app.worker.js` 执行。UI 与 Worker 分属不同 WASM memory，UI mirror 因而在既有 UI QuickJS realm 中按声明维护有界快照/队列；资源请求、事实与 Worker 执行仍由官方 C core 管理。

新增文件：

- `targets/web/src/worker_bridge.c/.h`：官方 C Worker core 的 WASM facade；HTTP 操作出站、资源事实入站、官方 cooperative step 与销毁。
- `targets/web/src/worker_runtime.rs`：QJBC envelope/hash、runtime ABI、binding generation、tickHz、声明与 capability 准入。
- `targets/web/src/worker_channels.rs`：跨 memory 的 UI channel mirror 与每帧 invalidation；复用现有二进制结果 transport。
- `targets/web/worker_transport.js`：浏览器 Worker、fetch、HTTP origin policy 与生命周期。

`build_wechat.ts` 将这些适配层和固定上游 C 源码一起编译到既有 Web 引擎。QuickJS 仍为 0.12.2；Worker 的 512 KiB managed stack budget 与现有 UI realm 对齐，WASM 链接栈为 1 MiB。不能直接把原生栈参数照搬到 WASM。

## 开发应用

按键触发的官方示例还需宿主显式开启 `PocketWebRuntime({ ..., gameInput: true })`；默认不采集游戏键盘/手柄。具体输入 API 见 [游戏输入](GAME_INPUT_IMPLEMENTATION.md)。

在 `pocket.json` 声明 `domains.worker`，沿用官方 Worker nodes/channels 和 `@pocketjs/framework/io` API。在 manifest 声明 `runtime.worker`；HTTP 再声明 `net.http`。这些声明不会自行获得网络授权。

宿主构建时显式提供允许的 origin：

```sh
bun scripts/build_web.ts --project-root=/path/to/app --outdir=/path/to/output \
  --worker-http-origin=https://api.example.com
```

`--worker-http-origin` 可重复传入。运行时的 `workerHttpOrigins` 也是宿主策略，不能让远程应用任意修改。重定向拒绝自动跟随，响应内容按有界分片送回官方 facts；设备 I2C/UART 暂无浏览器 provider，声明不会使它们可用。

输出保留 `app.worker.qjbc`、`app.worker.bytecode.json` 和完整 descriptor，不包含 Worker JavaScript fallback。旧 npm 引擎缺少 Worker ABI 时，构建明确失败；维护者先运行 `scripts/build_web_engine.ts` 生成匹配引擎与 host bundle。消费者使用预编译 SDK，无需 Flutter 或本机编译环境。

## 验收

```sh
POCKET_SOURCE_BUILD=1 \
POCKET_COMPILER_PATH="$PWD/.cache/pocketjs/tools/build.ts" \
POCKET_WEB_ENGINE=/path/to/engine/pocketjs.wasm \
POCKET_WEB_RUNTIME=/path/to/engine/pocket-web.js \
bun test scripts/tests/web_worker_browser.test.ts
```

此测试用 Playwright 管理的 Chromium，编译官方 worker-http UI/Worker QJBC，真实本地 HTTP 服务，键盘触发请求，检查 UI 状态/字节数与画布像素变化。应提供新生成且互相匹配的 engine/host；没有 engine 环境变量时该设备集成测试跳过。

2026-11-07 本地 Chromium 集成回归通过：键盘触发真实 HTTP，请求计数为 1，UI 到达 `Complete`、字节数 15、status 0，截图哈希发生变化，页面与宿主无错误。补充验证连续 12 次请求跨过 8 条 IPC 窗口、hide/show 恢复，以及错误 SHA descriptor 的准入拒绝与清理。构建/输入/官方 Demo/浏览器综合回归为 12 项通过、96 个断言；该数据不包含物理设备或 Safari。

原生 C facade 已实际执行 worker-http QJBC，验证 emit/finish、finish 后迟到事件返回 INVALID，以及 destroy 成功。官方 Worker 原生回归覆盖 admission/cancellation/streams/generations/timers/channel/realm/quotas/interruption；这些结果不能替代浏览器或 Safari 验收。

尚不承诺：物理设备 provider、Safari 全矩阵、跨域服务器 CORS 配置、无限计算任务的抢占式终止。浏览器 Worker 隔离不是另一种应用源码执行方式；不支持的契约应明确拒绝。

## 消融与避免重复实现

- 移除应用 Worker JavaScript fallback：只保留编译 QJBC；旧引擎缺 ABI 即构建失败，避免出现 Web 执行另一份源码的双实现。
- HTTP 完成只调用官方 `finish`：手工再投 END 会被官方 core 拒绝为 INVALID；完整浏览器回归已复现并移除该重复路径。
- UI 与 Worker 均复用现有二进制桥和官方 channel 语义；不用 JSON RPC 另建一套业务协议。跨 memory 的字节数组转换在唯一 host 边界完成。
- 按需调度由官方 step/deadline 与真实输入/IO 唤醒，不新增长期轮询 ticker；隐藏时暂停 pump 并冻结 Worker 虚拟时间。

Flutter 配置、Session 准入与输入回归为 33 项通过。维护者完整引擎构建也已通过；本机固定 Rust 1.98.1 安装的 linker 缺少 `libLLVM.dylib`，本次完整构建以 `RUSTUP_TOOLCHAIN=stable`（1.99.1）验证，未改动固定 PocketJS/QuickJS/compiler 版本。
