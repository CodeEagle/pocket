# Pocket SDK 完整代码与运行证据审核报告（目标版本：`dd6059d`）

- **被审仓库**：`/Volumes/ORICO/Development/Github/pocket`（目标提交：`dd6059d6d1ef95bc957a0b539ffe4e1e230e1961`，全程只读审核，未修改任何正式源码）
- **审核范围**：`dd6059d` 当前快照，兼顾 `c35a3fe..dd6059d` 增量变更与 `dbc924d..dd6059d` 对前序审查报告（`5b5f58d` / `a5dd273`）全部阻断项的闭环复核
- **审核时间**：2026-11-03

---

## 总体判断

**`dd6059d`（含前序 `c35a3fe`）已消除 `5b5f58d` 与 `a5dd273` 中的全部 P0 编译/链路阻断与 P1 安全/状态机/权限阻断项**。全量 Rust/Dart/TS 单元测试、真实 FFI 测试、QuickJS 字节码消融与架构边界检查全部通过。

针对 `dd6059d` 本次提交聚焦的**键盘弹出页面滚动同步、输入框视口裁剪（`clip`）与发布身份优先级（`editor.json` > `pocket.json` > `manifest.json`）**，主干链路已跑通并有对应回归测试覆盖；但从边界交互与长周期运行角度复核，仍存在 **4 项 P2 级残余缺陷**（无 P0/P1 阻断）：

1. **`PocketView._sendPointer` 未对输入框命中区域应用 `_textInputClipRect` 裁剪交集**：当输入框部分滚出 `ScrollablePage` 视口被裁剪时，被裁掉的不可见区域（如顶栏 Header / 底栏 NavigationBar 重叠处）仍会拦截并吞掉 Guest 指针事件。
2. **`viewportLayout` 允许零宽（`allowZeroWidth = true`）绕过了 `measureViewport` 的分栏宽度保护**：当 Duo 分栏 resize 间隙出现 `viewportNode` 宽度为 `0` 时，`viewportLayout` 直接回退到整窗 `ui.__viewport.w` 并覆盖 `lastViewportRect`；且 `ensureVisible` 在 `syncViewportResize` 中滚动后未同步更新 `previousOffset`。
3. **`_scheduleIdleWake` 跨多个 100ms 静置周期会覆盖 `_idleStartedAt` 且每次唤醒连跑 6 帧**：静置超过 1 个唤醒周期后再交互，前序休眠时长会被计入性能窗口分母导致首窗口 FPS 失真偏低；且定时唤醒未做单帧探测即休眠，静置期仍有约 50% 占空比。
4. **`sdk/pocket.ts` 的 `projectConfig` 仍按字段分别回退 `version`/`build`，且 `PocketSession` 缺少宿主升级覆盖旧 OTA 的重启集成单测**。

---

## 1. `dd6059d` 残余问题详情（按严重性排序）

