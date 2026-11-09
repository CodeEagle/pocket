# 官方能力详细对照与补齐路线

核对日期：2026-11-07。比较对象是 Pocket 固定使用的官方 PocketJS 提交 `99924de47c62fa36f526a8791055d91cbbdb3836`，不是对 GitHub 最新 HEAD 的兼容承诺。固定来源与补丁入口为 [`prepare_upstream.py`](../scripts/prepare_upstream.py)。本报告对应当前工作区，包含尚未提交的修改。

## 结论与证据边界

当前最值得补的是宿主服务、输入设备和资源工具链，而不是重写布局或控件。官方的布局、响应式 UI、动画、手势、二维物理和 Worker 已有可复用实现；许多差距在 target 声明、provider、资源打包和专项验收之间。

官方 capability registry 有 **32 个能力 ID**，但它不是所有 UI 控件的目录，也不是每个官方 target 都实现全部能力。Flutter 默认 target 只声明其中 `text.glyphs.baked`、`runtime.worker`、`input.touch`、`display.viewport.live`，SystemUI 角色另有 `ui.compositor-surfaces`。运行时可选 grant、SDK 自有插件与这个默认列表分开，不能把默认列表数量当成实际覆盖率。

本次官方 demo 全量扫描为 **35 个：33 个完成构建及一帧原生启动测试，2 个受辅助屏目标限制**。33 个已进入资源 catalog；这不是“33 个游戏全部交互验收”，也不是 Flutter/Web/Safari 的 FPS 或功能覆盖率。结果来源为 `demo/build/official-demos/report.json`，配置为 `frames=1,warmup=0`；可发布 catalog 为 [`demo/assets/apps/official/catalog.json`](../../demo/assets/apps/official/catalog.json)。

判定规则：**已接入**表示有实际执行路径；**部分**表示只有部分契约或专项验证；**缺口**表示当前没有对应的完整宿主路径；**专用目标**表示需要特定设备产品，不应强行作为 Flutter 必选功能。源码存在、demo 能启动、桥接单测通过分别记录，互相不能替代。

## 本轮补齐的证据

- 大图：Lantern 构建复用既有纹理预处理，把绘画母版与运行时纹理分开；QJBC/PAK 经原生执行，点击后产生 12 张真实纹理的 draw ops。见 [大图实现](LARGE_IMAGE_IMPLEMENTATION.md)。
- 游戏输入：Flutter 按需启用，Web 以标准 Gamepad/键盘事实进入官方帧结构；Web 测试实际编译 QJBC 并验证文本与像素变化。见 [输入实现](GAME_INPUT_IMPLEMENTATION.md)。
- 独立 Web Worker：实现及验收边界集中在 [Web Worker](WEB_WORKER_IMPLEMENTATION.md)，浏览器、Flutter 与 Editor 的证据分别记录。

## 官方能力契约与当前宿主

契约来源：`sdk/.cache/pocketjs/contracts/spec/platform-types.ts`、相邻 `contracts/spec/*.ts`；Flutter 声明见 [`flutter_target.ts`](../scripts/flutter_target.ts)，准入见 [`pocket_session.dart`](../lib/src/pocket_session.dart)。缓存由固定脚本重建，不应直接修改。

