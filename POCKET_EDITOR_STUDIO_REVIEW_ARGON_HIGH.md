# Editor Studio 审查验收报告

审查对象：当前未提交的 Editor Studio 改动，并非整个 SDK 的全部工作区变更。
审查模型：`agy` 实际目录中的 `gemini-4-argon-high`，effort `high`。
审查会话：`47c02dae-c591-4166-9cf1-434178d9863d`。一次独立审查，一次同会话纠正复核；未使用其他模型替代。

## 结论

建议先修复以下工作流问题再将本轮 Editor 功能视为完成。28 项既有测试全部通过，但未覆盖构建中编辑、运行后进程退出及探针失败恢复。

Argon 初稿包含不存在的 API、失败脚本的预期输出和与代码不符的实现描述，主代理未采纳，并要求同会话重审。校正版撤回了这些证据。以下仅列经主代理代码复核或独立运行确认的结论；不将本地受信任项目执行构建脚本定为已确认的远程代码执行漏洞。Argon 原稿的 High 等级也不直接作为本报告严重性：目前确认的是本地开发工作流可靠性问题，无已验证的安全紧急阻断项。

## 确认问题

### 1. 构建中写请求能改变输入，失败后不再构建新 revision（P2）

位置：`sdk/editor/server.ts:760`、`:852`、`:862`、`:1285`、`:1309`。

触发：启动异步 build，在 runner 完成前保存文件或配置。
根因：HTTP 请求级 `projectWrites` 在返回 202 时释放；写分支没有统一检查 `state.busy`，编译直接读取可变项目目录。产物清单又在 runner 完成后读取，无法保证输入来自同一 revision。旧构建失败后 `!state.error` 终止循环，即使期间已保存新 revision，也不继续构建。

实测：独立临时实例 build 返回 202/busy=true；此时 PUT source 返回 200、revision 从 1 到 2；释放一个故意失败的 runner 后，状态为 revision=2、builtRevision=null、busy=false，错误仍为旧构建错误。此实验确认状态机行为，并未声称已通过真实编译器观测到混合字节码。

建议：最小修复是构建期间拒绝项目输入写操作并返回 409。如果产品要允许边编译边编辑，则使用不可变输入快照并按 revision 归属错误，不能仅延长单次 HTTP 请求锁。补充构建中保存和失败重试测试。

### 2. 构建临时 UI 备份被 Editor 当成非法输入（P2）

位置：`sdk/editor/server.ts:412`、`:450`；`sdk/scripts/build_guest.ts:263`。

触发：buildGuest 将含 SDK 软链的 node_modules/@pocket/ui 移到项目根目录 `.pocket-ui-backup-*`，期间请求文件列表。
根因：输入扫描忽略 node_modules，却不识别构建器创建的临时备份；listEditableFiles 先调用全树校验，所以之后跳过隐藏目录也无效。

实测：临时构建中创建同形备份软链，GET files 返回 400，错误 `project contains unsupported source symlink: .pocket-ui-backup-review/ui`。真实构建器备份逻辑已核查；这是模拟构建窗口的确定性复现，没有修改真实 Demo。

建议：统一构建临时文件边界。备份需保留同卷 rename 要求，不能盲目改到跨卷 /tmp；仅识别可信生成目录或将同卷临时目录收敛到既有构建目录，同时保持用户源码软链防护。临时 `pocket-ui-entry-*.tsx` 也不应暴露为可编辑源码。

### 3. 部署进入 running 后丢失后续状态（P2）

位置：`sdk/editor/client/editor.js:777`、`:789`、`:807`；`sdk/editor/devices.ts:954`。

触发：浏览器已观察到 running，随后 Flutter 进程退出、设备断开或任务超时。
根因：pollDeploy/resumeDeployment 在 running 时停止查询，但 activeDeploy 保留。服务端仍会转为 succeeded/failed；客户端没有后续通知，日志及状态停在 running，部署和项目切换仍被锁定，需手动 Stop 或刷新。
证据：真实代码路径核查；本轮没有通过断开真实设备复现。