| 严重性 | 位置 | 触发条件、根因与代码证据 | 修复建议 |
|---|---|---|---|
| **P2**（新引入交互边界） | `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:2708-2733`、`2844-2851`、`3615-3638` | `dd6059d` 新增 `_textInputClipRect` 并在 Widget 树中用 `ClipRect` 裁剪 `TextField`（防止输入框随页面滚动时浮在 Header/NavigationBar 之上），但 `_sendPointer` 仍用未裁剪的 `_textInputRect!.contains(Offset(rawX, rawY))` 判断是否命中输入框。当输入框部分被 `_textInputClipRect` 裁掉时，用户点击被裁掉的区域（`_textInputRect \ _textInputClipRect`），Flutter 的 `RenderClipRect` 不会命中 `TextField`，而 `_sendPointer` 却因 `_textInputRect.contains` 为真直接 `return false` 吞掉事件，导致该区域的 Guest 按钮/导航栏无法响应点击且不触发 outside dismiss。 | 增加有效命中矩形计算（如 `_effectiveTextInputRect => _textInputClipRect != null ? _textInputRect!.intersect(_textInputClipRect!) : _textInputRect`，且 `width <= 0 \|\| height <= 0` 视为不命中），在 `_sendPointer` 的 down 过滤与 up outside dismiss 判定中统一使用裁剪后的可见交集。 |
| **P2**（新引入边界矛盾） | `sdk/packages/pocket_ui/src/ui.tsx:427-439`、`855-880`、`918-932` | 1. `measureViewport`（`ui.tsx:855-880`）的 fallback 分支专门限制 `Math.min(fallback.width, liveWidth - fallback.x)` 以防 Duo 分栏 resize 间隙跨过铰链扩成整窗宽度；但 `viewportLayout`（`ui.tsx:428`）调用了 `committedLayout(node, true)`（允许 `width === 0`），当 `rect.width === 0` 时直接用整窗 `liveWidth` 返回非空对象并覆盖 `lastViewportRect`（若 `liveWidth` 未定义还会返回 `width: 0`，导致 Dart 侧 `_textInputRectFromRaw` 因 `width <= 0` 将 `clip` 置为 `null`）。<br>2. `syncViewportResize`（`ui.tsx:939-950`）调用 `ensureVisible` 触发 `scroller.scrollBy` 后未同步更新 `previousOffset`，下一帧 `onFrame` 会将 resize 引起的自动滚入视为用户滚动（`scrolled = true`）；若矮视口下输入框仍部分超界，会被误触发 `input.close()`。 | 1. `viewportLayout` 改用 `committedLayout(node, false)`（仅对 `contentNode` 传 `true` 允许零宽读取高度），使零宽 `viewportNode` 走 `measureViewport` 的 `lastViewportRect` 分栏宽度保护分支。<br>2. 在 `ensureVisible` 执行 `scroller.scrollBy` 后同步更新 `previousOffset = scroller.offset()`。 |
| **P2**（空闲唤醒计量与占空比） | `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:973-981`、`1022-1034`、`1142-1148` | 1. `_scheduleIdleWake`（`pocket_view.dart:975`）每次重休眠都无条件执行 `_idleStartedAt = _lastSchedulerTimestamp;`。当静置跨越 ≥2 个 100ms 周期且期间无新帧（`next == null` 不进 `_recordPerformanceTick`）时，早期休眠时间段被覆盖丢失；用户再次交互产生新帧时，`_performanceWindowStart` 仅扣除了最后一个休眠周期，导致前序休眠时长计入 `durationMs`，首窗口 FPS 被人为拉低。<br>2. 100ms 定时器唤醒调用 `_wakeTicker()` 将 `_idleTicks` 置 `0`，若画面仍无变化会连跑 6 帧（约 100ms）才再次停表，静置期实际约 50% 时间仍在运行 ticker。 | 1. 将 `_scheduleIdleWake` 改为 `_idleStartedAt ??= _lastSchedulerTimestamp;`，仅在 `_recordPerformanceTick` 消费后或窗口重置时清空 `_idleStartedAt`。<br>2. 区分定时器探测唤醒与外部输入/消息唤醒：定时探测唤醒时保持 `_idleTicks = 5`（或单帧探测标志），若首帧 `next == null` 立即重新休眠。 |
| **P2**（发布身份细节与宿主升级单测） | `sdk/pocket.ts:569-584`、`sdk/lib/src/pocket_session.dart:90-92`、`sdk/test/session_integration_test.dart` | 1. `build_guest.ts` 的 `releaseIdentity` 已按 `editor.json > pocket.json > manifest.json` 整对象选源并拒绝非正整数 `build`；但 `pocket.ts:projectConfig` 仍对 `version` 和 `build` 逐字段回退（`typeof editor.build === "number" ? editor.build : (typeof pocket.build === "number" ? pocket.build : 1)`），当 `editor.json` 缺少 `build` 或类型错误时会与 `pocket.json` 混源。<br>2. `PocketSession._initialize` 在内置元数据缺失 `build` 时仍回退 `0`，且 `session_integration_test.dart` 缺少“已缓存旧 OTA build → 宿主升级 `embeddedBuild` 后重启触发 `resetToEmbedded()`”的端到端测试。 | 1. `projectConfig` 与 `releaseIdentity` 对齐，不跨文件混取 `version`/`build` 或在非法 `editor.build` 时静默回退。<br>2. 在 `session_integration_test.dart` 补齐宿主升级 `embeddedBuild` 覆盖旧 OTA 缓存的重启测试。 |

---

## 2. 前序报告（`5b5f58d` / `a5dd273`）问题在 `dd6059d` 的逐项复核状态

