# Pocket 独立回归审查报告（`bee700ebce1d` → `de8b051d3d87`）

- **目标提交**：`de8b051d3d87829ce25f50c021b74c0a11b7d6c8`
- **基线提交**：`bee700ebce1d044cfa27ad31c39e7e0f05bca149`
- **审查范围**：整个提交（共 173 个文件变更，`+40,371 / -992` 行）
- **审查方式**：全量代码走查 + 实际编译/测试/探针/WASM 构建复跑（对正式源码保持严格只读，未回滚或覆盖共享工作区中的其他改动）

---

## 1. 是否达到合入标准，以及阻断原因

### 结论：**未达到合入标准（NO-GO / 阻断合入）**

### 核心阻断原因

1. **[P0] 目标提交 `de8b051d` 中 Showcase SystemUI 宿主能力声明与内核实现失配，且 `demo/test/showcase_admission_test.dart` 实测失败**：
   - 在目标提交 `de8b051d` 中，[`PocketSystemHost`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L42-L52) 与 [`PocketSystemKernel.awaitFirstFrame`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_ui/src/system.ts#L1656-L1661) 已将 `"system.runtime.present"` 替换为 `"system.runtime.awaitFirstFrame"`，但提交内的 [demo/js/manifest.json](file:///Volumes/ORICO/Development/Github/pocket/demo/js/manifest.json#L48-L53) 与 [demo/assets/guest-manifest.json](file:///Volumes/ORICO/Development/Github/pocket/demo/assets/guest-manifest.json#L48-L53) 仍声明旧的 `"system.runtime.present"` 而未声明 `"system.runtime.awaitFirstFrame"`。[`PocketPluginManager.activate`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_services/lib/src/pocket_plugin.dart#L684) 会吊销未出现在 Guest manifest 中的插件能力，导致 `openApp` 调用 `system.runtime.awaitFirstFrame` 时被拒绝（`capability_denied`）。
   - 同时，[demo/assets/guest-manifest.json](file:///Volumes/ORICO/Development/Github/pocket/demo/assets/guest-manifest.json#L5-L8) 将 `"ui.compositor-surfaces"` 列为 `requires`，但 [`showcaseConfig`](file:///Volumes/ORICO/Development/Github/pocket/demo/lib/main.dart#L18-L28) 未包含 `additionalCapabilities: {'ui.compositor-surfaces'}`（该能力仅在 [`_ensureSystemCaps`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L1392-L1415) 内部注入），导致实跑 `flutter test` 时 [showcase_admission_test.dart](file:///Volumes/ORICO/Development/Github/pocket/demo/test/showcase_admission_test.dart#L65-L68) 直接失败：`Bad state: Missing capabilities: ui.compositor-surfaces`。
2. **[P0] CLI（`sdk/pocket.ts`）与 Editor（`sdk/editor/server.ts`）构建/发布流水线丢失 Worker 产物并覆写 `guest-manifest.json`**：
   - [`buildGuest`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_guest.ts#L494-L612) 已生成 `app.worker.qjbc`、`app.worker.bytecode.json` 并在 `guest-manifest.json` 中注入 `domains.worker`、`worker` 描述符与 `"runtime.worker"` 必需能力；但 [`buildProject` (sdk/pocket.ts)](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L624-L644) 与 [`buildProject` (sdk/editor/server.ts)](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L742-L758) 仅复制 4 个主包文件并用原始 `manifest.json` 覆写 `guest-manifest.json`，导致任何带 Worker 的消费端项目通过 CLI 构建或 Editor 发布时丢失 Worker 字节码或直接抛错失败。
3. **[P1] 确定性回放完整性漏洞：截断 `turn.begin` 之后的尾部 Worker 事件可假匹配（`matched: true`）**：
   - [`WorkerTrace::finish_batch`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/worker_trace.rs#L604-L672)、[`replay::set_mode`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/replay.rs#L420-L445) 与 [`PocketReplayRunner._validateReplayEvidence`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L2935-L2975) 均未校验回放结束时 `state.active_turns.is_empty()`。篡改录制文件、删去最后一次 Worker turn 中 `turn.begin` 之后的 `turn.facts` / `channel.publish` / `clock.scalar` / `turn.end` 并更新 `bytes` 后，回放仍返回 `matched: true`。
4. **[P1] 微信宿主按需调度器在 `schedule()` 时提前快进空闲帧（`web_wechat_skip_idle_frames`）且 `resize()` 破坏 `this.scale` 不变量**：
   - [`PocketWechatHost.schedule`](file:///Volumes/ORICO/Development/Github/pocket/sdk/targets/wechat/template/wechat-host.js#L246-L258) 在设置 `setTimeout(delay)` 的同一时刻（`t = 0`）立即调用 `web_wechat_skip_idle_frames(host, frames - 1)`，若 `delay` 到期前有任意触摸、`host.response` 或键盘事件到达，虚拟时钟已被提前快进，导致定时器立即提前触发。
   - [`PocketWechatHost.resize`](file:///Volumes/ORICO/Development/Github/pocket/sdk/targets/wechat/template/wechat-host.js#L140-L159) 在窗口或键盘高度变化时会单向缩小 `this.scale`，而 WASM 侧 [`web_resize`](file:///Volumes/ORICO/Development/Github/pocket/sdk/.cache/pocketjs/programs/web/wasm/src/lib.rs#L269-L294) 始终保持启动时的 `scale`，导致 `web_pixels_len` 与 `this.imageData.data.length` 永久不一致，[`draw()`](file:///Volumes/ORICO/Development/Github/pocket/sdk/targets/wechat/template/wechat-host.js#L214) 静默退出演变成黑屏/冻屏。
5. **[P1] 多应用 `awaitFirstFrame` 被 Offstage 预挂载首帧提前满足，且 `isPresented` 与多应用集成测试契约冲突**：
   - [`PocketSystemHost._create`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L307-L311) 创建子实例后立即加入 `hostSurfaceResidents`，[`PocketView._buildSurface`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L4061-L4089) 在 `Offstage(offstage: true)` 下完成子实例首帧并触发 [`_onFirstFrame`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L1158-L1167)，导致 [`_awaitFirstFrame`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L727-L743) 在子 Surface 尚未在合成器中可见（`compositorVisible == false`）时即提前返回。

---

## 2. 确认问题清单（按 P0 / P1 / P2 / P3 排序）

### P0 级（直接阻断构建、准入或核心功能闭环）

#### [P0-1] 目标提交 `de8b051d` 中 Showcase manifest 缺少 `system.runtime.awaitFirstFrame`，且 `showcase_admission_test.dart` 因 `ui.compositor-surfaces` 准入失败
- **文件:行号**：
  - [demo/js/manifest.json:48-53](file:///Volumes/ORICO/Development/Github/pocket/demo/js/manifest.json#L48-L53)（目标提交 `de8b051d` 快照）
  - [demo/assets/guest-manifest.json:5-8,48-53](file:///Volumes/ORICO/Development/Github/pocket/demo/assets/guest-manifest.json#L5-L8)（目标提交 `de8b051d` 快照）
  - [demo/lib/main.dart:18-28](file:///Volumes/ORICO/Development/Github/pocket/demo/lib/main.dart#L18-L28)
  - [demo/test/showcase_admission_test.dart:65-68](file:///Volumes/ORICO/Development/Github/pocket/demo/test/showcase_admission_test.dart#L65-L68)
  - [sdk/lib/src/pocket_session.dart:301-308,343-348](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_session.dart#L301-L308)
  - [sdk/lib/src/pocket_system_host.dart:42-52,1392-1415](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L42-L52)
- **触发条件**：
  1. 在 `demo/` 下执行 `flutter test`（触发 `showcase_admission_test.dart`）。
  2. 在目标提交 `de8b051d` 下启动 Showcase Demo 并打开子应用（触发 `system.runtime.awaitFirstFrame`）。
- **根因**：
  1. `de8b051d` 将系统合成器等待首帧能力命名为 `system.runtime.awaitFirstFrame`（[`_systemRequestCapabilities`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L45)、[`PocketSystemKernel.awaitFirstFrame`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_ui/src/system.ts#L1656)），但 `de8b051d` 提交中的 `demo/js/manifest.json` 和 `demo/assets/guest-manifest.json` 第 50 行仍写着 `"system.runtime.present"`，导致权限协商后 `system.runtime.awaitFirstFrame` 被吊销。
  2. `demo/assets/guest-manifest.json` 的 `capabilities.requires` 包含 `"ui.compositor-surfaces"`，而 [`PocketSession._configureBridgeUnlocked`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_session.dart#L306-L307) 仅在 `config.additionalCapabilities.contains('ui.compositor-surfaces')` 时才注册该内置能力。`demo/lib/main.dart` 的 `showcaseConfig` 只配置了 `compositorSurfaces` 而未配置 `additionalCapabilities: {'ui.compositor-surfaces'}`，导致直接用 `PocketSession(config: showcase.showcaseConfig)` 测试准入的 `showcase_admission_test.dart` 必现失败。
- **实际证据**：
  - `git show de8b051d3d87829ce25f50c021b74c0a11b7d6c8:demo/js/manifest.json` 第 50 行为 `"system.runtime.present"`。
  - 实跑 `cd demo && flutter test --no-pub --concurrency=1 --reporter expanded` 输出：
    ```text
    00:27 +19 -1: /Volumes/ORICO/Development/Github/pocket/demo/test/showcase_admission_test.dart: showcase assets and real plugins pass session admission [E]
      Bad state: Missing capabilities: ui.compositor-surfaces
      package:pocket_sdk/src/pocket_session.dart 354:7  PocketSession._configureBridgeUnlocked
    ```
- **最小修复建议**：
  1. 在 `demo/js/manifest.json` 与重新生成的 `demo/assets/guest-manifest.json` 中将 `"system.runtime.present"` 替换为 `"system.runtime.awaitFirstFrame"`。
  2. 在 [`demo/lib/main.dart`](file:///Volumes/ORICO/Development/Github/pocket/demo/lib/main.dart#L18-L28) 的 `showcaseConfig` 中显式声明 `additionalCapabilities: {'ui.compositor-surfaces'}`（或在 `showcase_admission_test.dart` 中通过 `PocketSystemHost` 准入配置构造 `PocketSession`），保持“子配置不可自授权 `ui.compositor-surfaces`”的安全边界不变。

---

#### [P0-2] CLI（`sdk/pocket.ts`）与 Editor（`sdk/editor/server.ts`）丢弃 Worker 产物并覆写 `guest-manifest.json`
- **文件:行号**：
  - [sdk/pocket.ts:493-497,624-644](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L624-L644)
  - [sdk/editor/server.ts:700-758,825-867](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L700-L758)
  - [sdk/scripts/build_guest.ts:552-566](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_guest.ts#L552-L566)
- **触发条件**：
  - 使用 `bun sdk/pocket.ts build <dir>` 或在 Pocket Studio Editor 中构建/发布声明了 `domains.worker` 的项目。
- **根因**：
  1. [`buildGuest`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_guest.ts#L494-L612) 在临时目录 `staging` 中产出了 `app.worker.qjbc`、`app.worker.bytecode.json`，并向 `staging/guest-manifest.json` 写入了 `domains.worker`、`worker` 描述符与 `capabilities.requires` 中的 `"runtime.worker"`。
  2. 但 [`sdk/pocket.ts:625-643`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L625-L643) 与 [`sdk/editor/server.ts:743-758`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L743-L758) 仅从 `staging` 复制 `["app.js", "app.pak", "app.qjbc", "app.bytecode.json"]`，丢弃了 `app.worker.qjbc` 与 `app.worker.bytecode.json`；随后直接读取源码目录的原始 `manifest.json` 覆写输出目录的 `guest-manifest.json`，抹掉了 `buildGuest` 生成的 `worker` 元数据与 `"runtime.worker"` 声明。
  3. 当 Editor 调用 [`publishProject`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L841-L867) -> [`packageArtifacts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/package_update.ts#L435-L438) 时，因 `app.bytecode.json` 含 `worker` 而 `guest-manifest.json` 无 `"runtime.worker"` 且 `buildDir/app.worker.qjbc` 不存在，直接抛出异常。
  4. 此外，[`sdk/scripts/build_guest.ts:553-565`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_guest.ts#L553-L565) 在设置 `metadataObj.worker = workerDescriptor` 后将 `metadataModified` 初始化为 `false`，若 `metadataObj.version` 与 `metadataObj.build` 已匹配则不会把 `metadataObj.worker` 写回 `app.bytecode.json`。
- **实际证据**：
  - [sdk/pocket.ts:633-638](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L633-L638)：`const guestManifest = { ...readJson(join(project, "manifest.json")), version: config.version, build: config.build }; writeJson(join(output, "guest-manifest.json"), guestManifest);`。
  - [sdk/editor/server.ts:752-758](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L752-L758) 与 [sdk/editor/server.ts:828](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L828) 同样未包含 `app.worker.qjbc` / `app.worker.bytecode.json`。
- **最小修复建议**：
  - 在 `sdk/pocket.ts` 与 `sdk/editor/server.ts` 中基于 `staging` 内由 `buildGuest` 生成的 `guest-manifest.json` 合并 `version`/`build`；当 `built.worker` 存在时，同步复制 `app.worker.qjbc` 与 `app.worker.bytecode.json` 到构建输出目录与 `flutter/assets`（并加入 `readArtifact` 白名单与脚手架 `pubspec.yaml` 资源列表）。
  - 将 [sdk/scripts/build_guest.ts:555](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_guest.ts#L555) 改为 `let metadataModified = workerDescriptor !== undefined;`。

---

### P1 级（严重正确性、确定性回放防篡改、多应用生命周期或微信目标缺陷）

#### [P1-1] 确定性回放未校验未闭合的 Worker turn，删除尾部 `turn.begin` 之后的事件可获得假 `matched: true`
- **文件:行号**：
  - [sdk/native/src/worker_trace.rs:604-672,725-740](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/worker_trace.rs#L604-L672)
  - [sdk/native/src/replay.rs:420-445](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/replay.rs#L420-L445)
  - [sdk/native/src/lib.rs:734-747](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L734-L747)
  - [sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart:2935-2975](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L2935-L2975)
- **触发条件**：
  - 将合法 v2 Worker 录制中最后一个含 Worker 活动的事务（如 `frame` 或 `captureStop`）里的 `workerEvents` 截断在 `turn.begin` 处（删去后续 `turn.facts`、`channel.publish`、`clock.scalar`、`turn.end` 并同步更新顶层 `bytes` 字段），然后传入 [`PocketReplayRunner.run`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L2391-L2532)。
- **根因**：
  1. [`pocketValidateTraceClockEnvelope`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_recording.dart#L821-L890) 与 [`_validateReplayEvidence`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L2935-L2975) 均未检查 `turn.begin` 是否有配对的 `turn.end` / `worker.exit`。
  2. 回放该事务时，Worker 线程消费 `turn.begin`（向 `state.active_turns` 插入 `session`），随后在等待 `turn.facts` 时因 `state.replay_events` 已空而进入 [`wait_for_session`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/worker_trace.rs#L725-L781) 挂起等待下一批事件，并未设置 `state.failure`。
  3. Host 线程的 [`WorkerTrace::finish_batch`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/worker_trace.rs#L607) 只等待 `state.replay_events.front()` 为 `None`，不检查 `state.active_turns.is_empty()`，返回的 `consumed_events` 恰好只有 `[turn.begin]`，与被篡改的 `traceClock` 完全一致。
  4. 随后的 `captureStop` 调用 `_setTraceClockMode(0)` -> [`replay::set_mode(host, 0)`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/replay.rs#L420-L445)，直接执行 `lane.set_live()` 清空 `active_turns` 与 `failure` 并唤醒 `wait_for_session` 正常返回 `Ok(())`，且 [`stop_worker_checked`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L734-L747) 不检查 `runtime.last_error()`，最终返回 `PocketReplayResult(matched: true)`。
- **实际证据**：
  - [sdk/native/src/worker_trace.rs:172-187](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/worker_trace.rs#L172-L187) 中 `set_live()` 直接 `state.active_turns.clear(); state.failure = None;`，[sdk/native/src/replay.rs:428-436](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/replay.rs#L428-L436) 在 `finalize_offline` 时未检查 `active_turns` 或 `failure` 即调用 `lane.set_live()`。
- **最小修复建议**：
  1. 在 [`WorkerTrace`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/worker_trace.rs) 中新增 `verify_replay_complete(&self) -> Result<(), String>`，校验 `Self::check_failure(&state)?`、`state.replay_events.is_empty()` 且 `state.active_turns.is_empty()`；在 [`replay::set_mode`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/replay.rs#L421) 的 `finalize_offline` 分支中于 `set_live()` 之前调用该方法。
  2. 在 [`stop_worker_checked`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L734-L747) 中检查 `runtime.last_error()`。
  3. 在 [`PocketReplayRunner._validateReplayEvidence`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L2935-L2975) 中跨事务追踪 `turn.begin` / `turn.end`（及 `worker.exit`）配对完整性，未闭合则拒绝回放。

---

#### [P1-2] 实时录制 `captureStop`（`Mode::Record`）未等待进行中的 Worker turn 结束即切回 `Mode::Live`，导致录制被腰斩
- **文件:行号**：
  - [sdk/native/src/worker_trace.rs:580-673](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/worker_trace.rs#L580-L673)
  - [sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart:1705-1726](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L1705-L1726)
- **触发条件**：
  - 实时运行中用户在录制面板点击停止录制（触发 [`FfiPocketRuntime._captureStopBoundary`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L1680-L1727)），此时后台 Worker 线程恰好已进入一次 turn（已记录 `turn.begin`，`state.active_turns` 非空），但尚未执行到 `turn.facts` / `turn.end`。
- **根因**：
  - `_captureStopBoundary()` 连续调用 `_traceTransactionBegin()` 与 `_traceTransactionEnd()`（[`WorkerTrace::finish_batch`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/worker_trace.rs#L580-L673)），随后在 `finally` 中调用 `_setTraceClockMode(0)`（`lane.set_live()`）。
  - 在 `Mode::Record` 下，`finish_batch()` 仅把当前 `pending_events` 移入 `batch_events` 并立即返回，**不等待** `!state.active_turns.is_empty()` 收尾；紧接着 `lane.set_live()` 将模式切为 `Mode::Live`，导致该 Worker turn 后半段的 `turn.facts` 与 `turn.end` 不再写入录制，产出一份尾部只有 `turn.begin` 的半截录制。
- **实际证据**：
  - [sdk/native/src/worker_trace.rs:604-672](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/worker_trace.rs#L604-L672) 仅在 `if mode == Mode::Replay` 时有 `wait_timeout` 循环，`Mode::Record` 无任何对 `state.active_turns` 的等待。
- **最小修复建议**：
  - 在 `Mode::Record` 下关闭 `captureStop` 批次前（或在 `replay::set_mode(host, 0)` 切回 `Mode::Live` 前），当 `!state.active_turns.is_empty()` 且 `state.incomplete.is_none()` 时，在 `self.changed.wait_timeout` 上等待活动 Worker turn 完成（受 `CUT_WAIT_TIMEOUT` / `turn_budget_micros` 约束，若超时则 `mark_incomplete`）。

---

#### [P1-3] 微信宿主 `PocketWechatHost.schedule()` 在定时器注册时立即快进空闲帧，且 `resize()` 破坏 `this.scale` 导致 Canvas2D 永久停止绘制
- **文件:行号**：
  - [sdk/targets/wechat/template/wechat-host.js:140-159,210-217,225-261](file:///Volumes/ORICO/Development/Github/pocket/sdk/targets/wechat/template/wechat-host.js#L140-L261)
  - [sdk/.cache/pocketjs/programs/web/wasm/src/lib.rs:269-294](file:///Volumes/ORICO/Development/Github/pocket/sdk/.cache/pocketjs/programs/web/wasm/src/lib.rs#L269-L294)
- **触发条件**：
  1. **提前快进虚拟时钟**：Guest 设置了一个延迟定时器（如 5000ms，`framesUntilTimer = 300`），`schedule()` 注册 `setTimeout(..., 5000)`；在 10ms 时用户点击屏幕或收到 `host.response` / 键盘事件。
  2. **Resize 后画面冻结**：小程序启动时视口较矮（或横屏/窗口较小）使初始 `this.scale = 2`（例如 `390x600`，`Math.floor(1365 / 600) = 2`），随后键盘收起或窗口高度变为 `390x844`（`Math.floor(1365 / 844) = 1`）。
- **根因**：
  1. 在 [`PocketWechatHost.schedule()`](file:///Volumes/ORICO/Development/Github/pocket/sdk/targets/wechat/template/wechat-host.js#L246-L258) 中：
     ```js
     this.running = true;
     this.exports.web_wechat_skip_idle_frames(this.host, Math.max(0, frames - 1));
     const delay = Math.max(1, Math.ceil(frames * 1000 / Math.max(1, Number(state.simulationHz) || 60)));
     this.timer = setTimeout(() => { ... }, delay);
     ```
     `web_wechat_skip_idle_frames` 在设置 `setTimeout` 的瞬间（`t = 0`）就被调用，而不是在 `setTimeout` 到期回调时或按实际经过的毫秒数调用。一旦中途（如 `t = 10ms`）有任何输入到达并调用 `stopScheduled()` + `advance()`，Guest 的虚拟帧计数器已经被提前快进了 `frames - 1` 帧，5000ms 的定时器在 10ms 时立即提前触发。同时 `resize()`（第 157 行）在调用 `this.schedule()` 前未调用 `this.stopScheduled()`，若 `this.running` 为 `true`（正在等待旧 `this.timer`），`schedule()` 在第 227 行直接早退，无法更新定时器。
  2. 在 [`PocketWechatHost.resize()`](file:///Volumes/ORICO/Development/Github/pocket/sdk/targets/wechat/template/wechat-host.js#L144-L155) 中，JS 将 `this.scale` 更新为 `nextScale`（如从 `2` 变为 `1`）并重建 `this.imageData`（长度为 `nextWidth * nextHeight * 4`），但 WASM 侧 [`web_resize`](file:///Volumes/ORICO/Development/Github/pocket/sdk/.cache/pocketjs/programs/web/wasm/src/lib.rs#L275-L278) 计算 `let scale = physical[0] / old[0];` 仍保持启动时的 `scale = 2`（像素缓冲区长度为 `nextWidth * nextHeight * 16`）。此后每一帧 [`draw()`](file:///Volumes/ORICO/Development/Github/pocket/sdk/targets/wechat/template/wechat-host.js#L214) 检查 `if (!pointer || length !== this.imageData.data.length) return;` 恒成立，画面永久停止更新。
- **实际证据**：
  - 对照 [wechat-host.js:144-155](file:///Volumes/ORICO/Development/Github/pocket/sdk/targets/wechat/template/wechat-host.js#L144-L155)、[wechat-host.js:214](file:///Volumes/ORICO/Development/Github/pocket/sdk/targets/wechat/template/wechat-host.js#L214)、[wechat-host.js:249-258](file:///Volumes/ORICO/Development/Github/pocket/sdk/targets/wechat/template/wechat-host.js#L249-L258) 与 [programs/web/wasm/src/lib.rs:273-278](file:///Volumes/ORICO/Development/Github/pocket/sdk/.cache/pocketjs/programs/web/wasm/src/lib.rs#L273-L278)。
- **最小修复建议**：
  1. 在 `PocketWechatHost.schedule()` 中记录 `this.timerStartedAt = Date.now()` 与 `this.scheduledHz`，仅在 `setTimeout` 到期回调中调用 `web_wechat_skip_idle_frames(this.host, Math.max(0, frames - 1))`；若在到期前被 `stopScheduled()` 取消，则按实际经过时间 `Math.min(frames - 1, Math.floor((Date.now() - this.timerStartedAt) * this.scheduledHz / 1000))` 推进空闲帧。在 `resize()` 中先调用 `this.stopScheduled()` 再调用 `this.schedule()`。
  2. 保持 `this.scale` 在 `web_wechat_boot` 之后不可变；`resize(width, height)` 中不修改 `this.scale`，而是按 `Math.floor(MAX_CANVAS_DIMENSION / this.scale)` 约束逻辑宽高。

---

#### [P1-4] 多应用 `openApp` 的 `system.runtime.awaitFirstFrame` 被 Offstage 预挂载首帧提前满足，且 `SystemUI.isPresented` 与集成测试断言冲突
- **文件:行号**：
  - [sdk/lib/src/pocket_system_host.dart:307-311,337-360,679,727-743,1158-1167,1336](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L307-L360)
  - [sdk/packages/pocket_flutter/lib/src/pocket_view.dart:4061-4089](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L4061-L4089)
  - [demo/integration_test/multi_app_test.dart:92-95](file:///Volumes/ORICO/Development/Github/pocket/demo/integration_test/multi_app_test.dart#L92-L95)
  - [demo/integration_test/guest_interaction_test.dart:51-75,98](file:///Volumes/ORICO/Development/Github/pocket/demo/integration_test/guest_interaction_test.dart#L51-L98)
- **触发条件**：
  1. 通过 `prewarmApp` 预热子应用后再 `openApp`，或冷启动子应用时其 `Offstage` 预挂载在 `awaitFirstFrame` 调用前已完成首帧渲染。
  2. 运行 [demo/integration_test/multi_app_test.dart](file:///Volumes/ORICO/Development/Github/pocket/demo/integration_test/multi_app_test.dart#L92-L95)。
- **根因**：
  1. [`PocketSystemHost._create`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L662-L679) 创建子实例后立即放入 `_applications` 并传入 `hostSurfaceResidents`（第 307-311 行）。[`PocketView._buildSurface`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L4061-L4089) 将尚未出现在 `SURFACE_QUAD` 中的驻留子实例挂载在 `Offstage(offstage: true)` 下，子 `PocketView` 渲染初始帧并触发 [`_onFirstFrame`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L1158-L1167)，将 `instance.firstFrameReady` 置为 `true`。
  2. 当 `openApp` 随后调用 [`_awaitFirstFrame`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L727-L743) 时，仅检查 `if (!instance.firstFrameReady)` 而未检查 `instance.compositorVisible`，导致在 SystemUI 尚未提交包含该子应用 `SURFACE_QUAD` 的帧、子应用 `compositorVisible` 与 `session.foreground` 仍为 `false` 时，`awaitFirstFrame` 就已立即返回。
  3. [`PocketSystemHost._publishFacts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L1336) 将 `isPresented` 硬编码为 `instance.isSystemUI || instance.compositorVisible`，导致子应用全屏打开时 `_showcase`（SystemUI）的 `isPresented` 仍为 `true`，直接违反 [demo/integration_test/multi_app_test.dart:92-95](file:///Volumes/ORICO/Development/Github/pocket/demo/integration_test/multi_app_test.dart#L92-L95) 的断言 `expect(host.instances.singleWhere((e) => e.appId == _showcase).isPresented, isFalse)`；同时 [guest_interaction_test.dart:98](file:///Volumes/ORICO/Development/Github/pocket/demo/integration_test/guest_interaction_test.dart#L98) 使用 `tester.renderObject<RenderBox>(find.byType(PocketView))`，在父子 `PocketView` 同台挂载时若触发滚动会匹配到多个 `PocketView` 抛 `StateError`。
- **实际证据**：
  - [sdk/lib/src/pocket_system_host.dart:727](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L727)、[sdk/lib/src/pocket_system_host.dart:1336](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L1336) 与 [demo/integration_test/multi_app_test.dart:92-95](file:///Volumes/ORICO/Development/Github/pocket/demo/integration_test/multi_app_test.dart#L92-L95)。
- **最小修复建议**：
  1. 在 `_awaitFirstFrame` 中要求 `instance.firstFrameReady && instance.compositorVisible`（当 `_observeCompositorSlot` 观察到 `visible == true` 且 `firstFrameReady == true` 时再完成等待器）。
  2. 统一 `PocketSystemHost._publishFacts` 与 `multi_app_test.dart` 对 SystemUI `isPresented` 的定义，并将 `guest_interaction_test.dart` 的 `find.byType(PocketView)` / `painters(tester)` 锚定到当前具有焦点的活动 `PocketView`。

---

#### [P1-5] `_PocketOffloadBinding._onNativeNotify` 共享单批次计数器且 `take_*` 无条件清除 `wake_pending`，导致请求或取消被永久搁置
- **文件:行号**：
  - [sdk/packages/pocket_flutter/lib/src/pocket_offload_binding.dart:162-197](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_offload_binding.dart#L162-L197)
  - [sdk/native/src/offload.rs:475-508](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/offload.rs#L475-L508)
- **触发条件**：
  1. 单次通知批次中累积的取消记录数与新请求数之和 `> 8`（例如 `set_session` 或超时产生 8 条取消记录，同时有新请求入队）。
  2. 或在 `_onNativeNotify` 处理第二阶段（`cancel: false`）期间，某条请求因同步校验失败调用 `_completeFailure` -> `OffloadHost::complete` 将 `wake_pending` 置为 `true`，同时 `deadline_loop` 线程超时推入一条取消记录并调用 `notify()`（被已为 `true` 的 `wake_pending` 合并）；紧接着下一轮循环调用 `_takeRecord(cancel: false)` -> `take_request()` 无条件调用 `self.inner.rearm_wake()` 将 `wake_pending` 清零。
- **根因**：
  - [`_onNativeNotify`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_offload_binding.dart#L162-L197) 在 `cancel: true` 和 `cancel: false` 两个 `while` 循环之间共用同一个 `var drained = 0`（上限 `_pocketOffloadBatchLimit = 8`），且达到上限退出后不会重新调度下一轮读取；而 [`OffloadHost::take_request`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/offload.rs#L476) 与 [`OffloadHost::take_cancellation`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/offload.rs#L498) 在加锁前就无条件执行 `self.inner.rearm_wake()`（`wake_pending = false`），导致剩余队列元素不再触发通知。
- **实际证据**：
  - [pocket_offload_binding.dart:166,182](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_offload_binding.dart#L166-L197) 两个循环共用 `while (drained < _pocketOffloadBatchLimit)`；[offload.rs:476,498](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/offload.rs#L476-L508) 在锁外无条件 `self.inner.rearm_wake()`。
- **最小修复建议**：
  - 在 `OffloadHost::take_request` / `take_cancellation` 中仅当 `state.request_queue.is_empty() && state.cancellations.is_empty() && state.replies.is_empty()` 时才清除 `wake_pending`；在 `_onNativeNotify` 中分别独立排空 `cancel: true` 与 `cancel: false` 队列（若排空 `cancel: false` 期间有新取消产生则再检查一次 `cancel: true`）。

---

#### [P1-6] 按需调度器 `demand::capture` 与零 tick `run_virtual_frames` 漏检 `axis_deltas`、`motion` 与 `analog` 输入，且 `before_external` 的 `elapsed_credit_ms` 在 0ms 帧后冻结虚拟时钟
- **文件:行号**：
  - [sdk/native/src/demand.rs:101-124,180-182,268-278](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/demand.rs#L101-L124)
  - [sdk/native/src/lib.rs:2207-2215](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L2207-L2215)
  - [sdk/packages/pocket_flutter/lib/src/pocket_view.dart:908-918](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L908-L918)
  - [sdk/native/patches/demand-scheduler.patch:789](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/patches/demand-scheduler.patch#L789)
- **触发条件**：
  1. Guest 处于静止空闲（或 120Hz 屏幕运行 60Hz Guest 遇到 `remaining_ticks == 0` 的半步帧）时收到滚轮/触控板滚动（`input.axis` / duplex scroll）、陀螺仪（`input.motion`）或摇杆（`analog`）输入并执行零 tick 帧。
  2. Guest 空闲 $T\text{ ms}$ 后触发窗口/键盘尺寸变化（[`PocketView._resizeRuntime`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L908-L918) 调用 `resizeViewport` 后立即调用 `deltaFn(runtime, 0)`）。
  3. Solid Guest 使用 `bindDpadScroll` 点按方向键后松开，Scroller 仍处于 `"chase"` 动画状态。
- **根因**：
  1. [`run_virtual_frames`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L2207-L2215) 在 `remaining_ticks == 0` 时只检查 `!host.pending_text.is_empty() || host.external_work_pending`，[`demand::capture`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/demand.rs#L101-L107) 也未包含 `!host.axis_deltas.is_empty() || host.motion.is_some() || host.analog != 0x8080 || host.right_analog != 0x8080`，导致零 tick 帧既不消费 `axis_deltas`/`motion`，又返回 `Work::Idle`（`-1.0`）直接停表。
  2. [`demand::before_external`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/demand.rs#L268-L278) 将空闲时长 $T$ 计入 `host.demand.elapsed_credit_ms`；紧接着 `_resizeRuntime` 调用 `pocket_frame_delta(handle, 0.0)`，[`ticks_for_delta(host, 0.0)`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/demand.rs#L180-L182) 仅抵扣 `0.0`，随后 [`demand::capture`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/demand.rs#L118) 重新设置新的 `idle_anchor = Some(Instant::now())` 却未清零残留的 `elapsed_credit_ms == T`，导致后续活跃帧的 `delta_ms` 被持续扣减直到耗尽 $T\text{ ms}$。
  3. Solid 版 [`kinetics.ts:48`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/patches/demand-scheduler.patch#L789) 的 `bindDpadScroll` 注册为 `{ continuous: () => hasScrollInput }`，漏掉了 Vue Vapor 版（第 811 行）具备的 `|| s.state() !== "idle"`。
- **实际证据**：
  - 对照 [demand.rs:101-124](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/demand.rs#L101-L124)、[demand.rs:180-182](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/demand.rs#L180-L182)、[lib.rs:2207-2215](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L2207-L2215) 与 [demand-scheduler.patch:789,811](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/patches/demand-scheduler.patch#L789-L811)。
- **最小修复建议**：
  1. 在 `demand::capture` 与 `run_virtual_frames` 中补齐 `!host.axis_deltas.is_empty()`、`host.motion.is_some()` 及非中立 `analog`/`right_analog` 判断。
  2. 在 `PocketView._resizeRuntime` 完成 `deltaFn(runtime, 0)` 后同步更新 `_lastSchedulerTimestamp`，并在 `demand::capture` 重新锚定 `idle_anchor` 时清零未消费的 `elapsed_credit_ms`。
  3. 将 Solid `kinetics.ts:48` 补齐为 `{ continuous: () => hasScrollInput || s.state() !== "idle" }`。

---

### P2 级（边界场景缺陷、协议一致性与异常恢复问题）

#### [P2-1] `asyncStop` 离线回放期间若 `io.fact` 与其他 Actor 事件交错，会导致回放死锁或报事件顺序错误
- **文件:行号**：
  - [sdk/native/src/worker.rs:2011-2022,2794-2804](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/worker.rs#L2011-L2022)
  - [sdk/native/src/worker_trace.rs:879-884](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/worker_trace.rs#L879-L884)
- **触发条件**：
  - 在 `asyncStop` 回放批次中，Worker 正在排空停止前的最后一次活动 turn（`draining_stopped_turn == true`），且批次中先出现非 Worker 事件（如 `scheduler.stop` 或 `offload.shutdown`），紧接着出现该 Worker 的 `io.fact` 与 `turn.end` / `worker.exit`。
- **根因**：
  1. [`await_replay_event`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/worker.rs#L2011-L2022) 在 `draining_stopped_turn` 分支中若队首不是 `io.fact`，第 2020 行直接 `return trace.await_turn(actor, session, kind)`，当非 Worker 事件被消费后队首变成 `io.fact`（在 Replay 模式下归属 `TraceActor::Worker`），`await_turn` 因 `expected.kind == "io.fact" != kind` 直接报错失败。
  2. [`trace_worker_exit`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/worker.rs#L2794-L2804) 只在 `observe("worker.exit")` 前调用了一次 `inject_replay_io_facts`。
  3. [`wait_for_advance_timeout`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/worker_trace.rs#L879-L884) 检查 `if state.stopped_sessions.contains(&event.session)` 时未检查 `!stopped_event_allowed(...)`，与第 130-137 行允许停止后注入 `"io.fact"` 的规则矛盾。
- **最小修复建议**：
  - 在 `wait_for_advance_timeout` 第 879 行加上 `&& !stopped_event_allowed(&state, TraceActor::for_event(Mode::Replay, event), &event.session, &event.kind)`；在 `draining_stopped_turn` 与 `trace_worker_exit` 中循环等待非本方事件推进并重新执行 `inject_replay_io_facts`，直到队首到达目标事件。

---

#### [P2-2] JS 多应用内核 `system.ts`：分屏 `presentSurfaces` 未受 LRU 淘汰保护、非栈内实例终止未清理 `presentedInstanceIds`、子应用无法 `cancel()` 自己发起的 `launchApp`、嵌套调用在 `SystemUI` 发起时被取消会悬挂 Promise
- **文件:行号**：
  - [sdk/packages/pocket_ui/src/system.ts:624-677,1222-1268,1317-1332,1397-1401,1670-1695,1779-1788](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_ui/src/system.ts#L1222-L1401)
  - [sdk/packages/pocket_ui/src/platform.ts:78-88](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_ui/src/platform.ts#L78-L88)
- **触发条件**：
  1. 使用 [`presentSurfaces`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_ui/src/system.ts#L624-L677) 同时展示栈顶应用与一个已预热的伴随应用（分屏），随后创建新实例触发 [`ensureCapacity`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_ui/src/system.ts#L1222-L1248)，或该伴随应用崩溃触发 [`handleRuntimeTermination`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_ui/src/system.ts#L1691-L1694)。
  2. 子应用 `A` 调用 `const launch = await platform.launchApp(B)` 后调用 `launch.cancel()`。
  3. `SystemUI` 打开 `A` 后，又从 `SystemUI` 控制域直接调用 `openApp(B)`（压入 `call_B: caller = system-ui`），随后 `A` 崩溃或世代变更触发 `cancelStackFrom(1)` / `abandonStackFrom(1)`。
- **根因**：
  1. `ensureCapacity`（第 1222-1248 行）只排除 `stackInstances` 与 `callInstances`，未排除 `this.presentedInstanceIds`；`destroyRuntime`（第 1250-1268 行）与 `handleRuntimeTermination`（第 1691-1694 行，`index < 0` 分支）也未从 `this.presentedInstanceIds` 中移除已销毁实例。
  2. [`cancelApp`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_ui/src/system.ts#L1318-L1331) 先调用 `authorizeForeground`（当 `B` 在栈顶时拒绝调用方 `A`），再检查 `source.instanceId !== call.targetInstanceId`（只允许被打开的目标 `B` 或 `SystemUI` 取消，拒绝了持有 `launch.cancel()` 句柄的调用方 `call.callerInstanceId`）。
  3. [`cancelStackFrom`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_ui/src/system.ts#L1397-L1401) 与 [`abandonStackFrom`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_ui/src/system.ts#L1779-L1788) 直接 `this.calls.delete(nestedCall.requestId)`，当嵌套调用的 `callerInstanceId` 是未被销毁的存活实例（如 `system-ui`）时，未向其投递 `cancelled: true` 的 `platform.result`，导致其 `launch.result` Promise 永久悬挂。
- **最小修复建议**：
  1. 在 `ensureCapacity` 中保护 `this.presentedInstanceIds`，并在 `destroyRuntime` 中清理 `this.presentedInstanceIds` 及通知 `presentationListeners`。
  2. 在 `cancelApp` 中改用 `authorizeRuntime` 并允许 `source.instanceId === call.callerInstanceId && source.generation === call.callerGeneration`。
  3. 在 `cancelStackFrom` 与 `abandonStackFrom` 中，对 `callerInstanceId` 仍存活且世代未变的被移除调用投递 `{ cancelled: true, value: null, reason }`。

---

#### [P2-3] `PocketOffloadHttpRuntime._runHttp` 存在 `openUrl` 取消竞态、自定义 `Content-Type` 被覆盖及重定向方法/请求头处理缺陷；Worker HTTP `ureq` 超时未按总 `deadline` 递减
- **文件:行号**：
  - [sdk/packages/pocket_flutter/lib/src/pocket_offload_runtime.dart:321-368](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_offload_runtime.dart#L321-L368)
  - [sdk/native/src/worker.rs:3325-3347](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/worker.rs#L3325-L3347)
- **触发条件**：
  1. Offload HTTP 请求在 `await _client.openUrl(currentMethod, uri)` 期间收到原生取消或超时信号。
  2. Offload HTTP 发送带 `Content-Type: application/json` 的 `POST` 请求并遇到 `301`/`302`/`303` 重定向，或发送 `HEAD` 请求遇到 `303` 重定向。
  3. Worker HTTP 请求经历多次重定向（最多 5 次）且每次连接/读取接近 `descriptor.timeout`。
- **根因**：
  1. [pocket_offload_runtime.dart:321-323](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_offload_runtime.dart#L321-L323) 在 `await _client.openUrl(...)` 返回并赋值 `active.request = req` 后未再次检查 `active.cancellation.isCancelled`，导致在 `openUrl` 挂起期间到达的取消无法中止该请求。
  2. 第 336-338 行在 `currentBody.isNotEmpty` 时无条件执行 `req.headers.contentType = ContentType.text`，覆盖了第 334 行设置的调用方 `Content-Type`；且第 362-368 行在 `POST` 重定向为 `GET` 时未从 `requestHeaders` 移除 `content-type`/`content-length`，在 `303` 重定向时将 `HEAD` 也改写成了 `GET`。
  3. [worker.rs:3325-3330](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/worker.rs#L3325-L3330) 为整个请求构建了固定 `.timeout_connect(descriptor.timeout).timeout_read(descriptor.timeout)` 的 `ureq::Agent`，未按每次重定向剩余的 `deadline.saturating_duration_since(Instant::now())` 收缩单步超时。
- **最小修复建议**：
  - 在 `active.request = req;` 后立即执行 `if (active.cancellation.isCancelled) { req.abort(); active.cancellation.throwIfCancelled(); }`；仅在 `requestHeaders` 未提供 `content-type` 时设置默认 `ContentType.text`；重定向变为 `GET` 时清理 `content-type`/`content-length` 并保留 `HEAD`；在 `worker.rs` 中按每次 hop 的剩余 `deadline` 设置 `ureq` 超时。

---

#### [P2-4] OTA 激活包运行时 `PocketSession.runtimeInfo()` 漏报 `worker` 元数据，且 Worker 校验使用内嵌 `_metadata` 的 `tickHz` / `bindingGeneration`
- **文件:行号**：
  - [sdk/lib/src/pocket_session.dart:237-254,379-388](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_session.dart#L237-L254)
- **触发条件**：
  - 通过 OTA 激活一个包含 Worker 的签名更新包（`active != null`）后调用 `runtime.info` 或校验 Worker 产物。
- **根因**：
  - [`runtimeInfo()`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_session.dart#L239) 仅在 `active == null` 时展开 `..._metadata`，当 `active != null` 时未映射 `active!.package.manifest.payload.worker`；第 382-386 行调用 `PocketWorkerArtifact.verify` 时传入的 `expectedTickHz: tickHz` 读取的是内嵌资产 `_metadata['tickHz']` 而非当前活动包的 `worker['tickHz']`。
- **最小修复建议**：
  - 在 `runtimeInfo()` 中当 `active != null && active!.package.manifest.payload.worker != null` 时输出 `'worker': active!.package.manifest.payload.worker`；在 `PocketWorkerArtifact.verify` 中使用当前生效包的 `tickHz`。

---

#### [P2-5] 微信宿主 `cancelPending()` / `dispose()` 异常安全缺陷，且 `pages/index/index.js` 在 WASM 实例化期间丢失窗口/键盘尺寸变化
- **文件:行号**：
  - [sdk/targets/wechat/template/wechat-host.js:598-622](file:///Volumes/ORICO/Development/Github/pocket/sdk/targets/wechat/template/wechat-host.js#L598-L622)
  - [sdk/targets/wechat/template/pages/index/index.js:18-37,79-81](file:///Volumes/ORICO/Development/Github/pocket/sdk/targets/wechat/template/pages/index/index.js#L79-L81)
- **触发条件**：
  1. `dispose()` 或 `hide()` 调用 `cancelPending()` 时仍有未完成的异步能力请求，且 `this.respond()` 抛错或在 Guest `.catch()` 中同步发起新请求。
  2. `this._host.start(...)` 等待 `WXWebAssembly.instantiate` 期间触发了 `wx.onWindowResize` 或 `wx.onKeyboardHeightChange`。
- **根因**：
  1. [`cancelPending`](file:///Volumes/ORICO/Development/Github/pocket/sdk/targets/wechat/template/wechat-host.js#L598-L607) 在 `this.pending.clear()` 之前遍历 `this.pending.values()` 并无保护地调用 `this.respond(...)`。若 `web_wechat_deliver` 抛错，`dispose()` 将在调用 `this.exports.web_destroy(this.host)`（第 615 行）前中断，泄漏 WASM 实例与剩余定时器。
  2. [`index.js:79-81`](file:///Volumes/ORICO/Development/Github/pocket/sdk/targets/wechat/template/pages/index/index.js#L79-L81) 在 `start()` 异步完成后未将实例化期间更新的 `this._width` / `this._height - this._keyboardHeight` 同步给 `this._host.resize(...)`。
- **最小修复建议**：
  - 在 `cancelPending()` 中先快照并清空 `this.pending`、清理所有 timer/AbortController，再在 `!this.disposed` 下用 `try/catch` 包裹 `this.respond()`；在 `dispose()` 中用 `try/finally` 确保 `web_destroy` 必执行；在 `index.js` 的 `start().then(...)` 中补调一次 `this._host.resize(this._width, Math.max(1, this._height - this._keyboardHeight))`。

---

#### [P2-6] 子应用 `PocketGuestSession` 传入非空 `viewport: slot.bounds.size`，导致子 `PocketView` 在键盘/布局变化期间关闭 `automaticViewport` 产生一帧缩放抖动
- **文件:行号**：
  - [sdk/lib/src/pocket_system_host.dart:327-334](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L327-L334)
  - [sdk/packages/pocket_flutter/lib/src/pocket_view.dart:1656-1673,1775-1779,3630-3653](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L3630-L3653)
- **触发条件**：
  - `PocketSystemHost` 中的子应用在软键盘弹出/收起或父 `<CompositorSurface>` 尺寸变化时发生重排。
- **根因**：
  - [`PocketView._buildSurface`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L3999-L4005) 已经用 `Positioned(width: op.width * scaleX, height: op.height * scaleY)` 约束了子组件尺寸，但 [`PocketSystemHost._buildCompositorSurface`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L332) 又额外传入了 `viewport: slot.bounds.size`，使得子 `PocketView` 的 `automaticViewport`（`widget.runtime == null && widget.viewport == null && !_resizeUnavailable`）恒为 `false`，在 post-frame 原生 resize 返回前的一帧回退到 `_fitSurfaceSize` + `Center`，触发画面等比缩放和居中偏移抖动。
- **最小修复建议**：
  - 在 [`PocketSystemHost._buildCompositorSurface`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L327-L334) 中省略 `viewport: slot.bounds.size`，让子 `PocketView` 通过外层 `Positioned` 约束启用 `automaticViewport`。

---

### P3 级（轻度缺陷、构建校验覆盖面与文档偏差）

#### [P3-1] `PocketView._applyFrame` 焦点切换检测未裁剪不可见的 `application` Surface；`PocketOp.fromJson` 对 `align` 缺少 `0..2` 范围校验
- **文件:行号**：
  - [sdk/packages/pocket_flutter/lib/src/pocket_view.dart:1617-1632](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L1617-L1632)
  - [sdk/packages/pocket_flutter/lib/src/pocket_model.dart:127,682-683](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_model.dart#L127)
- **触发条件 & 根因**：
  1. `_applyFrame` 中的 `focusedApplication` 只检查 `op.kind == 'application' && op.focused`，未像 `_buildSurface`（第 3860-3878 行）那样检查 `visible.isEmpty`；当一个原本完全被裁剪在视口外的 `focused: true` 子 Surface 滚动进入视口时，`previousFocus == nextFocus`，父级未取消进行中的指针序列或关闭父级输入框。
  2. `PocketFrame.fromBinary`（第 682-683 行）对 `text` op 的 `align > 2` 抛 `FormatException`，而 `PocketOp.fromJson`（第 127 行）未做 `0..2` 范围与类型校验。
- **最小修复建议**：
  - 提取公共的 `_effectiveFocusedApplicationHandle(PocketFrame frame)`（含视口与 clip 求交非空判断）供 `_applyFrame` 与 `_buildSurface` 共用；在 `PocketOp.fromJson` 中同步校验 `align` 属于 `0..2`。

#### [P3-2] `demo/js/scripts/build_mini_apps.ts` 调用 `validateSystemFile` 未传 `{ target: "pocket-flutter" }`，且 `SYSTEM_COMPOSITOR_IMPLEMENTATION.md` 文档描述偏差
- **文件:行号**：
  - [demo/js/scripts/build_mini_apps.ts:12](file:///Volumes/ORICO/Development/Github/pocket/demo/js/scripts/build_mini_apps.ts#L12)
  - [sdk/scripts/build_system.ts:471-474](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_system.ts#L471-L474)
  - [sdk/docs/SYSTEM_COMPOSITOR_IMPLEMENTATION.md:87-88](file:///Volumes/ORICO/Development/Github/pocket/sdk/docs/SYSTEM_COMPOSITOR_IMPLEMENTATION.md#L87-L88)
- **触发条件 & 根因**：
  1. `build_mini_apps.ts:12` 调用 `validateSystemFile(resolve(scriptRoot, "../pocket.system.json"))` 未传 `{ target: "pocket-flutter" }`，导致 [`validateSystem`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_system.ts#L471-L474) 跳过了 `validateAndResolveSystemPlan` 与 `deriveCompositorSurfaceRegistry` 校验。
  2. `sdk/docs/SYSTEM_COMPOSITOR_IMPLEMENTATION.md:87-88` 声称 `pocket-flutter` 目标不声明 worker 能力，但 [`FLUTTER_TARGET_CAPABILITIES`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/flutter_target.ts#L14) 实际已包含 `"runtime.worker"`。
- **最小修复建议**：
  - 在 `build_mini_apps.ts:12` 传入 `{ target: "pocket-flutter" }`，并更新 `SYSTEM_COMPOSITOR_IMPLEMENTATION.md:87-88`。

---

## 3. 实际执行的命令、通过/失败/跳过数和环境限制

> [!NOTE]
> 共享工作区说明：审查开始时工作区存在其他会话未提交的改动（涉及 `demo/js/manifest.json`、`demo/assets/guest-manifest.json`、`performance_history.dart`、`pocket_performance.dart`、`pocket_view.dart` 及新增测试文件）。遵照只读与共享工作区规则，所有命令在不回滚工作区的前提下实跑，并在下表中同时给出实跑结果与目标提交 `de8b051d` 的精确对照。

| 序号 | 实际执行命令 | 结果 | 通过 / 失败 / 跳过 | 备注与对照说明 |
|---|---|---|---|---|
| 1 | `python3 sdk/scripts/check_architecture.py` | **PASS** | 1 / 0 / 0 | 架构依赖与分层边界检查通过 |
| 2 | `cargo test --locked --manifest-path sdk/native/Cargo.toml` | **PASS** | **74 passed / 0 failed / 1 ignored** | `src/lib.rs` 单元测试 **68 passed, 0 failed, 0 ignored**；`tests/duplex_layout.rs` **6 passed, 0 failed, 1 ignored**（`ignored` 为 10s 压力基准 `bench_10s_60fps_duplex_and_layout`） |
| 3 | `cargo build --locked --manifest-path sdk/native/Cargo.toml --lib --bin pocket_probe --bin pocket_worker_probe` | **PASS** | 构建成功 | 生成最新 `sdk/native/target/debug/libpocket_flutter.dylib`、`pocket_probe`、`pocket_worker_probe` |
| 4 | `bun sdk/scripts/tests/worker_recording_fixture.ts /tmp/pocket-audit-de8b051-worker-fixture` | **PASS** | 生成成功 | 产出真实 `app.qjbc`、`app.pak`、`app.worker.qjbc`、`app.bytecode.json`、`guest-manifest.json` |
| 5 | `cd sdk && TMPDIR=/tmp bun test --timeout 120000` | **PASS** | **67 passed / 0 failed / 0 skipped**（18 files, 30.06s） | 含 `system_kernel.test.ts`、`build_system.test.ts`、`worker_build_package.test.ts`、`wechat_build.test.ts` 等 |
| 6 | `cd demo/js && TMPDIR=/tmp bun test --timeout 120000` | **PASS** | **12 passed / 0 failed / 0 skipped**（3 files；`de8b051d` 基准为 2 files / **8 passed**） | 含 `guest_state.test.ts`、`hardware_platform.test.ts` |
| 7 | `cd demo/js && POCKET_BUILD_GUEST=0 POCKET_NATIVE_PROBE=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/debug/pocket_probe bash scripts/test_guest.sh` | **PASS** | 全部通过 | 真实运行 `guest_ablation.ts` 与 `native_guest_probe.ts`（驱动 `pocket_probe` 执行 `demo/assets/app.qjbc`） |
| 8 | `cd sdk/packages/pocket_services && flutter analyze --no-pub && flutter test --no-pub --reporter expanded` | **PASS** | Analyze: 0 issues；Test: **27 passed / 0 failed / 0 skipped** | 含 OTA 降级拒绝、并发 prepare、路径穿越防护、权限交集与插件吊销 |
| 9 | `cd sdk/packages/pocket_hardware && flutter analyze --no-pub` | **PASS** | Analyze: 0 issues | 该包无独立 `test/` 目录，硬件插件单测位于 `demo/test/hardware_plugin_test.dart` |
| 10 | `cd sdk/packages/pocket_flutter && flutter analyze --no-pub && POCKET_NATIVE_LIBRARY=.../libpocket_flutter.dylib flutter test --no-pub --concurrency=1 --reporter expanded` | **PASS** | Analyze: 0 issues；Test: **104 passed / 0 failed / 0 skipped**（`de8b051d` 基准为 **102 passed**） | 全部真实 FFI 测试（binary frame、duplex、timer wake、offload binding、recording/replay FFI）均实际执行且 0 skip |
| 11 | `cd sdk && flutter analyze --no-pub && POCKET_NATIVE_LIBRARY=.../libpocket_flutter.dylib POCKET_RECORDING_WORKER_FIXTURE_DIR=/tmp/pocket-audit-de8b051-worker-fixture flutter test --no-pub --concurrency=1 --reporter expanded` | **PASS** | Analyze: 0 issues；Test: **59 passed / 0 failed / 0 skipped**（`de8b051d` 基准为 **56 passed**） | `recording_worker_ffi_test.dart`（2 项）与 `recording_worker_session_test.dart`（1 项）均真实执行 Worker QJBC + 本地 HTTP 录制与关停后离线回放，0 skip |
| 12 | `cd demo && flutter analyze --no-pub && POCKET_NATIVE_LIBRARY=.../libpocket_flutter.dylib flutter test --no-pub --concurrency=1 --reporter expanded` | **FAIL** | Analyze: 0 issues；Test: **19 passed / 1 failed / 0 skipped** | `demo/test/showcase_admission_test.dart` 失败：`Bad state: Missing capabilities: ui.compositor-surfaces`（见 **[P0-1]**；`VALIDATION.md` 中所写 `20 passed` 已过时） |
| 13 | `rm -rf /tmp/pocket-audit-de8b051-wechat-lobby && RUSTUP_TOOLCHAIN=1.98.1 bun sdk/scripts/build_wechat.ts --project-root=demo/js/apps/lobby --outdir=/tmp/pocket-audit-de8b051-wechat-lobby && node sdk/targets/wechat/tests/qjbc_pointer.mjs /tmp/pocket-audit-de8b051-wechat-lobby` | **PASS** | 1 / 0 / 0 | 真实编译 `wasm32-unknown-unknown` + QuickJS 0.12.2 + Lobby `app.qjbc`（161,360B），并在 Node WebAssembly 中验证点击 `0 -> 1` 像素变化与 `host.response` |

### 环境限制与未执行项说明
1. **微信开发者工具与真机运行门禁**：本机 CLI 环境仅能通过 Node WebAssembly 运行 `qjbc_pointer.mjs` 验证生成的 `.wasm.br` 与 QJBC/PAK；按规范，Node 探针通过**不等于**微信开发者工具或真机验收通过（且静态走查已发现 `wechat-host.js` 在 `schedule()` 与 `resize()` 上的 **[P1-3]** 缺陷）。
2. **Flutter 真机/模拟器集成测试（`demo/integration_test/*`）**：本次在默认只读约束下未启动外部 iOS Simulator / macOS 桌面宿主或篡改现有守护进程，但通过代码对账已确认 `demo/integration_test/multi_app_test.dart:92-95` 与 `PocketSystemHost._publishFacts` 的 `isPresented` 语义冲突（见 **[P1-4]**）。

---

## 4. 功能验收矩阵

| 模块 / 能力项 | 验收状态 | 证据与说明 |
|---|---|---|
| **1. JS 多应用平台**：跨 App 打开/返回结果、共享存储 ACL、跨应用消息、预热与失败回收、generation 隔离、权限防越界 | **部分验证** | JS 内核（`system_kernel.test.ts`）与 `platform_data_test.dart`、`platform_session_test.dart` 验证了调用栈、ACL 与前后台插件吊销；但存在 **[P0-1]**（`de8b051d` 中 `demo/js/manifest.json` 漏声明 `system.runtime.awaitFirstFrame`）、**[P1-4]**（`_awaitFirstFrame` 被 Offstage 首帧提前满足、`SystemUI.isPresented` 恒为 `true`）及 **[P2-2]**（`presentSurfaces` 未受 LRU 保护、子应用 `launch.cancel()` 被拒、嵌套 `SystemUI` 调用取消时悬挂 Promise）。 |
| **2. 官方 System 合成与输入**：`SURFACE_QUAD`、surface handle 注册、clip/Z 序、focus、坐标转换、`GLYPH_RUN` 释放、IME 与滚动跟随 | **部分验证** | `pocket_compositor_view_test.dart`、`pocket_glyph_render_test.dart`、`pocket_view_input_test.dart`、`pocket_frame_binary_ffi_test.dart` 验证了 `SURFACE_QUAD`、`GLYPH_RUN` T8 页回收、JSON/PFB1 字段一致性、无 raw text/IME 重复投递及输入框滚动跟随；但存在 **[P0-1]**（`showcaseConfig` 准入缺失 `ui.compositor-surfaces`）、**[P2-6]**（子应用传入非空 `viewport` 关闭了 `automaticViewport`）与 **[P3-1]**。 |
| **3. 按需调度与性能**：timer / Promise / `host.response` / Worker / IO / 键盘 / 路由唤醒、FPS 无 60 上限、无轮询探针 | **部分验证** | `pocket_view_timer_ffi_test.dart`、`pocket_view_test.dart`、`performance_history_test.dart` 验证了空闲停表、定时器唤醒、无轮询及最高 1000Hz FPS 统计；但存在 **[P1-6]**（`axis_deltas`/`motion`/`analog` 未纳入 `demand::capture` 与零 tick 帧、`before_external` 的 `elapsed_credit_ms` 在 0ms 帧后冻结虚拟时钟、Solid `bindDpadScroll` 漏检 `s.state() !== "idle"`）。 |
| **4. Worker / IO / Offload**：真实 QJBC、ABI/hash/声明校验、HTTP origin 授权、重定向/超时/取消、流式背压、FFI 生命周期与锁顺序 | **部分验证** | `worker.rs`（68 项 Rust 测试）、`pocket_worker_test.dart`、`pocket_offload_runtime_test.dart`、`pocket_offload_binding_ffi_test.dart` 验证了 QJBC 校验、origin 授权、流式背压与 `NativeCallable` 安全释放；但存在 **[P1-5]**（`_onNativeNotify` 共享计数上限与 `rearm_wake` 丢唤醒）与 **[P2-3]**（`openUrl` 取消竞态、重定向 header/method 处理与 `ureq` 单步超时）。 |
| **5. 确定性录制与离线回放**：全局 `seq`、事务切分、时间/随机标量、channel publish/latch、IO facts、原实例与 HTTP 关闭后离线回放、配额超限、v1 兼容 | **部分验证** | `recording_worker_ffi_test.dart`、`recording_worker_session_test.dart`、`pocket_recording_ffi_test.dart`、`pocket_recording_test.dart` 验证了真实 Worker + HTTP 录制、服务关闭后新实例离线回放、CPU 预算排除 trace 等待、配额超限标记 `incomplete` 及 v1 兼容；但存在 **[P1-1]**（截断尾部 `turn.begin` 后的事件可假匹配 `matched: true`）、**[P1-2]**（实时 `captureStop` 未等待活动 Worker turn 结束）与 **[P2-1]**（`asyncStop` 交错 `io.fact` 回放失败）。 |
| **6. 构建、更新和权限**：Worker 资产打包/OTA 准入、固定上游补丁幂等、`backgroundSafe` 权限生命周期 | **部分验证** | `worker_build_package.test.ts`、`pocket_package_update_test.dart`、`platform_session_test.dart` 验证了 `buildGuest` + `packageArtifacts`、上游补丁幂等与 `backgroundSafe` 硬件吊销；但存在 **[P0-2]**（`sdk/pocket.ts` 与 `sdk/editor/server.ts` 丢失 Worker 产物并覆写 `guest-manifest.json`）与 **[P2-4]**（OTA 激活时 `runtimeInfo()` 漏报 `worker`）。 |
| **7. 微信目标（单 Guest）**：真实 QuickJS WASM + QJBC/PAK、输入驱动画面变化、`host.response`、Node WebAssembly 探针 | **部分验证（仅 Node 探针）** | `build_wechat.ts` + `qjbc_pointer.mjs` 已验证真实 WASM + QJBC/PAK 构建与 Node 探针下的点击驱动像素变化；但 `wechat-host.js` 存在 **[P1-3]**（`schedule()` 提前调 `web_wechat_skip_idle_frames`、`resize()` 破坏 `this.scale` 导致 `draw()` 失效）与 **[P2-5]**，且**未经微信开发者工具与真机验证**。 |
| **7b. 微信开发者工具 / 微信真机运行验收** | **未验证** | CLI 环境无微信开发者工具与真机环境；按文档与审查要求不得将 Node 探针成功冒充为微信端验收通过。 |
| **7c. 微信目标下的多应用 System / Worker / Offload** | **明确不支持** | `build_wechat.ts:292-360` 与 `wechat_build.test.ts` 已在构建期显式拦截并提前拒绝 System manifest、`<CompositorSurface>`、Worker 与 `io.offload`。 |
| **8. Blaze 构建工具链替换** | **明确不支持（仅评估文档）** | `sdk/docs/BLAZE_BUILD_EVALUATION.md` 仅为可行性评估文档，未替换默认工具链，也未被宣传为运行期 FPS 优化。 |

---

## 5. 可通过消融删除的冗余设计（附代码依据）

1. **未被引用的重复 C 垫片文件 [sdk/targets/wechat/wasm-shim.c](file:///Volumes/ORICO/Development/Github/pocket/sdk/targets/wechat/wasm-shim.c#L1-L175)（175 行）**：
   - **代码依据**：[`sdk/scripts/build_wechat.ts:282`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_wechat.ts#L282) 实际从经过 SHA-256 校验的上游缓存 `.cache/wechat-qjs-support/rquickjs-sys-0.14.0/wasm-shim/shim.c` 复制编译，全仓没有任何脚本或配置引用 `sdk/targets/wechat/wasm-shim.c`（两者 SHA-256 完全相同：`4939829098f8818477e0dc6668bd9249ef84c14a0c1d18b8531b53df4c490224`）。可直接删除 `sdk/targets/wechat/wasm-shim.c`。

2. **废弃的标量 TraceClock C ABI 接口及 `TraceClock` 上的冗余 `last_*` 缓存状态**：
   - **代码依据**：
     - [sdk/native/src/lib.rs:3637-3651](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L3637-L3651)（`pocket_trace_clock_begin`）、[lib.rs:3692-3707](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L3692-L3707)（`pocket_trace_clock_end`）、[lib.rs:3733-3739](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L3733-L3739)（`pocket_trace_clock_last_json`）。
     - [sdk/native/src/replay.rs:117,123-125,288-304,460-482,544-554,576-583](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/replay.rs#L117-L125)（`TraceClock::last_completed`、`last_scalars`、`last_worker_events`、`last_offload_events`、`begin_scalar`、`end`、`last_json`）。
   - **消融依据**：生产端 [`FfiPocketRuntime._lookupTraceClock`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L2340-L2361) 仅绑定 `pocket_trace_clock_mode`、`pocket_trace_clock_begin_json` 与 `pocket_trace_clock_end_json`。旧的 3 个标量 C ABI 函数在 Dart 侧 0 调用，且 `TraceClock` 在每次事务结束后克隆保留 `last_completed` / `last_scalars` / `last_worker_events` / `last_offload_events` 仅为了服务 `pocket_trace_clock_last_json`。删除这 3 个旧 FFI 导出并在 `end_json` 中直接序列化返回，可消除每次录制/回放事务结束时的多余 Vec 驻留。

3. **从未被构造或抛出的 [`PocketRecordingLimitException`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_recording.dart#L19-L24) 及其两处 Barrel 导出**：
   - **代码依据**：[sdk/packages/pocket_flutter/lib/src/pocket_recording.dart:19-24](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_recording.dart#L19-L24)、[sdk/packages/pocket_flutter/lib/pocket_flutter.dart:31](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/pocket_flutter.dart#L31)、[sdk/lib/pocket_sdk.dart:35](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/pocket_sdk.dart#L35)。
   - **消融依据**：录制配额超限已统一采用 `markIncomplete(...)` 标记录制不完整而不向宿主抛异常，全仓 `sdk/` 与 `demo/` 对 `PocketRecordingLimitException` 的构造与捕获次数均为 0。

4. **[`PocketRecordingController`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_recording.dart#L445-L449) 上的重复 Getter 与别名方法**：
   - **代码依据**：
     - [pocket_recording.dart:445-446](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_recording.dart#L445-L446)：`recording` 与 `completed` 返回同一个 `_recording`（其中 `completed` 在全仓 0 调用）。
     - [pocket_recording.dart:448-449](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_recording.dart#L448-L449)：`recordedBytes` 与 `bytes` 返回同一个 `_bytes`。
     - [pocket_recording.dart:583,616](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_recording.dart#L583-L616)：`finish()` 与 `stop() => finish()` 完全重复。

5. **已废弃的 `pocket_duplex_get_ring` 空桩与重复的 Runtime ABI FFI 包装**：
   - **代码依据**：
     - [sdk/native/src/lib.rs:4900-4909](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L4900-L4909)：`pocket_duplex_get_ring` 恒返回 `null` 且无任何 Dart 调用方（已全面切至 v2 endpoint ABI `pocket_duplex_endpoint_acquire`）。
     - [sdk/native/src/lib.rs:4554-4556](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L4554-L4556) 与 [sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart:728-747,775-797](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart#L728-L797)：`pocket_bytecode_actual_abi` 仅是 `pocket_bytecode_runtime_abi()` 的 3 行直通包装，且 Dart 侧 `FfiPocketRuntime.hostRuntimeAbi` 与 `actualAbi` 重复实现了相同的双符号查找回退逻辑。

6. **Demo 层 2 行直通转发文件 [demo/js/host.ts](file:///Volumes/ORICO/Development/Github/pocket/demo/js/host.ts#L1-L2) 与 [`_ensureSystemCaps`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L1392-L1415) 的 15 字段手工拷贝**：
   - **代码依据**：
     - [demo/js/host.ts:1-2](file:///Volumes/ORICO/Development/Github/pocket/demo/js/host.ts#L1-L2) 仅含 `export * from "@pocket/ui/host";`（`demo/js/system.ts` 已直接从 `@pocket/ui/host` 导入，仅 `demo/js/app.tsx` 与 `demo/js/recording-panel.tsx` 仍经由 `./host.ts` 转发）。
     - [`_ensureSystemCaps`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_system_host.dart#L1392-L1415) 为追加一个 `_compositorSurfacesCapability` 手工复制了 `PocketAppConfig` 的全部 15 个字段，与 [`PocketAppConfig.withPlugins`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_config.dart#L112-L135) 重复。
