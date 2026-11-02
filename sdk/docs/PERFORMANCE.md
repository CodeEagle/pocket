# 性能继承与测量

2026-11-02，Apple Silicon；Flutter 3.35.7 / Dart 3.9.2 / Xcode 27.1。以下是本机测量，不是跨设备 FPS 保证。

## 已继承的优化

对照 PocketJSKit 的实际文件：

- `pocket_view_painter.dart` 与 `pocket_text_cache.dart` 完全一致。
- native delta marker → Dart 不解码完整帧、不触发视觉 setState。
- 每 32 DrawOps 一块 RepaintBoundary；未变化分块保留 raster layer。
- 共享有界 TextPainter LRU，容量 256；图片按 identity/revision/epoch 缓存。
- native DrawList 缓存、frame JSON 缓存、资源 revision 去重、浮点 deltaMs 均保留。

原 demo 中模拟 C/runtime 的 dirty mask、ring buffer、忽略时间步进的“高 FPS”路径没有迁入真实 QuickJS 引擎。Web 编辑器 CSS/动画优化也不是 Flutter 性能证据。

## macOS profile 实测

`bun run profile:macos` 使用真实 vsync 与 Flutter FrameTiming。预热后每场景测 4 秒，不通过循环 `pump(16ms)` 制造 FPS；静态页面仍运行 native ticker，Canvas paints 是实际 paint 调用计数。

| 场景 | 实测 Hz | UI build p95 | raster p95 | 超出 16.67ms 预算帧 | Canvas paints |
| --- | ---: | ---: | ---: | ---: | ---: |
| 首页静态 | 60.0 | 0.74ms | 2.50ms | 0 / 244 | 0 |
| 每个 vsync 更新 JS 计数 | 59.7 | 5.28ms | 2.29ms | 1 / 240 | 238 |
| 500 retained nodes 静态 | 60.0 | 1.49ms | 6.99ms | 0 / 241 | 0 |

原始本机产物：`artifacts/performance/macos-profile.json`（生成文件，不提交）。Profile 构建同时修复了 macOS project 的架构配置：当前 Rust 归档只支持 arm64，因此 profile/release 明确使用 arm64。

## iPhone Duo 模拟器 debug 实测

同一 `performance_test.dart`，iOS 27.1、60Hz、每场景 4 秒：

| 场景 | 实测 Hz | UI build p95 | raster p95 | 超预算帧 | Canvas paints |
| --- | ---: | ---: | ---: | ---: | ---: |
| 首页静态 | 60.0 | 1.49ms | 1.16ms | 0 / 243 | 0 |
| 每个 vsync 更新 JS 计数 | 60.0 | 4.58ms | 0.86ms | 0 / 235 | 239 |
| 500 retained nodes 静态 | 60.0 | 1.52ms | 2.83ms | 0 / 237 | 0 |

这是模拟器 debug 的真实 engine FrameTiming，不是 iOS 真机数据，也未覆盖 500 节点持续动画。本轮没有复现用户报告的持续低 FPS；需对齐具体页面、设备与操作后继续定位，不能据此否定用户现象。

## native full / delta 消融

`native/src/bin/pocket_bench.rs` 直接链接 release runtime，加载真实 qjbc/PAK，预热后采集 300 帧。结果只包含 engine/FFI，不包括 Dart JSON 解码、widget build 或 GPU。

| 场景 | full p50/p95/p99 | delta p50/p95/p99 | 返回数据 |
| --- | --- | --- | --- |
| 首页静态 | 25/28/35µs | 22/24/26µs | full 约 27.1KB/帧；delta 平均 108B/帧（含首次完整帧） |
| 动态计数 | 94/98/100µs | 94/197/280µs | 两者约 27.1KB/帧 |

delta 在空闲场景约减少 250 倍返回数据；当前实现是在完整 guest/layout/resource pass 后判定，所以 native CPU 降幅较小。动态场景不保证加速，单次短测 p95 的波动不能直接当成长期回归。

```sh
cd /Volumes/ORICO/Development/Github/pocket/sdk
cargo run --locked --release --manifest-path native/Cargo.toml --bin pocket_bench -- \
  --bytecode ../demo/assets/app.qjbc \
  --pak ../demo/assets/app.pak \
  --frames 300
cd ../demo/js
bun run profile:macos
```

## 后续结构优化与历史基准

当前实现已落地 PFB1 二进制 frame/resource ABI，数值 DrawOps 与像素数据不再走完整帧 JSON；Dart 仍会复制借用 buffer 并解码，并非端到端零拷贝。上文 full/delta 表为当时 JSON 路径的历史测量，不能作为当前 PFB1 的基准。native 的早期 needs_frame/visual epoch、减少 DrawList 全量比较与 clone 仍可研究。后续应针对可复现的低 FPS 场景测出占用，不通过跳过定时器、Promise、输入和动画语义换取名义 FPS。

模拟器 debug 与真机 profile/release 必须分开记录；这轮没有 iOS 真机性能结论。

## 持续 FPS 标签与历史

- 右上角常驻 `FPS xx | min xx`，由 `showDebugFps` 显式控制，debug/profile/release 均可显示。`min` 是当前 runtime 会话最低采样值；首次有效窗口前显示 `--`。
- 每约 1 秒记录真实 ticker 时间窗口：FPS、frames、durationMs、maxGapMs、超过 1.5 个显示帧预算的 slowFrames、refreshHz，以及桥接/解码耗时 p95（兼容字段名 `nativeMsP95`，并非纯 native CPU）。
- 窗口之间保留连续时间基线，避免漏掉边界处长卡顿或把首个零间隔 tick 算成一帧；暂停/恢复重置窗口，后台停留不记作低 FPS。初始字节码加载不计入。
- **Host → Runtime → FPS history** 是 JS 页面，显示最近 60 点、最低 FPS 与时间戳。独立 performance signal，避免每秒诊断样本重建整个业务状态或 500-node 列表。
- 内存和文件保留最近 600 条；每 10 条及正常 dispose 时异步串行写盘。日志错误不会使业务 runtime 回滚；硬退出可能丢失最后不足 10 条。
- 本地路径：`getApplicationSupportDirectory()/pocket-performance/<appId>/history.json`。

`../demo/integration_test/fps_history_test.dart` 通过定时阻塞 UI isolate 制造可控卡顿，验证标签最低值下降、JS 历史可见、文件记录大 gap/slow frame 和重启恢复。该测试刻意产生的低 FPS 不能误认为应用自然掉帧。

## 公共 SDK 集成后的基线（2026-11-02）

Duo 模拟器 debug、60Hz，每场景预热后采集 4 秒；原始结果为 `artifacts/performance/sdk-iphone-duo.json`。

| 场景 | 实测 Hz | build p95 | raster p95 | 超预算帧 |
| --- | ---: | ---: | ---: | ---: |
| 首页静态 | 59.508 | 2.009ms | 1.768ms | 1 |
| 每个 vsync 更新计数 | 60.000 | 4.756ms | 0.919ms | 0 |
| 500 节点静态 | 60.000 | 1.655ms | 2.981ms | 0 |
| Glass 静态 | 59.504 | 1.562ms | 3.102ms | 0 |

静态页面 Canvas paints 为 0，动态计数为 240。Glass 预热 3 秒；进入页面时仍观察到短时低帧，不能用稳态结果证明转场或键盘动画不存在卡顿。上述是短时模拟器基线，不是 iOS 真机 profile 性能结论。