| # | 审查项 | `dd6059d` 状态 | 复核结果与证据 |
|---|---|---|---|
| P0-1 | `pocket_runtime.dart` FFI 绑定缺失字段导致编译失败 | **已彻底修复** | `PocketDuplexEndpointNative` 及 `PocketDuplexEndpoint` 的 `abiVersion`/`messageSize`/`capacity` 已补齐并标注 `isLeaf: true`；`sdk`、`pocket_flutter`、`demo` 的 `flutter analyze` 与 `flutter test` 全部通过。 |
| P1-1 | `pocket_update.dart` / `pocket_package.dart` 乱序晋升与同 build 覆盖降级 | **已彻底修复** | `PocketUpdateCoordinator.prepare` 与文件锁内的 `PocketPackageStore.activate` / `commitHealthy` 均校验 `minimumBuild`、`active`、`lastGood` 的最高 build 及同 build 下的 `versionId` 一致性；`pocket_services` 26 项测试全过。 |
| P1-2 | 内置 `build` 元数据与 Editor 发布身份优先级 | **基本修复（余 P2 细节）** | `demo/assets/app.bytecode.json` 与 `guest-manifest.json` 均已写入 `"version": "0.1.0", "build": 1`；`build_guest.ts` 与 `editor/server.ts` 已确保 `editor.json` 权威且更新同步到生成清单。仅余 `pocket.ts:projectConfig` 字段级 fallback 与 Session 升级重启单测待收口。 |
| P1-3 | `pocket_package.dart` 公共路径与指针名未统一校验 | **已彻底修复** | `fallbackFor`、`rollback`、`readPointerId`、`_pointer`、`_loadVersion` 等在 I/O 前统一执行 `_requireSafeToken` 与 `_allowedPointerNames` 白名单检查，越界哨兵目录测试通过。 |
| P1-4 | `sdk/editor/server.ts` Origin 仅比对 hostname 及 multipart 跨源写 | **已彻底修复** | 完整比对 `scheme + host + port`，校验 `Sec-Fetch-Site`/`Sec-Fetch-Mode`，所有写接口（含 multipart `/assets/upload`）强制要求 CSRF token 或 `x-pocket-editor: 1`；Editor 4 项集成测试（98 断言）通过。 |
| P1-5 | `sdk/editor/server.ts` `/updates/...` 产物路由软链逃逸 | **已彻底修复** | `safeArtifactFile` 对 `/updates/`、`/releases/`、`/artifacts/` 逐段 `lstatSync` 拒绝软链并校验 `realpathSync` 边界。 |
| P1-6 | `pocket_view.dart` 连续 6 帧停表导致依赖未来 tick 的任务卡死 | **部分修复（余 P2 计量问题）** | 已引入 100ms `_idleWakeInterval` 周期唤醒与调度器时间戳差值推进（`pocket_view_timer_ffi_test.dart` 通过），但跨多个 100ms 静置周期会覆盖 `_idleStartedAt` 并在每次唤醒连跑 6 帧。 |
| P1-7 | `pocket_plugin.dart` / `hardware_plugin.dart` 方法级权限协商与动态权限声明 | **已彻底修复** | 按方法粒度协商与撤销，支持 `optionalPermissions`（解决 Duo 启动 `hardware.microphone` 声明阻断），`PocketPluginManager.invoke` 与 `HardwarePlugin`（含天气无坐标定位分支）统一校验 `grantedPermissions` 交集。 |
| P1-8 | `pocket_view.dart` / `ui.tsx` 同 ID 迟到旧回显覆盖新值 | **已彻底修复** | 打通 `revision` 与 `jsRevision` 双向单调校验，拒绝旧回显同时保留受控属性 `force: true` 主动改值通道。 |
| P1-9 | `PocketHardwareManager.swift` 相机回调跨队列竞争 | **已彻底修复** | `pendingPhotoResult` 读写统一收敛到 `cameraQueue` 并绑定 `photoCaptureGeneration`。 |
| P1-10 | `sdk/pocket.ts` CLI 拒绝 `--platform=android` 与原生缓存隔离 | **已彻底修复** | 支持 `--platform=android`，按平台分文件记录 `.pocket-build/sdk-native/${platform}.json`，输入指纹涵盖源码、`Cargo.lock`、patch 与构建脚本。 |
| P2-1 | `pocket_config.dart` Set 相等与 `hashCode` 契约不一致 | **已彻底修复** | 使用 `Object.hashAllUnordered` 并以 `Set.unmodifiable` 封装（`config_value_test.dart` 通过）。 |
| P2-2 | 键盘弹出页面滚动与输入框几何/行高同步（`dd6059d` 主题） | **基本修复（余 P2 裁剪命中）** | 新增 `display.viewport` 同步 `onChange` 测量与 `ensureVisible`、`_textInputLineHeight`（对齐 `ceil(fontSize * 1.2)`）、`gapPadding: 0`、`_textInputClipRect` 及 fallback pointer-up 顺序修正；仅余裁剪区外 `_sendPointer` 命中拦截问题。 |

---

## 3. 实际运行验证结果（基于 `dd6059d` 工作区）

| 验证范围 | 执行命令 | 实测输出摘要 |
|---|---|---|
| Rust Runtime & Duplex | `cd sdk/native && cargo test --locked` | **23 通过**（`lib.rs` 17 项 + `duplex_layout.rs` 6 项），0 失败，1 忽略（手动 benchmark） |
| SDK 顶层包 | `cd sdk && flutter analyze && flutter test` | Analyze **0 问题**；单测 **5 通过** |
| `pocket_flutter`（含真实 FFI） | `cd sdk/packages/pocket_flutter && flutter analyze && POCKET_NATIVE_LIBRARY="$PWD/../../native/target/debug/libpocket_flutter.dylib" flutter test` | Analyze **0 问题**；单测与 FFI 集成测试 **51 通过**，0 跳过 |
| `pocket_services` | `cd sdk/packages/pocket_services && flutter analyze && flutter test` | Analyze **0 问题**；单测 **26 通过** |
| `pocket_hardware` | `cd sdk/packages/pocket_hardware && flutter analyze` | Analyze **0 问题** |
| Showcase `demo` | `cd demo && flutter analyze && flutter test` | Analyze **0 问题**；单测 **18 通过**（含 `showcase_admission_test.dart`） |
| SDK Bun 测试（Build / Package / Editor / UI） | `cd sdk && TMPDIR=/tmp bun test` | **19 通过**，0 失败（258 条断言） |
| Showcase JS & 字节码消融 / Native Probe | `cd demo/js && bun test && bash scripts/test_guest.sh` | `bun test` **11 通过**；`test_guest.sh`（可重现构建、字节码消融、native probe 100/500 节点压测）**全部通过** |
| 架构边界检查 | `python3 sdk/scripts/check_architecture.py` | **通过** |
