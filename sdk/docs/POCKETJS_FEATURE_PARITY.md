# PocketJS 能力覆盖与性能优先级

最新详细核对见 [2026-11-07 官方能力对照与补齐路线](UPSTREAM_CAPABILITY_AUDIT_2026-11-07.md)：覆盖固定上游32个 capability、UI/游戏能力、工具链与Editor，区分实际接入、运行验证和平台限制。下文保留此前实施记录。

核对日期：2026-11-03。基准是固定上游 `99924de47c62fa36f526a8791055d91cbbdb3836` 的真实契约和本轮实现，不以组件标签数量或源码存在推定已经支持。

证据见 [UI / 绘制 / 输入审查](POCKETJS_FEATURE_PARITY_UI.md)、[服务 / Worker / 工具链审查](POCKETJS_FEATURE_PARITY_SERVICES.md) 以及本轮的 [Compositor 实施记录](SYSTEM_COMPOSITOR_IMPLEMENTATION.md) 和 [Worker/IO 实施记录](WORKER_IO_IMPLEMENTATION.md)。前两份审查中的部分 Worker、focus 和 raw-text 行仍是接入前基线，不能覆盖后两份实施记录的当前状态。下文是补齐能力的顺序，不代表每项都是现有 App 的阻断缺陷。

旧 Demo 的多小程序平台与微信 Host 是另一层能力，核查见 [平台与微信宿主对照](MINI_APP_PLATFORM_PARITY.md)。独立 Session 不等于完整平台，旧 WXML 展示页也不等于 PocketJS Guest 已在微信执行。

## 本轮接入

- GLYPH_RUN 复用上游 glyph page，经既有 image/PFB1/T8 资源链绘制；真实字节码＋PAK 验证 coverage、UV、tint、density 和字体替换释放。
- PocketJS 工作状态与虚拟 timer deadline 驱动 Flutter，移除 100ms idle probe。旧 guest 保守持续运行，连续动画不降采样。
- 输入、响应、duplex 发布和生命周期直接唤醒；覆盖长空闲快进、后台时钟隔离及过期 QuickJS 执行预算。
- 修复 core physics 绑定开关未打开的问题，复用上游实现；世界创建/销毁及无世界时无待办工作通过 native 测试。完整碰撞场景仍待专项验证。
- SURFACE_QUAD 的 inline 可见区域、numeric surface handle 和 word8 focus 已投影到 JSON/PFB1、Dart `PocketCompositorSlot` 及 child input gate；官方 SystemUI 的 child CompositorSurface、clip/Z 序、viewport、focus 和 generation 路径已接通。真实双 QJBC 设备交互仍待验收。
- `GuestFrame.text` 已接入有界 `input.text` ingress，支持 key down/up、commit、composition 和 composition-end；Flutter `textInput.edit` 是独立的系统 IME 通道，不能把两者重复投递。
- `domains.worker` 已保留并生成匹配 ABI 的 `app.worker.qjbc`；native C runner 使用独立 QuickJS realm。声明并获宿主 grant 后，Worker HTTP（origin、超时、取消、背压）和 `io.offload`（有界 provider、session/generation、取消和迟到结果隔离）已有实际宿主路径。原生/C ABI 与 Flutter bridge/runtime 测试覆盖这些边界；i2c/uart 仍无板级 provider。

## 后续顺序

1. **已完成接线，继续做专项保真**：TEXT_RUN alignment、SURFACE_QUAD focus/clip/handle 和 GuestFrame.text 已过 native/PFB1/Dart bridge；Sprite、DeepZoom/TILESET、复杂 physics、多输出及完整文字像素仍需场景覆盖。
2. **已完成 Worker/IO/offload 主路径，继续做平台矩阵**：Worker QJBC、独立 realm、channels、真实 HTTP 和 offload 已接入；默认 target 仍按声明和宿主 grant 准入，i2c/uart、移动端 target 构建与完整流式错误/背压矩阵仍需补齐。
3. **服务契约适配**：按实际需要把已注册 hardware/plugin 能力接到上游模块。`hardware.camera.*` 可用不等于上游 `camera` 流式 API 可用；字体 archive service、其他 upstream provider 仍不应从相邻能力推断完成，避免重复建 provider。
4. **构建和目标覆盖**：公开构建仍固定 Solid；Vue Vapor、Octane、MicroTS 和 feature plan 仍未纳入同一公开构建链。微信 Host 仍由独立目标接入中，不能以 scaffold、mock 或生成脚本宣称完整支持。
5. **确定性录制回放**：普通 UI trace、Worker turn、IO facts、channel publish/latch 和 offload provider 已接入录制/回放；真实 HTTP 已通过销毁原实例、关闭服务后的归档离线验证。完整流式/配额/背压/混合域矩阵仍待补齐，见 [Worker 录制回放计划](WORKER_RECORDING_REPLAY_PLAN.md)。