| 官方能力 | 当前状态及实际含义 | 还能补什么；验收重点 |
| --- | --- | --- |
| `runtime.worker` | 已有独立 QuickJS realm、Worker QJBC、descriptor、channel、唤醒与销毁路径；Editor 和 Flutter 已接线 | 补跨平台、取消/背压/异常/混合域矩阵；不能用 UI realm 模拟 Worker |
| `net.http` | Worker HTTP 已接入，必须同时声明并获 origin grant；本轮本地真实 HTTP 回归通过 | TLS、断网、重定向、超时、取消、体积限制和设备矩阵；禁止在 UI realm 新增平行网络层 |
| `io.offload` | 已有有界 provider、session/generation、取消与迟到结果隔离、录制回放主路径 | 增加实际业务 provider 与压力测试；复用现有 transport |
| `io.i2c`、`io.uart` | 缺少板级 provider | 仅按设备需要接入；普通移动游戏不应默认开启 |
| `input.touch` | 默认支持，已有真实 pointer→Guest→frame 链路 | 多触点、取消、跨 surface 和设备边缘场景 |
| `input.pointer`、`input.cursor` | 触摸/Focusable 可操作不等于完整鼠标 hover 或摇杆合成 cursor 契约 | 完整鼠标边沿、hover、滚轮/拖拽及官方 cursor opt-in；保留官方手势与焦点行为 |
| `input.buttons`、`input.analog.left`、`input.analog.right` | 本轮补入 Flutter 可选键盘、controller 按钮/双摇杆入口；Web 可选键盘与标准 Gamepad 采样；使用官方 bitmask/packed axes | 已有真实 Web QJBC 帧/像素变化回归；Flutter 物理手柄 provider 与 USB/蓝牙设备矩阵仍待接入，见 [输入实现](GAME_INPUT_IMPLEMENTATION.md) |
| `input.text`、`input.ime` | raw text ingress 与 Flutter 系统 IME 已接线；默认 target 未全面承诺这两个官方 capability | 硬件键盘、composing、候选窗位置、emoji/中日韩设备验收；避免 IME 与 raw text 重复投递 |
| `input.touch.auxiliary`、`display.auxiliary` | 缺同一 AppInstance 的第二输出及对应触摸路径 | 成套实现 viewport/资源/坐标/input routing；System child surfaces 不能代替辅助屏 |
| `ui.compositor-surfaces` | SystemUI role 已接入 child session、handle/focus/clip/Z/generation，Editor 有注册表 | 实际多 QJBC 输入、销毁/重装/切换与跨平台场景；保留单一 catalog 来源 |
| `ui.physics` | native core 已启用，基础世界/销毁有测试；默认 target 尚未声明 | 完整碰撞、jelly、zone、particle 与视觉/输入/释放验收后再公开 grant；无需第二物理引擎 |
| `audio.pcm` | SDK 音频扩展与官方 PCM credit/ring/clock 契约须分开；不能由播放功能推定兼容 | 原生音频 sink、credit、欠载、暂停/后台/销毁；复用官方 PCM 契约 |
| `media.playback` | SDK 视频/纹理功能不代表官方 media namespace 全部兼容 | 对齐 open/status/pause/volume/音频时钟、decoder availability、纹理释放 |
| `camera.qr`、`camera.photo` | 已有 SDK `hardware.camera.*` provider；官方直接 camera 契约仍需适配 | 复用权限、采集、纹理与生命周期，补 QR/照片列表/JPEG/删除语义；真机测试 |
| `data.fs` | app/shared JSON KV 已有，但不等于官方每 App 文件树 | 复用路径/配额/分页契约，接 app 隔离目录；大 IO 不另建 Dart 业务状态机 |
| `host.clipboard` | 不能用系统 IME 或通用 RPC 推定完整 clipboard 契约 | copy/cut/paste、异步失败、前后台限制与真实文本编辑场景 |
| `display.viewport.live` | 默认支持动态 viewport | resize 后布局/命中/IME/资源密度一起验证 |
| `text.glyphs.baked` | 默认支持；GLYPH_RUN 已复用官方 glyph page/T8/现有图片通道 | 补文字像素、字体替换、fallback；不是完整 Unicode shaping 保证 |
| `text.glyphs.streamed`、`text.glyphs.runtime` | 低层 font stream 操作存在；完整 archive/runtime 补字服务不能据此推定完成 | 字库打开/取字/提交、取消/配额/缓存失效；任意动态中文与 emoji 用例 |
| `text.layout.native`、`text.layout.offload` | 已有宿主测量及 offload 基础，但官方完整声明/服务/复杂脚本保证仍需专项对齐 | 确认 measure/layout 同 provider，测试 shaping、fallback、换行、离线与超时 |
| `link.companion`、`system.wifi`、`system.agent` | 官方设备/companion 产品能力；不是普通网络、蓝牙或通用 AI 接口 | 按产品接官方协议；不要为追求计数伪造可用状态 |

## 游戏与 UI：优先复用行为，再换皮肤

