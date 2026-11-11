# Pocket Studio 内置自升级与恢复架构 (`STUDIO_UPGRADE.md`)

## 1. Source-first 审计与证据缺口

实现前首先审计了保留的父工程 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`（排除 `pocket_host/`）：

- **`mini_apps/syslib/pocket_syslib_ota.js`**：仅提供 Guest AOT 模块内存级版本比较（`parseSemVerTuple`）、Host ABI 匹配与内存级回滚状态。
- **`lib/core/yooasset_package_manager.dart`** 与 **`docs/04_BIDIRECTIONAL_FFI_WASM_AND_YOOASSET_HOTUPDATE.md`**：仅面向 Flutter 宿主与 Mini-App YooAsset chunk 资源热更新。
- **证据缺口**：保留的父工程不包含独立 Web SDK（`@pocket/web-sdk-tools`）或桌面开发服务（Pocket Studio 固定端口 `127.0.0.1:8791`）的 GitHub Release 检查、平台预编译工具归档校验、消费者自定义文件保留、中断恢复或跨平台服务进程自替换能力。

因此，本实现严格复用当前仓库既有的核心模块，不引入第二套进程管理器或状态机：

| 复用/新增路径 | 职责与边界 |
| --- | --- |
| `sdk/scripts/prebuilt_tools.mjs` | 复用 `validateToolsPackage` 与 `readPrebuiltToolsSourceConstants`，在严格保持正常固定常量校验的同时，支持读取磁盘上新应用的 `scripts/prebuilt_tools.mjs` 常量（`SDK_VERSION`、`UPSTREAM_REVISION`、`BYTECODE_ABI`），避免升级应用后由旧进程内存缓存常量导致未来 ABI 启动校验误报。 |
| `sdk/scripts/editor_service.mjs` | 复用唯一的跨平台服务管理器（固定端口 `8791`、PID 与启动配置持久化、进程树终止、`/health` 验证），`editorToolEnvironment(options, sdkRoot)` 接收显式 `sdkRoot`，集成 `upgrade-apply` 以及仅在 `restart()` 停止受管旧服务后执行中断升级恢复（恢复后冷重启 re-exec 以加载最新磁盘模块）。 |
| `sdk/scripts/studio_upgrade.mjs` | 独立升级协调器：GitHub Release 稳定版筛选、HTTPS 来源白名单、流式字节上限与 SHA-256 校验、安全 tar 解压、带 Windows 文件释放有界重试（`maxRetries: 10, retryDelay: 200` 及 `withBoundedFsRetries`）的逐文件备份/替换事务、带 `randomUUID` 令牌鉴权的跨进程锁交接与忙时延迟控制。 |
| `sdk/editor/server.ts`、`sdk/editor/client/editor.js` | 暴露 `/api/studio/upgrade`、`/api/studio/upgrade/check`、`/api/studio/upgrade/apply`，并在 `/health` 中返回进程 `pid` 与启动时绑定的 SDK `version`；服务端在构建/保存/发布/部署等任务活跃时暂缓升级，前端在存在未保存草稿（`dirty`/`resourcesDirty`）时暂缓自动升级与页面自动刷新（保存后自动恢复），并在页面打开期间按小时定检。 |

## 2. 核心安全与可靠性设计

### 2.1 源码仓库保护与稳定版过滤
- `parseStableSemver` 仅接受正式版语义化标签 `sdk-v<major>.<minor>.<patch>`，自动忽略 `draft`、`prerelease` 及任何带预发布后缀的标签。
- `readInstalledSdkInfo` 严格区分受管独立安装目录（`standalone`）与 Git 源码检出（`source`，如存在 `.git`、父级 `demo/` 或 `editor/test`）。在 `source` 模式下仅检查并提示新版本，`POST /api/studio/upgrade/apply` 返回 HTTP `409`，绝不自动覆盖开发工作区。

### 2.2 暂存与升级后启动的磁盘 ABI 一致性校验（支持未来编译器与 ABI 演进）
- `validateStagedStandaloneSdk` 解压 `prebuilt/pocket-tools-<platform>-<arch>-<version>.tgz` 到暂存目录，并校核暂存包内部的 `package.json`、`provenance.json`、`scripts/prebuilt_tools.mjs` 与平台工具包 `manifest.json` 之间的版本号、`upstreamRevision`、QuickJS `bytecodeAbi` 及所有预编译二进制文件 SHA-256 摘要。
- `resolvePrebuiltTools(sdkRoot)` 通过 `readPrebuiltToolsSourceConstants` 读取目标 `sdkRoot/scripts/prebuilt_tools.mjs` 的磁盘常量，配合 `editorToolEnvironment(options, sdkRoot)`，确保升级替换文件后在同一进程内启动新版服务时，按磁盘上最新写入的 ABI 与 `upstreamRevision` 执行严格校验，同时完全保留日常运行的固定版本/ABI 强校验。

### 2.3 逐文件精准更新、Windows 句柄释放有界重试与嵌套消费者文件保留
- 弃用整目录无差别覆盖。`prepareSdkUpgradeBackup` 与 `applyStagedSdkFiles` 仅跟踪并更新 SDK 自身拥有的文件路径（记录于 `.pocket-build/.pocket-sdk-manifest.json`）：
  - 更新或新增新版本归档中的文件；
  - 仅删除上一版 SDK 拥有但新版本已移除的文件，并按需清理空目录；
  - 对平台预编译工具目录、暂存目录与备份目录使用 `rmSync(..., { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })`，并对文件复制/删除封装 `withBoundedFsRetries`（针对 `EBUSY`、`EPERM`、`EACCES`、`ENOTEMPTY` 最多有界重试 10 次、间隔 200ms），兼容 Windows 下刚退出的旧进程短暂持有文件句柄的场景，且绝不查杀无关进程；
  - **完整保留**消费者在受管目录内部（如 `packages/my-custom-package/custom.ts`、`packages/pocket_ui/consumer-extension.ts`）、根目录、`.pocket-build/editor-workspace-8791/` 及 `node_modules/` 下创建的所有自定义文件。

### 2.4 鉴权跨进程锁交接、忙/脏状态暂缓、先完整备份后停服与唯一恢复点
- **带 `randomUUID` 令牌鉴权的跨进程锁与 Spawn 确认**：
  - 下载归档阶段锁状态为 `phase: "downloading"`；仅在暂存校验通过、即将派生独立升级子进程前切换为 `phase: "spawning"` 并写入一次性 `handoffToken`（`randomUUID()`）、`targetVersion` 与 `stageDir`。
  - `spawnDetachedServiceUpgrade` 通过 `--handoff-token=` 与环境变量 `POCKET_UPGRADE_HANDOFF_TOKEN` 传递令牌，并直接 `await` 子进程 `spawn` 事件确认成功启动后再返回；子进程 `upgradeApply` 校验 `handoffToken`、`targetVersion` 与 `stageDir` 完全匹配后才接管为 `phase: "applying"`，并在停止旧服务前短暂等待 150ms 以确保父服务 HTTP 响应完整送达浏览器。
- **忙时与未保存修改（Dirty）保护**：
  - 服务端 `canApplyUpgrade` 在 `sdkScopeBlocked`、`projectWrites`、构建（`busy`）、发布（`publishSlots`）、设备部署或 Codex/WeChat 构建活跃时暂缓自动升级，且对直接 `apply` 请求返回 HTTP `409`。
  - 前端在 `dirty` 或 `resourcesDirty`（或本地构建/保存/发布/部署进行中）时自动将后台检查设为 `autoApply: false` 并暂缓自动 `window.location.reload()`，绝不丢弃用户未保存工作；待用户保存源文件/资源策略后自动恢复升级或刷新，同时支持页面打开期间每小时自动定检。
- **完整备份事务标记与真实回滚健康验证**：
  - `upgradeApply` 在停止 8791 Studio 服务**之前**先完成 `prepareSdkUpgradeBackup` 并写入 `backup-complete.json`。
  - 若新版启动或 `/health` 探针失败，`upgradeApply` 恢复备份并重启旧版服务，必须等待 `/health` 确认旧版服务就绪后才记录 `rolledBack: true`；若旧版重启亦未就绪，则如实报告 `rolledBack: false`。
- **唯一中断恢复点与冷重启**：
  - 已从 `status()` 与 `editor/server.ts` 中移除 `recoverInterruptedSdkUpgrade`。中断升级恢复**仅**在 `editor_service.mjs` 的 `restart()` 停止受管旧服务进程之后执行；一旦发生恢复，立即通过 `spawnSync` 重新冷启动磁盘上的 `scripts/editor_service.mjs`，确保后续流程使用恢复后的磁盘模块元数据。

## 3. 验证记录

- **单元与安全门禁（`sdk/editor/test/studio_upgrade.test.ts`、`sdk/scripts/tests/prebuilt_tools.test.ts`、`sdk/scripts/tests/editor_service.test.ts`）**：
  - 稳定版 semver 解析与排序、HTTPS GitHub 来源白名单、恶意 tar 归档拦截（路径穿越、绝对路径、盘符、反斜杠、符号链接、超限体积）。
  - 源码模式（`source`）只读检查保护与独立模式（`standalone`）并发合并、错误哈希拦截。
  - `downloading` -> `spawning` -> `applying` 跨进程锁 `handoffToken` + `targetVersion` + `stageDir` 鉴权交接，以及 Windows `EBUSY`/`EPERM` 有界重试验证。
  - 服务端忙时暂缓（HTTP `409` / `deferredReason`）与保存后恢复。
  - 未来编译器 `upstreamRevision` 与 `bytecodeAbi` 升级包的暂存校验及升级后 `resolvePrebuiltTools` / `editorToolEnvironment(options, sdkRoot)` 真实磁盘常量校验。
  - 受管目录内嵌自定义文件保留、不完整备份拒绝回滚、仅在 `restart()` 中恢复中断升级（`status()` 不触发恢复）。
- **真实独立 CLI 进程替换与 Playwright Chromium 端到端集成（无内部 `deps` 注入替身）**：
  - 在临时独立 SDK 目录中部署真实 `scripts/editor_service.mjs`、`scripts/studio_upgrade.mjs`、`scripts/prebuilt_tools.mjs`、`scripts/native_probe_path.ts` 与真实健康检查服务，临时移除 `POCKET_SOURCE_BUILD` 以走通真实 `prebuiltEnvironment` 与未来 ABI 校验。
  - 验证前端存在未保存草稿（`dirty`）时暂缓自动升级，点击保存后自动触发真实 detached `editor_service.mjs upgrade-apply` 子进程交接，`/health` 的 `pid` 发生真实变化、`version` 升至 `0.1.11`（含新 ABI），Playwright 直接观测到浏览器原生自动页面刷新（`page.waitForNavigation`）且無需任何测试钩子或手动 `page.reload()`。
  - 模拟新版启动崩溃与真实 CLI 回滚流程，验证旧版回滚健康 truthfulness 及浏览器无刷新死循环。
- **真实 0.1.10 发布包跨平台校验**：已对公开发布的 `0.1.10` macOS (`darwin-arm64`) 与 Windows (`win32-x64`) 独立 SDK 归档完成真实解压与 `validateStagedStandaloneSdk` 校验。
