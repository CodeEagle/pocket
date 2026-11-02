# 旧工程源码保留

`pocket_flutter_poc-source-20261102.tar.gz` 是用户要求清理旧工程之前的源码快照，包含未提交的 editor、模板和状态记录修改。它不是当前工程的构建依赖，也不会解压到运行目录。

- 来源：`/Volumes/ORICO/Development/TryJoy.c/TryJoyMono/App/repos/pocket_flutter_poc`。
- 收录 Git 跟踪及未忽略的普通文件，排除缓存、构建产物、符号链接及 `.pak/.qjbc/.pjc/.wasm/.a/.dylib/.so/.bin`。
- 554 个文件，压缩约 59.5 MiB；原目录约 21 GiB。
- 归档 SHA-256：`0e9f202e80a9659940105e0c97e77d3a2267dd5b34577a24a4eb8dea1030b635`。
- 同名 JSON 清单包含源 Git 基线和每个文件的大小/摘要，已逐文件读回归档校验。
- 缓存中的固定 PocketJS 上游由 `scripts/prepare_upstream.py` 重建；当前需要的 renderer、服务和 editor 实现位于正常源码目录。

后续需要追查未迁入示例时，可在独立临时目录展开此快照；不要恢复旧构建缓存或让运行时重新依赖原路径。源文件的许可和原项目说明随快照保留。

清理状态：2026-11-02 已按用户授权删除旧目录，原目录约 21 GiB（先清理可重建缓存，再删除剩余目录）。删除前再次逐文件比对 554 个源码文件，未发现变更或未归档的新源码。执行记录见 `cleanup-20261102.json`；保留约 59.5 MiB 源码快照。