| 官方层 | 当前已有基础 | 剩余可补与验证 |
| --- | --- | --- |
| 基础节点与绘制 | view/text/image/surface；DrawList→Rust→PFB1→Flutter 资源/Canvas；GLYPH_RUN 已接入 | 每种 draw op 的像素、clip、alpha、变换、资源 revision、释放；原生启动不能代替渲染验收 |
| 控件、滚动、焦点、手势 | 固定 framework 提供现成行为；业务组合在 JS；`pocket_ui` 未完整 re-export 全部上游组件，仍可直接 import upstream components | 补公共 API 暴露；新游戏/App 继承现有点击/拖拽/焦点/滚动/禁用/取消行为，只替换合适的皮肤或明确需要的行为 |
| 动画与调度 | 复用官方 animation/motion/clock；按需 deadline/唤醒已有回归 | 连续动画、输入打断、后台恢复、长时间 idle；不新增 Dart ticker 业务编排 |
| Sprite/图集/IndexedImage | 官方资源与绘制原语可复用 | 完整帧动画、UV/调色板/透明度、像素密度、释放和真实 FPS 专项 |
| DeepZoom/TILESET/虚拟列表 | 官方有实现，zoomlab 等 demo 有启动证据 | 平移缩放、tile 缓存淘汰、大列表交互与内存；不能由一帧启动判定全部支持 |
| 二维物理 | 官方 core 实现已启用 | 复杂交互与稳定帧耗时；继续复用官方 world/body/collider，删除重复状态 |
| 三维场景 | 官方 `engine/pocket3d` 是独立 substrate；当前 Flutter/Web 未接入完整3D，仅有二维/有限2.5D表现 | 缺失、成本大，需另立渲染/资源/输入/平台范围；不能从 surface 或 system.agent 推定已支持 |

此外，`pocket_ui/src/motion.ts` 的数学 helper 不等于官方 `animate/spring`；`video_player`/Texture 的真实视频能力不等于官方 `videoOpen/Tick/Texture/Close` provider；VN 音频 intent 不等于 PCM sink。`TEXT_RUN` 对齐已接线，但 Flutter TextPainter 不能被宣称与所有官方 shaping/Unicode metrics 完全一致。Web 现有可选键盘及标准 Gamepad 设备采样，普通 WeChat 未接 provider 时仍发送 neutral buttons/axes；relative deltas 与 raw GuestFrame text lane 尚不能据此认为全部对齐。

## 工具链、Editor 与资源仍需统一

公开构建以 Solid 与固定 buildGuest→QJBC/PAK 管线为主。官方还有 Vue Vapor、Octane、MicroTS 等分支，但上游存在这些源码不代表当前 SDK 的 import alias、类型、manifest、Worker、Editor、scaffold、字节码验证及发布产物已经全部适配。按需求选择一种接入并做同一场景对照，避免平行维护整套 compiler。

Editor Web Preview 当前通过本地 native probe 执行 Guest；它不是浏览器纯 JS/WASM runtime，也不等于浏览器拥有系统硬件能力。必须分别记录 native 执行、Preview 像素/输入、Flutter bridge 和设备结果。硬件 provider 默认按需注册，不可用时返回真实 unsupported/denied。

尤其需要区分 **Editor Preview 与独立 Web SDK**：独立 Web 现已补齐 Worker QJBC/descriptor 打包和浏览器真实 HTTP 执行，见 [Web Worker 实施](WEB_WORKER_IMPLEMENTATION.md)。另有显式开启的 [Web 渲染 Worker](WEB_RENDER_WORKER.md)，复用同一 UI 引擎；这两类 Worker 的职责不同。Flutter/Editor 的其他能力仍需分别验收。

| 执行环境 | Worker / HTTP | Offload | 生命周期与录制回放 |
| --- | --- | --- | --- |
| Flutter native | 真实独立 realm；HTTP origin/redirect/size/timeout/backpressure/cancel 路径存在 | native 有界队列 + Dart provider/broker | 已有 pause/虚拟时钟/stop/join/generation 及 trace/replay 主路径；完整混合流式与设备矩阵待补 |
| Editor Web Preview | native probe 执行真实 Worker；本地 HTTP 完成实测 | 不能推定有与 Flutter 等价的实际 provider | probe 可记录/回放；浏览器仅做 DrawOps/事件投影 |
| 独立 Web SDK | 独立 Worker QJBC/descriptor 与真实 HTTP 已验证，主线程/渲染 Worker 模式各连续 12 请求 | UI 引擎与 raster 可显式移入渲染 Worker；其他 offload provider 仍需验收 | 隐藏/恢复、销毁已验证；不具备完整 replay 证明 |

对应复用入口为 `native/src/worker.rs`、`native/src/offload.rs`、`packages/pocket_flutter/lib/src/pocket_worker_runtime.dart`、`pocket_offload_runtime.dart`、`pocket_recording.dart`。独立 Web 先检查既有 Web runtime 是否具备独立 realm，再补 artifact/config/provider，不能仅复制 Worker 文件就宣称支持。Flutter hidden 会冻结 Worker 虚拟时钟，但 native IO deadline 仍由其域管理，不能描述为所有 IO 全部暂停。