## 三个验收目标

| 目标 | 观察量 | 取舍 |
| --- | --- | --- |
| 高 FPS | UI/raster 帧耗时、长帧、目标刷新率下动画和滚动 | 复用 core、纹理缓存与二进制帧；先定位真实热点。 |
| 低能耗 | 静态页 ticker/FFI 次数、Timer 唤醒、后台活动 | 已知空闲停表；未来任务单次 deadline；异步等待不逐帧计数。 |
| 响应快 | 输入到帧、消息到帧、IME 一致性 | 输入和异步完成直接唤醒，重活与 UI 执行隔离。 |

[QuickJS codec 实测](TRANSPORT_CODEC_EVALUATION.md) 显示，代表消息改用动态 Protobuf 可缩小体积，却增加 guest CPU 编解码时间。绘制已有 PFB1，指针已有 16-byte lock-free 记录，本轮不增加全量 PB 层。没有设备功耗数据时，不把减少回调换算为省电百分比。

## SystemUI 接入补充（2026-11-03）

本轮补入 JS-owned 多应用策略和 Flutter 薄实例通道，使用官方 PocketSystemV1 catalog、安装快照和 roles.systemUI；新增跨 App 打开/返回、应用调度、共享 JSON KV/消息及有界预热/LRU。官方 child CompositorSurface、focus projection、clip/Z 序和独立 child session 已接通，但这不等于全部 upstream System provider、自动 catalog-to-consumer packaging 或设备级 A/B 验收；详见 [实施与验收](MULTI_APP_IMPLEMENTATION.md) 和 [Compositor 实施记录](SYSTEM_COMPOSITOR_IMPLEMENTATION.md)。上文“没有多应用管理器”是实施前基线，不再代表当前工作区。

## 录制回放接入与其余状态

宿主事务 trace、无墙钟 replay 模式、上游 input/effect 适配和导出入口已实施，验证结果与边界见 [RECORDING_REPLAY.md](RECORDING_REPLAY.md)。这没有自动补完本文件列出的其他上游缺口。

| 能力 | 当前状态 |
| --- | --- |
| GLYPH_RUN、PFB1 绘制、lock-free 指针通道、按需停表和唤醒 | 已接入并有真实字节码/桥接测试；不等于全部 Unicode shaping 或所有字体保真。 |
| JS SystemUI、跨 App 打开/结果、共享 KV/消息、预热/LRU | 已接入，Duo 三个真实应用业务 case 已通过。 |
| Flutter 系统输入、页面跟随滚动、selection/composing；GuestFrame raw text | 系统 IME 与协议已接入；独立 `input.text` 已把 key/commit/composition/compositionEnd 送入 GuestFrame。两条通道不合并；硬件键盘/IME 的设备级验证仍未完成。 |
| 多应用宿主事务录制、离线回放与归档导出/导入 | 已接入；Duo 两个业务 case 通过，三应用 388 个事务/124 帧摘要一致。属于协议和 Guest 输出回放，外部 texture 像素、任意 JS 外部随机源及平台 provider 本身不在保证范围。Worker HTTP/offload 主路径已过离线归档验证，完整边界矩阵见专项计划。 |
| 包版本/签名/OTA、Editor、iOS/Android 插件框架 | 已接入且有分层回归；Android/iOS 真机硬件完整矩阵未验证。 |
| 官方 Flutter System target、动态 child CompositorSurface/focus projection | 已接入官方 surface/handle/focus/clip/generation 路径，并有 native/C ABI + Flutter bridge/model/compositor 测试；真实双 QJBC 设备交互、自动 map packaging 和设备/功耗行为仍未验收。 |
| Worker QJBC、独立 realm、channels、真实 HTTP、`io.offload` | 已接入并有原生/C ABI、构建、Worker probe、Flutter runtime/binding 与归档离线回放测试；HTTP/offload 仍须按声明与宿主 grant，i2c/uart 无 provider。流式/背压/混合域完整录制矩阵未全部验收。 |
| Vue Vapor/Octane/MicroTS 公开构建链 | 尚未纳入当前公开构建链，Solid 仍是默认路径。 |
| 微信小程序运行宿主 | 单 Guest 的真实 QuickJS WASM + QJBC/PAK 在 Node 通过 pointer、状态、像素变化与 host response；动态 System、Worker/offload 明确拒绝。没有 DevTools/真机闭环证据。 |
| 复杂 Sprite/DeepZoom/physics、多输出专项 | 仍有场景、像素、输入或释放覆盖缺口，见 UI/服务审查及实施记录。 |
| 高刷新率真机持续表现、物理能耗 | 未完成对应设备验证；FPS 统计本身不设 60 上限。 |
