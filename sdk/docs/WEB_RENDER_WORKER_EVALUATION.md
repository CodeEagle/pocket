# Web 渲染 Worker 默认开关评估

## 决策建议

2026-11-07 本机对照结果支持 **默认关闭、按应用开启**，当前代码默认使用主线程 renderer。应用在运行时设置 `renderWorker: true`，或构建时传入 `--render-worker`，即可启用 Worker；`renderWorker: false` 或 `--no-render-worker` 会显式关闭。

两种合成负载均未测出渲染吞吐或主线程定时器响应收益。不能把“运行到了 Worker”当作性能改善，也不能凭本机结果推定所有实际游戏都会退化。建议只有目标游戏在目标设备上测出收益后再开启。

## 方法与结果

脚本：[bench_web_render_worker.ts](../scripts/bench_web_render_worker.ts)。使用 Playwright 管理的 Chromium、480×320 canvas、同一固定引擎及相同 QJBC/PAK；主线程和 Worker 只改变执行位置。轻负载为 8 个动态 View，重负载为 256 个动态 View，onFrame 每帧更新位置和透明度，并更新帧计数文字。

每种负载两种模式各运行 3 轮，顺序 main/worker、worker/main、main/worker。每轮预热 2 秒，采样 5 秒，之后关闭页面。修正原功能测试未关闭前一模式页面的问题，避免另一个 runtime 留在后台。共 12 组采样，无运行时错误。

下表为三轮中位数；定时器列是每轮主线程 20ms interval 的超期延迟 P95，再取三轮中位数：

| 负载 | 模式 | advance 完成频率 | 单次 advance 平均耗时 | 主线程定时器超期 P95 |
| --- | --- | ---: | ---: | ---: |
| 8 个动态 View | 主线程 | 20.32 次/秒 | 0.73 ms | 78.7 ms |
| 8 个动态 View | Worker | 13.78 次/秒 | 0.91 ms | 114.9 ms |
| 256 个动态 View | 主线程 | 18.59 次/秒 | 5.23 ms | 81.6 ms |
| 256 个动态 View | Worker | 12.39 次/秒 | 5.36 ms | 108.1 ms |

Worker 的完成频率在这两个场景分别低约 32% 和 33%。advance 内部耗时没有显著降低，定时器响应也未改善。因此本轮数据没有支持默认开启的性能依据，与当前默认关闭策略一致。

## 指标边界

- advance 频率统计实际 host.advance 完成次数，包含当前 UI/layout/raster/present 路径；它不是屏幕显示 FPS，也不是 GPU 帧时间。
- 当前官方 host 连续调度路径使用约 16ms setTimeout，不是浏览器 vsync。本轮没有另写调度器或修改渲染路径。
- 主线程定时器只反映事件循环调度，不能代替输入到 JS、输入到画布上传或输入到屏幕显示的延迟。此次未测输入到像素延迟。
- Worker stats 的采样端点有消息往返误差；5 秒窗口降低其占比，没有完全消除。
- 定时器延迟较高、各轮存在波动，结果只适合这次本机对照，不能用绝对值推定真实设备体验。没有测量 Safari、手机、能耗、真实游戏及长时间稳定性。
- 先前约 1 秒采样不再作为默认开关的充分依据；本次较长、重复、隔离页面的测量仍然没有发现收益。

## 何时按应用开启

优先用实际游戏的相同场景、相同资源和分辨率对照。既看稳定帧率及帧间隔 P95/P99，也看输入事件到实际绘制完成的 P95，并检查主线程长任务、IME、触控、隐藏/恢复及内存。只有 Worker 明确减少主线程阻塞且没有不可接受的渲染吞吐、输入延迟或内存回退，才对该游戏开启。目标是达到该游戏的帧率和延迟预算，而非仅证明代码执行位置改变。

## 复现

从仓库根目录运行，使用已生成且匹配的 engine/runtime：

```sh
POCKET_SOURCE_BUILD=1 \
POCKET_BYTECODE_BIN="$PWD/sdk/native/target/release/pocketjs_bytecode" \
POCKET_COMPILER_PATH="$PWD/sdk/.cache/pocketjs/tools/build.ts" \
POCKET_WEB_ENGINE="$PWD/sdk/.pocket-build/web-engine/pocketjs.wasm" \
POCKET_WEB_RUNTIME="$PWD/sdk/.pocket-build/web-engine/pocket-web.js" \
bun sdk/scripts/bench_web_render_worker.ts
```

默认原始报告写入 `/tmp/pocket-worker-performance.json`，可通过 `POCKET_RENDER_WORKER_BENCHMARK_REPORT` 指定报告路径。原始报告包含各轮数值、采样时长及错误列表。

父工程来源和保留实现见 [Web 渲染 Worker](WEB_RENDER_WORKER.md#来源必要适配与消融)。本次只增加测量脚本并移除功能测试中的后台页面干扰，没有新增 renderer 或另一套 UI 状态。
