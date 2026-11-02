# Pocket 当前状态

- 独立目录：`/Volumes/ORICO/Development/Github/pocket`。这是最终版本的工作目录；原 `pocketjs_flutter_demo/pocket_host` 保留作来源副本，不再作为运行入口。

- 更新时间：2026-11-02（Asia/Singapore）。
- 集成：公共 `pocket_sdk`、`@pocket/ui`、`pocket_hardware` 已抽出；Showcase 页面、状态、导航与主题在 JS，Flutter 只负责绘制、输入与原生能力桥。
- 工具：统一 QuickJS 字节码编译；`sdk/pocket.ts init/build` 可生成独立消费工程。Editor 服务 `http://127.0.0.1:8790`，签名更新配置 `sdk/.pocket-build/editor-host.json`；最新输入修复发布为 revision 18 / 0.1.1。Demo 的 Flutter 工程在 `demo/`，JS 工程在 `demo/js/`。独立迁移边界见 `sdk/docs/STANDALONE.md`。
- 验证：SDK 设备 8 场景、完整签名升级/回滚/坏包恢复/缓存重启、Duo 实际开合、硬件通道、独立脚手架真实输入通过。完整边界见 `docs/VALIDATION.md`。
- 清理：旧 `pocket_flutter_poc` 已按用户授权删除，约 21GiB；临时的 `migrations/` 归档在审计清理阶段已移除，保留的权威参考为父目录 `pocketjs_flutter_demo`（不含 `pocket_host`），未提交 Git。删除后重新编译及 native probe 通过。
- 输入修复完成：缺省 viewport 几何保留完整快照，height-only resize 不清除 regions；JS 与 Flutter 编辑器共用样式，移除深色覆盖。实际键盘逐帧布局、中文/emoji/选区/组合输入、滚动与 App 内 Editor Update Check 共 4 场景通过，`available=0.1.1`。
- 更新服务：发现原工具子进程被回收造成连接失败；已恢复服务并验证签名和实际 Dart 下载链路；`scripts/editor_service.sh start|stop|status` 使用独立 launchd job，独立新目录服务 / PPID 1。独立 shell 健康检查和服务内重新编译均通过。普通 Duo App 已激活 0.1.1，Flutter 已 detach。
- 性能：常驻 FPS 和持久化历史保留；SDK 模拟器静态/计数/500 节点/Glass 稳态约 60Hz，不能否定自然场景的短时低帧。
- 限制：本地 SDK 尚未发布 npm/pub.dev；Android 硬件 provider 已接入同一
  MethodChannel/权限协议，但真实相机、BLE、传感器、定位、生物识别仍待 Android
  真机验证；macOS 硬件 provider、真机 IME 与持续性能也尚未完整验证，不能把
  未验收的设备结果宣称为平台能力齐平。
- 导览：`docs/SDK_INTEGRATION.md`、`docs/FRAMEWORK_GUIDE.md`、`docs/INPUT_REUSE.md`、`docs/PERFORMANCE.md`。

- 独立迁移验收：源码及本地签名更新工作区已迁至当前 `/Volumes/ORICO/Development/Github/pocket`；旧目录保留。全新依赖安装和 guest 编译、native probe、mobile 几何测试、架构边界、Flutter analyze 均通过；Editor 已从当前路径启动。迁移说明见 `docs/STANDALONE.md`。

- 最终目录已验收：`sdk/` 为可直接依赖的 Flutter SDK，`demo/` 为 Flutter 工程根，`demo/js/` 集中所有页面和 JS 工具。新路径下真实 Duo 输入/滚动/更新检查 4 场景通过。两个 CLI/Editor starter 已合并为一份，更新服务器也只有 SDK 一份实现。

- Android 适配：arm64/API24 原生 runtime + Android 硬件 provider 已构建，
  APK 含实际 `libpocket_flutter.so`。API35 arm64 模拟器硬件 channel 集成测试通过；
  API36 MAA_AN00 真机安装被设备以 `User rejected permissions` 拒绝，未执行
  真机硬件测试。权限消融移除未使用的录音、媒体/外部存储、BLE 广播和身体传感器权限。
