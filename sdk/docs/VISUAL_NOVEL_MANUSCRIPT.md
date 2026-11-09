# 普通文本手稿导入

## 来源与实际行为

按 source-first 检索了保留父项目 `pocketjs_flutter_demo`，排除 `pocket_host/`，未找到 DOCX/XLSX/PDF 或 VN 手稿转换器。保留父项目的 `mini_apps/app_ui_showcase/main.js` 提供通用输入/弹层行为；当前 SDK 的 `authoring.ts`、`interchange.ts`、Editor `novel-authoring.js` 与 `novel.js` 已有 canonical StoryDefinition、草稿、持久历史和构建链路。本实现只补普通文字文件到该文档的转换，不增加剧情解释器。

Editor 顶栏「导入手稿」读取 UTF-8 `.txt`，打开预览后才允许「加入草稿」。每个非空行转换为一条 `say`，保留源行号供审阅：

- `【Mira】不要把回声当成答案。` 和 `[Mira] Don't mistake an echo for an answer.` 显式指定说话人。
- 当前故事已有说话人的 `Mira：对白` / `Mira: dialogue` 也会提取说话人。
- 未识别的冒号前缀保留整行并提示，不猜测新人物。时间 `23:08` 和 URL 不被当作说话人。
- 没有前缀的行是旁白。空行忽略；这是逐非空行导入，不承诺还原 Word 排版或自动合并折行。

导入新增一个标签，不覆盖已有标签；默认保留原起点，可在预览明确选择新起点。ID 按前缀/序号生成并跳过已有行 ID。不会自动编造场景、分支或结局；作者可继续用原 Editor 编辑。`{{变量}}` 沿用现有引擎插值语义。

## 消融与数据边界

转换器 `parseNovelManuscript` 是公共 JS SDK 的纯函数，Editor browser runtime 复用同一函数；结果直接是原 `say` AST，不保存平行手稿格式。加入草稿复用已有 `historyMutation`，因此可撤销/重做、未保存草稿重开和正常保存，不维护额外导入状态机。取消、重复标签、坏编码及解析错误都不修改故事。异步文件读取与预览应用检查已有草稿版本，防止套用过时结果。

文件上限 2 MiB，解码必须是合法 UTF-8；纯函数限制 1,000,000 个 UTF-16 单元、5,000 个非空行、每行 16,000 单元。触及限制或格式错误时不返回部分章节。预览使用只读文本控件，不解释手稿中的 HTML/JS。

## 运行证据与未完成范围

历史异步检查也沿用现有 `historyBusy` 门禁；核对期间禁用导入入口，已经打开的预览不能提交。2026-11-07 新增真实键盘回归：在预览中按 Ctrl+Z，延迟服务器的 history head 响应，此时提交必须被拒绝；放行后只执行原撤销，重做仍只恢复原章节。此回归与 SDK、pinned Guest 流程共 3 项通过（6.44 秒），最终公共 SDK 集成日志 `/tmp/pocket-manuscript-import-race-integrated.log`。

2026-11-07：SDK 两项测试和真实 Chromium Editor 流程共 3 项通过，日志 `/tmp/pocket-manuscript-import-final.log`。浏览器验证了源行/说话人预览、取消、同名标签拒绝、加入草稿、未保存草稿重开、undo/redo、保存重开、非法 UTF-8 拒绝，并从 Editor 同一 pinned `buildGuest` 构建真实 QJBC，再以 native 指针点击开始，观察导入文本实际绘制。测试使用临时项目和端口，完成后关闭，不启动普通 Demo 的编辑后台。

命令：`bun test packages/pocket_vn/test/manuscript.test.ts editor/test/novel_manuscript_browser.test.ts`（cwd `sdk`，配置匹配的 `POCKET_TOOLS_PACKAGE` 与 `POCKET_NATIVE_PROBE`）。

I01 仅普通文本及其审阅闭环得到此证据；Excel、Word、文字 PDF 解析和这些格式的字段映射仍未实现。不能把文本文件改扩展名视为支持这些格式。
