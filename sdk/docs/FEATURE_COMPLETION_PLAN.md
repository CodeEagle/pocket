# PocketJS 剩余能力实施计划

2026-11-03。基线为当前工作区（HEAD `bee700e`，保留此前所有未提交的字形、按需调度、多应用和录制实现）。本计划是本轮任务状态的入口，技术结论和实际命令分别落到专项文档与 VALIDATION.md。上游保持 `99924de47c62fa36f526a8791055d91cbbdb3836`。下文把“已接入”“有测试”和“真机/功耗验收”分开：Compositor、raw text、Worker QJBC、真实 HTTP 与 offload 主路径已落地，但不因此宣称设备或完整平台闭环。

## 架构约束与消融

JS SystemUI 唯一拥有应用策略、布局和焦点决策；Flutter/Rust 只承载真实 runtime、DrawOps、系统输入、IO、资源和明确授权的通道。复用旧父工程 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`，排除 `pocket_host/`；旧模拟器/echo/WXML树不能算真实能力。复用官方 Worker turn/facts、CompositorSurface 和同一 QuickJS/PocketJS core，不建第二个布局器或轮询调度器。

默认空闲不得增加 ticker、定时探针或 Worker 轮询。按输入、帧变化、IO 完成和单次 deadline 唤醒。有界资源、generation、取消和关闭先于性能宣传。PB 不替代已测更快的低频 JSON；高频保持现有 PFB1/SPSC。

## 文件所有权与代理

用户本轮明确指定 GPT-6 Luna / Max，覆盖之前的 5.6 Luna 偏好。首批三个原生子代理，均设置 `model=gpt-6-luna`、`reasoning_effort=max`、不再派生；主代理统一运行 Flutter，避免并行工具链锁与设备测试互相干扰。

| 负责人 | 独占范围 | 交付 |
| --- | --- | --- |
| `/root/system_compositor_luna6` | `pocket_system_host.dart`、JS system/platform、`pocket_compositor.dart`及对应测试 | 真正按父 DrawOps 插入 child、clip/Z序/viewport/focus/generation；SYSTEM_COMPOSITOR_IMPLEMENTATION.md |
| `/root/worker_io_luna6` | 新 native worker 模块/build.rs/Cargo依赖、build_guest及测试、新 Dart Worker API | 官方 Worker core/runner、独立线程、QJBC产物、channels/IO/offload/取消/配额；WORKER_IO_IMPLEMENTATION.md |
| `/root/wechat_host_luna6` | `sdk/targets/wechat/`、独立 `build_wechat.ts`、目标测试 | 真 Guest/共享 core 的微信目标与消费者生成包（仍在接入中；当前无 DevTools/真机闭环） |
| 主代理 | native/lib.rs、公共 frame model/runtime/view、App/Session/Config、Demo、目标注册和测量入口 | 中央接线、绘制/输入字段、信任边界、产物签名/OTA一致性、消融和真实运行验收 |

共享文件新增需求先协商所有权，不提交他人改动，不修改现有审核报告。后续独立审查复用已完成代理，保留集成和失败复现时间。

## 顺序与验收门

### 1. 绘制和输入字段

1. **已接入**：TEXT_RUN word1 的 alignment 已贯通 native JSON/PFB1、Dart 模型、文字绘制和缓存字段；只使用 core 已断行文本与 box width，不做第二次换行。
2. **已接入**：SURFACE_QUAD word8 focused、独立 numeric surface handle、原 DrawOp index、full bounds 和 visible clip 已贯通 native → PFB1/JSON → `PocketCompositorSlot`，并由 child input gate 消费。
3. **已接入**：PFB1 保留显式 metadata/version，JSON 诊断和旧帧路径仍保留；当前新增字段不会静默错位。后续仍需扩大跨版本/坏帧拒绝覆盖。
4. **已接入**：`GuestFrame.text` 有界 `input.text` ingress 支持 keyDown/keyUp、commit、composition/compositionEnd。Flutter 系统 IME 的 `textInput.edit` 不与 raw lane 重复投递；公开原始通道仍按 capability/host policy 准入。
5. **部分验收**：native/C ABI 与 Flutter frame/model/input 测试覆盖字段与桥接边界；中文/emoji、像素位置、真实设备硬件输入和录制摘要的扩展覆盖仍需补齐。

### 2. 官方 System 子应用合成

1. **已接入**：JS/catalog 提供稳定 appId→surfaceHandle，可信宿主校验后绑定 `ui.__surfaces`；普通 child 无管理权。
2. **已接入**：SystemUI 使用官方 CompositorSurface，Flutter View 在准确 DrawOps 位置插入 child，裁 visible clip 但保留 full coordinate origin。
3. **已接入**：各 child 使用独立 QuickJS/session 和本地 viewport，focus 由 shell flags 投影，pointer sequence/generation 绑定；focus 切换会取消旧 pointer/IME。
4. **已接入**：create/present/destroy 只存运行事实，已移除全屏 overlay、Dart 第二 app stack 和双焦点路径；保留必要 legacy consumer 兼容。
5. **测试已覆盖，设备未验收**：JS/Bun、native/C ABI、Flutter compositor/model/host 测试覆盖 registry、clip/Z 序、resize、focused-only input、fully clipped residency、generation/迟到回调和 keyed disposal；两真实 QJBC child 的设备级 A/B 交互仍待运行。
6. **已接入**：Flutter target/ABI 声明来自实际 target profile，不借 Web target 宣称支持；生成 `compositorSurfaces` 自动注入 Demo consumer 仍是跟进项。

### 3. Worker / IO / offload

1. **已接入**：官方 `domains.worker` 声明被编为匹配 ABI 的 QJBC；metadata/manifest/hash/资产清单和签名包 admission 校验 `app.worker.qjbc`，拒绝丢 worker 产物的发布。
2. **已接入**：复用官方 C worker core/runner/QuickJS，独立线程/realm 执行；UI channel 在 guest evaluate 前 attach、frame 前 latch，关闭按引用生命周期 detach/stop/join。
3. **已接入**：复用固定 turn/context/facts 顺序和资源/请求/事件/定时器/channel 限额；阻塞 wait + 完成/deadline 唤醒，不靠 UI 帧或 1ms probe 推进。
4. **已接入**：HTTP/流式 IO 按声明 node 和宿主 grant 校验 URL/容量，支持 timeout/cancel、背压和迟到完成隔离；`io.offload` 使用真实有界 provider、session/generation 校验和取消路径。
5. **原生/C ABI + Flutter 已覆盖，平台矩阵仍待补**：Worker probe/原生测试、构建测试、offload 压力/取消测试以及 Flutter worker/offload runtime/binding/FFI 测试覆盖 QJBC、localhost HTTP、channel、取消和 provider wake；i2c/uart 仍 unsupported，Android/iOS target 构建需要 CI/设备复核。Worker 完整确定性录制回放不属于本门，明确见 [WORKER_RECORDING_REPLAY_PLAN.md](WORKER_RECORDING_REPLAY_PLAN.md)。

### 4. 微信 Host

**状态：接入中（由独立 wechat_host 代理负责，尚未收口）。** `sdk/targets/wechat/` 与 `build_wechat.ts` 的 scaffold/构建方向不等于微信 Guest 完整支持。

1. 沿用旧 wechat_host 目标方向：PocketJS Guest 运行在微信小程序；继续核查当前 WXWebAssembly/Canvas2D/系统输入和包限制。
2. 上游 Web 默认源码 evaluator 不能冒称 QJBC。必须实际编译 QuickJS WASM 并加载真实 QJBC/PAK；工具链不支持时保留明确失败门，不生成假成功入口。
3. 继续接正式 DrawOps、glyph/clip/texture 与资源释放；pointer phases/DPR、系统输入、前后台和按需帧；不每帧 setData 全树。
4. 在 sdk 目标下提供消费者生成工具，根目录保持 sdk/demo 两入口；微信能力适配同一 host 请求/权限/取消契约。
5. 真引擎本地运行、微信 DevTools 和微信真机验收分别记录。当前没有 DevTools/真机闭环证据，不能宣称完整支持或真机验收；wx mock 只测 adapter 协议。

### 5. 高刷新率与能耗验收

**状态：未验收。** 当前代码有测量入口和模拟器/静态基线，但没有目标高刷真机持续表现或物理能耗证据。

1. 先枚举真实iOS/Android设备与实际display refresh rate。模拟器不替代120Hz真机。
2. 测量入口保留设备/OS/build mode/温度与供电条件、采样窗口。场景固定：静态、持续动画、滚动/输入、500节点、glass、双child、worker计算/IO。
3. FPS无60上限；动态场景记录frame interval、build/raster/native P50/P95/P99、长帧与输入到可见帧；静态场景以ticker/FFI/定时唤醒次数为主，不强迫产生FPS。
4. 使用系统原生能耗工具（iOS Instruments、Android Perfetto/batterystats/支持的power rails）。窗口等长、排除首次编译/安装、做关闭录制/worker/预热等单变量消融；不从CPU次数推算省电百分比。
5. 无连接的高刷真机或能耗硬件时完成可重复采集和分析工具，标注缺失实测数据，等待设备条件；不能伪造通过。

## 收口条件

每项有源路径、实际改动、可运行命令、成功/失败证据和仍不支持的边界。先 Rust/Bun，再单进程串行 Flutter analyze/test，再真实 QJBC 与设备交互。多应用与录制是现有回归基线，新增 worker/合成不能使它们退化。编译成功、mock 协议通过、native/C ABI、Flutter 测试、模拟器正确、真机性能/能耗是不同证据，不合并成“全部完成”。Worker 完整确定性录制回放、微信 DevTools/真机闭环、高刷新率/功耗验收保留为未闭环项。本轮未获提交/发布指令，保留工作区供审阅。

## Worker 录制回放追加实施

2026-11-03 用户追加要求先规划、再由 GPT-6 Luna Max 子代理并行实现 Worker 完整确定性录制回放。已单列 [WORKER_RECORDING_REPLAY_PLAN.md](WORKER_RECORDING_REPLAY_PLAN.md)：覆盖 Worker turn/时钟、IO facts、双向 channel 的 publish/latch、offload 请求及取消完成竞态。两个录制子代理分别负责 native facts/执行与归档桥接，主代理负责生产 C ABI/offload/验收；JS 承担可在 JS 完成的逻辑与录制控制，Dart 保持必要桥接。真实 HTTP 已通过原实例销毁、关闭服务后归档两次离线回放及篡改拒绝，公开入口已移除旧阻断；完整流式/配额/backpressure/混合域边界矩阵仍待补齐。