本轮全量 Editor rebuild 另遇资源打包阻断：新增 `demo/js/apps/lantern/art/station.png` 为 1024×1536，当前默认 npm 预编译工具中的 PAK compiler 要求单图宽高为 2 的幂且 ≤512。应研究图集、分块/DeepZoom 或明确升级同一 pinned 工具链的资源路径；不能只改 `.cache` 而继续使用另一份预编译 compiler。保留现有原图；此阻断与 Worker 独立 HTTP 回归分开。

版本后台、LAN 发布、签名/包版本/OTA 是 Pocket SDK 的产品层，不能算成所有官方 System provider 已补齐。保留已有更新机制的单一实现：首次完整 PAK、后续按资源差量、manifest/hash 与原子切换；后续能力适配不应新增第二套资源缓存/热更状态机。

公开 target 的能力声明与 Session 的实际 grant 也须分别验收：前者表达编译/解析目标，后者由宿主配置和 provider 决定。报告内 `hostCompatibility` 保留当前默认 Session 的缺口，不能仅修改 target 列表就宣称能力可用。

可继续复用官方 `framework/src/devtools.ts`、`tools/devtools.ts` 及调试 transport 的 inspect/pause/step/tape 语义；当前 Editor 有预览和录制基础，并不等于已移植整套官方设备调试工具。预编译 package manifest 同时校验 revision/ABI/hash，发布时应把 source 与 packaged tools 的一致性纳入门槛。

## 建议补齐顺序与完成门槛

下面按独立工作包估算，不按 capability ID 简单计数，也不在缺少设备数据时承诺人日。

| 优先级 | 工作包 | 工作量判断 | 完成门槛 |
| --- | --- | --- | --- |
| P0 | 构建/资源入口一致性与大图方案 | 中；直接阻断当前新游戏构建 | 同一 pinned compiler 在 scaffold/Editor/Showcase 都可构建，大图实际显示且无重复缓存 |
| P1 | 独立 Web Worker/HTTP/offload 与回放 | 中到大，取决于现有 Web runtime 独立 realm 支持 | Worker artifact/config 完整；浏览器真实请求/取消/销毁/离线回放；Editor native preview 不能代验 |
| P1 | 键盘/鼠标/游戏手柄与官方 capability 准入 | 中 | 真输入驱动 Guest 帧变化，断连/取消/焦点/死区测试；不靠伪造 target grant |
| P1 | PCM/官方 media 适配 | 中到大，依平台 sink/decoder | 有声、音画时钟/credit/后台/销毁实测；Web Preview 与 Flutter 分别验收 |
| P1 | 动态字体与文本布局 | 中到大 | 任意输入中文/emoji/复杂脚本、字体 fallback、取消/释放及 measure/layout 一致 |
| P1 | Sprite/DeepZoom/physics 专项与声明对齐 | 小到中，主要是接线与场景验证 | 真实输入、像素变化、资源释放和持续帧耗时；通过后才提升支持等级 |
| P2 | 官方 FS/clipboard/camera 适配 | 中，可按三个独立 provider 推进 | 路径隔离/配额、真实剪贴板、真机权限与相机生命周期；保留已有 provider |
| P2 | Worker/HTTP/offload 可靠性矩阵 | 中；主链已经存在 | TLS/取消/背压/重放/配额/迟到消息和移动平台验证 |
| P3 | 辅助屏、其他 framework、板级 IO/companion | 大或产品专用 | 先确定需求；双屏需完整输出+输入，framework 需同一发布管线，硬件需实际设备 |

因此，近期还有 **8 组高价值工作包**可推进（P0/P1/P2 各行），其中一部分是补验证/适配而非从零开发；P3 的三类扩展按产品需要决定。不能把它换算成“还缺多少百分比”。

## 来源复用与消融要求