建议：用服务端事件推送结束状态；若暂用低频轮询，则在 running 期间继续追踪，隐藏标签页降频，终态清理 activeDeploy。不要为避免后台轮询而丢失状态同步。

### 4. Preview System surface handle 算法与官方构建分叉（P2）

位置：`sdk/editor/preview.ts:190`；`sdk/scripts/build_system.ts:628`、`:669`。

触发：去掉 SystemUI 后的 catalog 中有未安装条目，并在它之后还有已安装条目。
根因：官方按 catalog 下标 `2 + index` 保留未安装条目的槽位；预览只为已安装条目递增 handle。例：catalog=[未安装 A, 已安装 B] 时，官方 B=3，预览 B=2。
证据：两个实际函数的控制流直接对比。浏览器尚无完整子应用合成，不能将此描述为已实测的完整合成故障。

建议（消融）：提取/复用唯一的 surface registry 规则，删掉预览中的重复算法，并以稀疏安装 catalog 交叉验证。

### 5. 探针首次缺失后无法恢复（P2）

位置：`sdk/editor/preview.ts:687`。

触发：首次 findProbe 时二进制不存在，随后在同一路径补齐文件。
根因：probePathPromise 的 rejected Promise 被永久缓存。
实测：第一次报 not found；创建该路径文件后第二次仍报同一 not found。这里只测试路径发现恢复，不将临时文本文件当作可执行探针。

建议：失败时清空缓存，使下次调用重新发现。补充失败后恢复测试。

### 6. 保存无条件双写，快捷键绕过按钮约束（P2）

位置：`sdk/editor/client/editor.js:404`、`:1254`。

触发：保存源码；或未修改/构建中按 Cmd/Ctrl+S。
根因：saveProject 仅判断 currentId/saving，无 dirty/workLocked 判断；每次串行 PUT 文件和 PUT config，即使只改了一项。第二步校验失败时，第一步已保存，UI 却只提示 Save failed；无修改的快捷键也会产生两个 revision。
证据：客户端和两个服务端写分支代码核查，未执行浏览器端边界自动化。

建议：复用统一可保存条件，按实际更改提交。若需要两项原子保存，先完整校验再提交，避免新增重复状态机。

## 已知限制与待验证风险

- 多项目共享 Codex App Server 的取消兜底会扩大故障域，属于已明确的共享传输设计限制；没有把它再次包装为新确认漏洞。若要正式支持并发多项目，应补足跨项目取消测试并明确隔离策略。
- 前端约 10 分钟的回合查询预算与服务端超时及清理窗口接近，存在短暂解锁后请求仍被拒绝的可能；尚未做 10 分钟边界实测，未计入上述确认问题。
- preview 读取 pocket.system.json 本身没有调用服务端 safeProjectFile；存在路径校验不一致，尚未证明在当前受信工作区边界内可产生未授权数据泄露，不作为独立安全漏洞。
- Canvas 原生硬件、系统 IME、完整 System 子 guest 合成原本不受支持。真实 Android 安装、本轮真实模型回合和设备断连场景未验收。

## 实际验证

Argon 亲自执行：

- `cd sdk && bun run test:editor`：28 pass、0 fail、258 expect、6 files，约 3.54s。
- `python3 sdk/scripts/check_architecture.py`：通过。
- `/tmp` 独立实例真实 API 复现：文件列表 400、构建中 PUT 200、旧失败阻止队列继续、findProbe rejected 缓存；退出码 0。
- 在线 8791 的 GET files：只读核查成功；未向线上服务发送写请求。

主代理另外执行：

- `bun /tmp/pocket-editor-root-verify.ts`：独立复现构建并发/临时目录误报/探针恢复问题；输出 `/tmp/pocket-editor-root-verify.log`。
- `node --check sdk/editor/client/editor.js`、`node --check sdk/editor/client/preview.js`：均通过。
- `git diff --check`：通过。

审查期间未修改实现源码，未停止 8790/8791 或现有 Flutter 预览。仅新增本报告。无编造性能收益或真机验收结论。
