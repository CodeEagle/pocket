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
- `readInstalledSdkInfo` 严格区分受管独立安装目录（`standalone`）与 Git 源码检出（`source`，如存在 `.git`、父级 `demo/` 或 `editor/test`）。`standalone` 继续使用已验证归档的逐文件替换；Git 源码模式通过受限的 Git 快进更新，不把独立 SDK 归档覆盖到源码工作区。源码资格不满足时返回明确的暂缓原因。

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
  - 源码模式（`source`）工作区保护与独立模式（`standalone`）并发合并、错误哈希拦截。
  - `downloading` -> `spawning` -> `applying` 跨进程锁 `handoffToken` + `targetVersion` + `stageDir` 鉴权交接，以及 Windows `EBUSY`/`EPERM` 有界重试验证。
  - 服务端忙时暂缓（HTTP `409` / `deferredReason`）与保存后恢复。
  - 未来编译器 `upstreamRevision` 与 `bytecodeAbi` 升级包的暂存校验及升级后 `resolvePrebuiltTools` / `editorToolEnvironment(options, sdkRoot)` 真实磁盘常量校验。
  - 受管目录内嵌自定义文件保留、不完整备份拒绝回滚、仅在 `restart()` 中恢复中断升级（`status()` 不触发恢复）。
- **真实独立 CLI 进程替换与 Playwright Chromium 端到端集成（无内部 `deps` 注入替身）**：
  - 在临时独立 SDK 目录中部署真实 `scripts/editor_service.mjs`、`scripts/studio_upgrade.mjs`、`scripts/prebuilt_tools.mjs`、`scripts/native_probe_path.ts` 与真实健康检查服务，临时移除 `POCKET_SOURCE_BUILD` 以走通真实 `prebuiltEnvironment` 与未来 ABI 校验。
  - 验证前端存在未保存草稿（`dirty`）时暂缓自动升级，点击保存后自动触发真实 detached `editor_service.mjs upgrade-apply` 子进程交接，`/health` 的 `pid` 发生真实变化、`version` 升至 `0.1.11`（含新 ABI），Playwright 直接观测到浏览器原生自动页面刷新（`page.waitForNavigation`）且無需任何测试钩子或手动 `page.reload()`。
  - 模拟新版启动崩溃与真实 CLI 回滚流程，验证旧版回滚健康 truthfulness 及浏览器无刷新死循环。
- **真实 0.1.10 发布包跨平台校验**：已对公开发布的 `0.1.10` macOS (`darwin-arm64`) 与 Windows (`win32-x64`) 独立 SDK 归档完成真实解压与 `validateStagedStandaloneSdk` 校验。

### 0.1.12 发布验证修正

- macOS 的 `/var` 与 `/private/var` 临时目录别名可能使 Node ESM 的规范路径与 CLI 参数不同。服务入口在路径字符串不同时比较 `realpathSync`，并增加通过符号目录执行真实 CLI 的回归测试，避免命令未执行却返回成功。
- 升级浏览器测试复用现有编辑器测试所用 Bun 1.4.4；实际独立 SDK 子服务仍由 `resolveManagedBun` 使用固定 Bun 1.3.9。Chromium 启动设置 15 秒超时并输出阶段信息，便于定位平台进程故障。
- 隔离源码快照验证：升级、服务配置、预编译工具、工具打包、SDK 导出共 34 项测试、284 项断言通过；包含真实进程替换、自动网页导航与失败回滚。

- Windows 补充：服务所有权在命令行路径字符串不同时按 `realpathSync` 比较文件，兼容短路径/长路径与 junction。升级停服时排除升级进程所在分支，避免 `taskkill /T` 终止升级器；其他工作进程仍按树清理。停服前校验失败也会持久化错误，避免页面永久等待重启。路径别名、进程树分区和前置失败状态测试通过；补丁经 Argon Medium 复核通过。

- Windows 管理 CLI 使用既有 Node 入口（服务本体继续使用 Bun 1.3.9），并统一通过 `realpathSync.native` 核对命令行、PID 记录及健康检查的文件路径，兼容 8.3 路径且保留当前项目配置。最终相关生命周期与服务配置 24 项测试、138 项断言通过；此前五组完整定向验证共 37 项、296 项断言通过。

- Windows 最终消融结果：直接从 Bun 1.3.9 服务派生升级器，即使改用 Node 且忽略 stdio，仍会使替换服务出现 `EADDRINUSE`，因此移除该无效分支。仅在 Windows 使用 PowerShell `Start-Process`（独立窗口、无标准流重定向）启动现有 Node 管理 CLI，并等待启动器退出及返回有效 PID；升级状态机、鉴权、备份、回滚保持复用。macOS 继续直接派生原有 CLI。
- 发布流程 `42999927580` 已在 macOS 与 Windows 通过真实独立 CLI 升级、保存草稿后自动恢复、网页自动刷新、失败回滚及服务配置回归；Windows 不再出现路径误判或端口继承占用。生命周期修正的本地 24 项测试、138 项断言通过，最终启动适配经 Argon Medium 复核通过。