本轮同时检查保留父工程 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`，排除 `pocket_host/`。历史 FFI、权限/硬件、资源与交互用例可作复用来源；旧实现中的模拟成功不能迁回。具体来源与改动已有记录：

- [GLYPH 与调度实施](GLYPH_AND_SCHEDULER_IMPLEMENTATION.md)：父工程 `native/pocket_runtime_multi.c` 的传输参考，实际 glyph/clock 复用固定上游。
- [硬件复用](HARDWARE_REUSE.md)：父工程 `lib/core/real_hardware_bridge.dart` 等；保留真实平台行为，剔除 dummy 照片/权限成功回退。
- [Worker/IO 实施](WORKER_IO_IMPLEMENTATION.md)、[本轮官方 Worker Preview](WORKER_OFFICIAL_PREVIEW.md)：复用固定上游独立 Worker 与 IO 契约；父工程无可直接复用的独立 Worker HTTP 实现。
- [System compositor](SYSTEM_COMPOSITOR_IMPLEMENTATION.md)、[多应用实施](MULTI_APP_IMPLEMENTATION.md)：继续沿官方 catalog/role/surface 与现有薄宿主路径。

每个后续包都先做消融对照：现有路径与新增适配执行相同交互，观察输入→帧、像素/资源、native 调用、内存与唤醒。删除重复布局、重复 provider、重复 Dart 状态与重复缓存；只有实测差距才增加新层。

本轮新增证据：官方35 demo sweep；Worker UI+Worker真实编译及本地 HTTP 完成回归；Flutter Worker catalog 路径/grant测试。没有新增所有服务、真机功耗、Safari 全量兼容或持续 FPS 的证明。旧 [UI 审查](POCKETJS_FEATURE_PARITY_UI.md) 与 [服务审查](POCKETJS_FEATURE_PARITY_SERVICES.md) 是接入前基线，涉及 Worker/focus/raw text 等结论以较新的实施记录为准。

## 附录：35 个官方 demo 的声明与启动结果

以下从本轮报告逐项摘录。`passed` 仅指构建与一帧原生启动；required/enhanced 是应用声明，不能反推出 Flutter 已提供这些能力。

| Demo | 原生启动 | Required（省略共同的 baked glyph） | Enhanced |
| --- | --- | --- | --- |
| `3ds-demo` | platform_limited | `display.auxiliary`, `input.buttons`, `input.touch.auxiliary` | `input.analog.left` |
| `blackberry-classic-demo` | passed | `input.buttons` | `input.touch` |
| `cafe` | passed | `input.buttons` | — |
| `cards` | passed | `input.buttons` | — |
| `chrome` | passed | `input.buttons` | — |
| `clear` | passed | `input.touch`, `io.offload` | — |
| `companion-zero` | passed | `input.buttons` | — |
| `cursor` | passed | `input.buttons` | `input.cursor` |
| `devkit` | passed | `input.buttons` | — |
| `gallery` | passed | `input.buttons` | — |
| `gba-hero` | passed | `input.buttons` | — |
| `hero` | passed | `input.buttons` | `display.viewport.live` |
| `im` | passed | `input.buttons` | `input.analog.left` |
| `iphone16-demo` | passed | `input.touch` | — |
| `iphone2g-demo` | passed | `input.touch` | — |
| `iphone4s-demo` | passed | `input.touch` | — |
| `ipodnano-hero` | passed | `input.buttons` | — |
| `ipodtouch-demo` | passed | `input.touch` | — |
| `launcher` | passed | `input.buttons` | — |
| `library` | passed | `input.buttons` | — |
| `meizu-m8-demo` | passed | `input.touch` | — |
| `motions` | passed | `input.buttons` | — |
| `music` | passed | `input.buttons` | `audio.pcm` |
| `nexus` | platform_limited | `display.auxiliary`, `input.buttons`, `input.touch.auxiliary`, `ui.physics` | `system.agent` |
| `nexus-touch` | passed | `input.touch`, `ui.physics` | — |
| `note` | passed | `input.buttons` | `display.viewport.live`, `host.clipboard`, `input.ime`, `input.pointer`, `input.text`, `text.glyphs.runtime`, `text.layout.native` |
| `notifications` | passed | `input.buttons` | — |
| `nsengine` | passed | `input.touch` | — |
| `settings` | passed | `input.buttons` | — |
| `solid-aot-lab` | passed | `input.buttons` | — |
| `stats` | passed | `input.buttons` | — |
| `text-cjk` | passed | `input.buttons`, `io.offload`, `text.glyphs.streamed` | — |
| `text-offload` | passed | `input.buttons`, `io.offload`, `text.layout.offload` | — |
| `worker-http` | passed | `input.buttons`, `net.http`, `runtime.worker` | — |
| `zoomlab` | passed | `input.buttons` | — |
