# VN Float32 snapshot 消融记录

日期：2026-11-09。此轮只评估 little-endian `toJson` 是否能省掉已拥有 Float32 snapshot 后的第二次整段字节复制；FFI 到 detached snapshot 的所有权复制仍保留。最终候选未显示一致端到端收益且内存门槛失败，已拒绝晋升，生产源码恢复基线。

## 源码路径与消融边界

- 保留父工程 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/ffi_bridge.dart:1691-1705` 中，`getZeroCopyTransformView` 返回 `floatPtr.asTypedList(...)`（fallback 也返回共享 buffer）。这是对底层可变内存的借用视图；只可在同步调用边界内读取，必须在后续 await、原生更新或 dispose 前消费，不能作为长期 snapshot。这个保留实现用于确认借用边界，不是把父工程实现直接接入 SDK。
- 基线 SDK 的 `baseline-source/pocket_live2d_ffi.dart:274-285,441-445` 先用 `Float32List.fromList(source.asTypedList(...))` 建 detached、只读数组；`baseline-source/pocket_live2d_types.dart:170-178` 随后再用 `Uint8List.fromList(...)` 复制整段 float bytes。两次所有权/序列化复制各自承担不同边界。
- 被拒候选 `candidate-source/pocket_live2d_ffi.dart:262-286,441-447` 只把借用视图同步传给 `PocketLive2dDrawable.detached`；`candidate-source/pocket_live2d_types.dart:132-165,217-247` 仍复制一次形成 detached、只读 Float32 snapshot，little-endian 序列化再返回该 snapshot 的只读 byte view。普通构造器继续复制 response bytes，以隔离可变 injected-provider 数据；big-endian 序列化也未改变。本消融只移除第二次 little-endian bytes copy，不移除原生到 Dart snapshot copy。
- Hiyori 实测每帧有 134 个 drawable、6,716 个动态 Float32 分量（位置、multiply RGBA、screen RGBA，共 26,864 bytes）；数字不含静态 UV/index topology，不能视作整个序列化包大小。证据：`owned-ffi/results.txt:10`。

## 回归证据与基线门槛

- 用 Flutter 3.47.9 执行真实 Mao/Hiyori Core bridge 3 项测试和 snapshot/plugin 18 项测试，均 exit 0、0 skipped；覆盖 detached/read-only、offset view、mutable provider 隔离、真实 Core 更新及 dispose 后旧 packet 字节保持等。命令、结果和 source SHA-256 记录在 `.pocket-build/game-performance-20261109/owned-ffi/{commands.txt,results.txt,source-hashes.txt}`。
- Profile 构建 `baseline-build-result.json` exit 0，SSAA=2；`asset-equality.json` 显示 baseline 与 candidate 的 QJBC（`fd670db3…`）、PAK（`54c923d8…`）及 bytecode metadata hash 相同。基线 soak 完成 7 个 whole 窗口、5 个真实模型 10 秒窗口和 20 个 handle cycles；但 `pocketAcceptance` 要求的 `model-stable-rss` 未完成，drive exit 1，**基线不达标**。
- 20 个 cycle 中只有 16 个 RSS sample window 稳定（cycle 10、15、17、19 不稳定）。首五次 RSS 中位数 481,214,464 bytes，末五次 519,766,016 bytes，增加 38,551,552 bytes（36.77 MiB，8.011%）：超过 20 MiB 绝对阈值，虽低于 10% 相对阈值，`gatePassed=false`。
- 五个模型窗口的基线范围：`buildP95` 12.957–14.536 ms，`rasterP95` 0.507–0.570 ms，`nativeP95` 10.156–11.427 ms；每个 10 秒窗口有 360–404 个 frame timing samples、349–389 次 native calls、4–10 次 over-budget。它们只是候选对照基线，不代表 snapshot 消融的收益。
- 计时限制：`frameTimingCount`/相邻 vsync-start 区间记录交付的 timing samples，不是已呈现 FPS；现有 over-budget 按 build/raster duration 计算，可能漏掉 `toImageSync` snapshot task 成本。GPU 完成时间与内存带宽未测量。详情见 `baseline-response.json` 各窗口 `timingLimits`。

## 完整 A/B 结果：拒绝候选

两组都使用 macOS 27.0.1 / Mac16,10、Flutter 3.47.9 Profile、SSAA2、同一 soak harness，以及相同 QJBC/PAK/metadata/guest manifest/native-asset manifest；FlutterMacOS 与 pocket_live2d 原生库二进制 hash 相同。编译来源以 `baseline-build-result.json` 和 `candidate-build-result.json` 为准；drive 时记录的工作树 hash 不能替代预编译包来源。记录列表中两份独立 timeline test 也变动，但 soak target 未导入它们。

| 模型场景（各10秒） | 基线 build P95 (ms) | 候选 build P95 (ms) |
| --- | ---: | ---: |
| idle 0 | 13.629 | 14.039 |
| idle 1 | 12.957 | 14.059 |
| closeup | 13.272 | 13.143 |
| idle 0 repeat | 14.293 | 14.365 |
| idle 1 repeat | 14.536 | 14.116 |

候选模型 raster P95 为0.475–0.516 ms。超预算样本基线35/1941（1.803%）、候选32/1811（1.767%），均高于1%目标；两组所有模型 build P95 均高于12 ms。FrameTiming 数减少不是正向性能信号，不能解释成 FPS 提升。一次顺序 A/B 中数值双向变化，不支持稳定提速结论。

候选也完成7 whole +5 model +20 cycles，正常存档保持不变，模型句柄和绘制三角均归零；但 RSS 只有18/20窗口稳定（cycle1、12不稳定），首五轮中位数445,956,096 bytes、末五轮483,016,704 bytes，增长37,060,608 bytes（35.34 MiB，8.310%），仍超过20 MiB。两组 `model-stable-rss` checkpoint 均未完成，drive 均 exit1；没有降低阈值或把不稳定窗口排除。原报告的 `stableWindowCount=20` 实际是采样窗口总数，不能当成稳定窗口数；派生统计见 `comparison.json`。

因此撤回两份 runtime 文件的新构造器、所有权标记与 byte-view 路径，以及仅为候选新增的测试。21项通过只证明候选功能边界，不证明性能收益。被拒候选源码保存在 `.pocket-build/game-performance-20261109/candidate-source/`，预编译包、命令、源码/制品hash与完整失败报告同目录保留，可复现此次决定。

这不是完整游戏性能验收：weather/text/menu各5个10秒窗口、三次冷启动、物理移动设备与Windows仍缺，GPU完成时间未测。Live2D清晰度按用户要求延后。本轮未引入新缓存、采样设置或渲染协议。Packed/indexed mesh 是独立后续候选，尚未实现，不与此次消融合并。
