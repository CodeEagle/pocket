# 本机工作与 main 的冲突处理

2026-11-13，在 `d109f59` main 上恢复本机 WIP，用户授权解决冲突、提交和推送。
原工作区与 index 备份在 `~/.codex/backups/pocket-branch-cleanup-20261113-173452/`，
原代码未被静默丢弃；已被 main 后续实现替代的版本不重复提交。

## 来源和决策

- 保留 main 的 host-native font ABI、复杂文本测量、字体回放事实、PAK 字体准入及
  已有回归测试。原本地早期字体实现不覆盖 main；不用两套状态/绘制路径并存。
- 保留 main 的 secondary-route pop 动画、动态宽度和 retained route 生命周期，
  只叠加 Looseleaf 的入口、路由、页面和状态类型。
- 保留 main 的编辑器子项目/频道发布 UI、进程身份验证和树形退出管理；
  不恢复本地临时 `ps`/`process.kill` 依赖缺失 fallback。
- 恢复已有本机 `sdk/packages/pocket_looseleaf/`、`pocket_arc/`、`pocket_ui/src/bytes.ts`
  及相关测试；公共 SDK 不依赖 demo。JS 控件继续使用固定 PocketJS 的组件、输入和 layout，
  Flutter 未新增业务状态机。原库中描述的 Looseleaf/ARC 视觉来源保留在其源码说明里，
  本次未重新设计或用另一套运行时实现。
- 沿用 `build_guest.ts` 的 publicUiPackageRoot/prepareUiPackage/preload/cleanup，
  接入两包；补齐 npm/Bun workspace lockfile 和 Web SDK 导出路径，避免只在源码工作区可用。
- 保留本地 Editor 的状态文件 mtime 失效与 Spine 模块按需加载改动，
  沿用现有安全文件路径边界，仅给新增两库增加精确 vendor allow-list 项。
- 原本地 bitmap 字体 fallback 输入已经被 main 的 host-native 路径替代，
  不提交 23 MB 未使用字体或生成缓存；原文件在上述备份中保留。
- 按用户之前指定使用当前机器的项目路径和 Codex，未新增 Argon 子代理。
  retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` 不在本机；
  本次重用当前 main 已迁移的 SDK/回归场景，未引入新 Flutter 原生能力。

## 验证

- 全新固定上游归档校验、应用完整补丁栈成功；第二次 bootstrap 幂等检查成功，
  不再使用旧字体缓存的 compiler override 绕过补丁校验。
- Showcase 通过默认 source buildGuest 生成真实 QJBC/PAK；
  运行匹配的 `pocket_probe`，完整 bytecode/ABI/host request-response/frame/send/pointer/
  input/stress 回归通过。Gallery Lazy 使用真实有界多次拖动而非固定单次坐标假设。
- 新增 `scripts/tests/ui_packages_native.test.ts`：两个公共包通过同一编译链构建，
  真实指针点击 Paper / ARC 按钮，Count 0 → 1 → 11，DrawOps 确实改变；
  没有 mock runtime、source-eval fallback 或跳过 native 断言。
- 5 个隔离 JS suite 全部通过：设备计划 8 项、Editor versions 5 项、
  Editor concurrency 1 项、Looseleaf 3 项、UTF-8/Base64 4 项。
- ARC 边界/调色板/弹簧/utility 检查通过；Showcase mobile source/state 回归通过。
- Web SDK 导出 2 项通过，校验两库的 source/manifest 已导出且不带测试/缓存。
- Bun frozen-lockfile 安装通过；architecture boundary 与 diff whitespace 检查通过。
- 本轮未重复此前 Flutter 3.50 的全部设备/Live2D 验收；此轮未改 Dart renderer/FFI，
  之前的验证范围见 `FLUTTER_3_50_UPGRADE.md`。本次 native probe 不等于物理设备 IME 或 GPU 视觉验收。

日志和临时产物位于 `/tmp/pocket-flutter-350-validation/conflict-*`，不作为源码提交。