## Windows updater ancestry and SDK 0.1.15

The Windows launcher deliberately uses the existing PowerShell `Start-Process`
path above; replacing it with direct Bun/Node spawn reintroduces the port-handle
inheritance failure already captured by the earlier ablation. Its short-lived
launcher can exit before retirement. Windows `ParentProcessId` may then refer to
an exited process or a reused PID ([Microsoft Win32_Process reference](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process)).

A protected retirement must therefore avoid recursive OS tree termination.
Build one plan from the process snapshot, exclude the updater and its visible
descendants, and signal only the enumerated old-server PIDs in child-first
order. Reject invalid snapshots or a target inside the protected subtree.
Before TERM and KILL, share one identity check against current PID facts;
missing or mismatched command/binary fields prevent signaling. Wait for every
planned PID, including Workers that ignore TERM, before completing retirement.
Individual process termination does not terminate children on Windows
([Microsoft process termination reference](https://learn.microsoft.com/en-us/windows/win32/procthread/terminating-a-process)).
This retains cleanup of known old Workers without requiring a complete live
ancestor chain or relaxing protection into an unproven recursive fallback.

The PR CI now runs the same Windows standalone upgrade and rollback command as
the Release job, including real detached CLI execution and Playwright Chromium
navigation. Final macOS and Windows archives remain subject to the release
installation/runtime gate. The unsuccessful 0.1.14 candidate was not published;
its tag remains immutable, and this release uses SDK version 0.1.15.


## Git 源码模式的自动更新

### 来源与复用边界

再次检查保留父工程（排除 `pocket_host/`）的 `mini_apps/syslib/pocket_syslib_ota.js` 与 `docs/04_BIDIRECTIONAL_FFI_WASM_AND_YOOASSET_HOTUPDATE.md`：前者提供 Guest AOT 的版本、ABI 与回滚逻辑，后者描述宿主与 Mini-App 资源热更新；均不提供桌面源码工作区的 Git 更新能力。旧文档列出的 `lib/core/yooasset_package_manager.dart` 在当前保留目录中已不存在，不能作为可复用实现。

源码模式复用现有稳定 Release 发现、归档下载与 SHA-256 校验、安全解压、平台工具校验、升级锁、独立升级进程、服务所有权检查与健康探针。新增的 Git 边界负责工作区资格、目标提交与快进更新；没有另建下载器、服务管理器或 UI 升级状态机。

### 自动应用与文件保留

- 与独立安装模式相同，页面首次检查及后续定期检查可自动应用更新；前端以 `autoUpgradeSupported` 判断能力，不再用 `mode === "standalone"` 排除源码模式。未保存草稿及服务端构建、保存、发布、部署等忙状态仍会暂缓更新和刷新。
- 源码更新跟随 GitHub 正式稳定 Release。应用前检查来源仓库、`main` 分支、包含暂存及未跟踪文件的工作区状态，以及当前 HEAD 到目标 Release 提交的快进关系；工作区修改、分叉和不兼容依赖变化均显示暂缓原因，不自动 stash、提交或覆盖开发者文件。Git 的忽略规则不能证明文件可丢弃：前进及回滚前都检查目标新增路径是否与已有文件或阻挡路径的祖先冲突，拒绝覆盖被忽略的消费者文件；正向合并还显式禁止覆盖忽略项。
- 依赖门禁将 npm 锁文件结构化比较并忽略 SDK 根版本号；Bun 的 `bun.lock` 是 JSONC，按 Git 中的原始文本保守比较，不尝试用 JSON 解析或重写。锁文件内容不变时允许发布版本快进，任何 Bun 锁文本变化都会暂缓并要求手动检查依赖。回归直接使用当前 `sdk/bun.lock` 创建临时 Git 源码仓库，覆盖锁文本不变时放行和 pin 变化时暂缓。
- 使用已验证归档中的匹配平台工具，避免仅改变源码版本而继续运行旧编译器或探针。Git 受管源码由 Git 更新，独立 SDK 归档不用于覆盖源码。
- 停服和应用前重新核对资格，更新后启动新的服务进程并验证版本与健康状态。失败时在安全门通过后恢复旧工具和服务配置；只有 HEAD 仍等于本次目标且工作区仍干净时才允许回退到原 HEAD，禁止用无条件 `reset --hard` 或清理未跟踪文件的方式回滚。回滚前先验证旧工具备份的完整性、版本与 ABI，备份缺失或损坏不能导致删除当前工具。若应用期间出现新的本地修改、被忽略文件的路径冲突或 HEAD 被外部改变，保留备份并报告无法自动恢复；需要先人工保留并处理这些修改，再通过受管服务的 restart 恢复入口重试，不能声称已成功回滚或继续运行版本不匹配的工具。

### 本地升级记录

本次将开发工作区从 `d547885` 快进至公开的 SDK 0.1.15（`7f18206`），先保存原有修改，再无冲突恢复，保留名为 `pocket local changes preserved before SDK 0.1.15 update` 的 stash 备份。同步已校验的 macOS arm64 工具包，将原先指向旧源码编译物的服务配置改为该工具包的编译器与探针。实际 `/health` 返回 `version: 0.1.15`，Playwright Chromium 加载工作台显示 `v0.1.15` 且无页面异常；原有 Preview host adapter、延迟 SystemUI 请求与失败处理的五项测试通过。

新增的真实临时 Git 仓库测试（本机 Bun 1.3.9：15 项、50 个断言通过）覆盖版本号变化时的可快进判定、暂存/未暂存/未跟踪文件保留、分支/游离 HEAD/分叉/来源及来源重写拒绝、依赖图变化暂缓、通过真实本地 SSH transport 获取 Release tag 与临时 ref 清理，以及源码提交/归档版本/工具 ABI 错配拒绝；不会访问公开 GitHub 或修改开发者仓库。

CI 与 Release 的现有 Studio 生命周期门禁同时运行 `editor/test/source_upgrade_git.test.ts`，覆盖 Windows 运行器及发布平台；保留原独立安装升级与回滚测试，不以源码静态检查替代真实生命周期验证。

最终组合验证（Bun 1.4.4）：`POCKET_SOURCE_BUILD=1 npm exec --yes --package=bun@1.4.4 -- bun test --timeout 60000 editor/test/studio_upgrade.test.ts editor/test/source_upgrade_git.test.ts scripts/tests/editor_service.test.ts editor/test/studio_workbench_layout.test.ts` 共 53 项、372 个断言通过。源码真实 CLI 用临时 Git 仓库和显式测试标记绑定动态端口，验证鉴权 handoff、完整 stage/工具摘要校验、Git 快进、HTTP 版本/PID 变化及升级后的普通重启；故意保留旧 native probe，确认后续重启仍绑定已验证的平台工具包。失败路径覆盖健康检查失败恢复 Git/工具、忽略文件冲突、损坏归档在停服前拒绝，以及无法回滚时报告磁盘实际版本。既有独立安装的真实 detached CLI、Playwright 自动刷新与失败回滚同时通过。架构边界检查及 `git diff --check` 通过。

## 0.1.16 Editor 自动升级进度

- `createStudioUpgradeManager` 在现有升级状态中公开 `downloadedBytes` 与可选的 `downloadTotalBytes`。`readBoundedResponseBytes` 仍按原有大小上限读取，只在流式读取时报告已消费字节；只有整数 `Content-Length` 且响应没有 HTTP `Content-Encoding` 时才公开总量，避免把压缩后的响应长度当作实际下载总量。总量未知时界面只显示已接收字节，不伪造百分比。
- Editor 在原来的升级 `POST` 等待期间，使用同一个短轮询 timer 读取 `/api/studio/upgrade`，展示实际 `downloading`、`applying`、`restarting` 阶段和流入字节；timer 句柄在 GET 等待期间继续充当既有的请求互斥标记，避免另一触发并行发出升级 POST。POST 完成后停止该轮询并复用原有 `/health` 重启探测。没有另一个升级状态机。
- 新服务进程可在分离升级器释放应用锁之前接到浏览器检查。若持久状态已为 `up-to-date` 且其 `currentVersion` 与实际安装版本一致，manager 在内存状态为 `idle` 或 `restarting` 时同步该终态；不会覆盖 `checking`、下载或应用等活动阶段，也不会把版本不匹配的旧终态当作成功。定向回归以“重启状态初始化 → 持锁写入成功终态 → 新页 check”复现该交接窗口；去掉 `idle` 同步时回归收到 `idle`，修复后返回 `up-to-date`。
- 顶栏明确显示“自动升级已开启”“自动升级已暂缓”或“自动升级不可用”。未保存的 Editor 草稿、资源策略修改与后端 `deferredReason` 使用完整可换行文本显示；源码 Git 暂缓原因保持单独说明，不会提示保存 Editor 草稿就能解除。状态文字在窄栏换行，不再通过省略号隐藏。
- 单元测试验证带可信总量的逐块字节事实，以及带 `Content-Encoding` 的响应不暴露伪总量。真实 Chromium 生命周期测试以真实 standalone CLI 下载为基础：本地 Node HTTP fixture 分块发送带 `Content-Length` 的升级包，在第一块后暂停；Playwright 同时检查 1280px 宽屏和 831px 窄窗下的自动状态、完整草稿暂缓原因和可见下载百分比，并确认下载期间只有原有的一次升级 POST。释放剩余字节后，测试继续验证真实服务 PID/版本替换、浏览器刷新和健康状态；另一真实 CLI 测试覆盖新版启动失败后的回滚。
- 本机 Bun 1.4.4 验证：`POCKET_SOURCE_BUILD=1 npm exec --yes --package=bun@1.4.4 -- bun test --timeout 60000 editor/test/studio_upgrade.test.ts` 全套 19 项、198 个断言通过。该套件包含字节进度/压缩长度单测、真实分块下载与 Playwright 1280px/831px 显示和并发 POST 门禁、服务 PID/版本切换与刷新、以及真实 CLI 失败回滚；浏览器使用 Playwright Chromium。
