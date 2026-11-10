# FunApp iOS 原生 ABI 更新边界

2026-11-10。FunApp 的 `Release`/`Profile` 通过 `Flutter/Intiface.xcconfig` 限制最终 Runner 的动态导出；仅更新 Pocket Dart Git 引用或 SwiftPM 的 `-export_dynamic` 无法覆盖该限制。静态库已包含 ABI、最终 Runner 缺少 ABI 的消融证明问题位于消费者链接边界。

来源检查：保留父工程 `pocketjs_flutter_demo/ios/PocketRuntime/pocket_runtime.podspec` 与 `Classes/pocket_runtime_multi.c/.h`（排除 `pocket_host/`）。保留已有静态链接、定向 `-u` 根与同一 PocketJS 引擎；没有添加另一份原生实现或全局 SDK 导出过滤。

FunApp 的实现和唯一更新命令在 `tools/POCKET_NATIVE_UPDATES.md`：`tools/flutter_pub_get_fast --update-pocket <ref>`。`tools/pocket_ios_linker.rb` 仅向已有过滤的 Runner 配置合并 `_pocket_*`，保留 intiface；无过滤的 Debug 保持开放导出，并自动清理早期误加的白名单。不能把此消费者策略放入公共 Pocket Package.swift，否则会影响其他消费者的原生 FFI。

预检从选定 SDK 的 Dart FFI 查找和间接包装器中收集 ABI，验证 iOS 静态库、新符号前缀和 SDK 路径一致性；Podfile 幂等安装最终 Runner `dyld_info -exports` 检查。源码或工具链改变仍需重建固定原生工具链；符号兼容不证明缓存二进制与源码提交一致。

验证：实际 Mach-O 消融覆盖默认开放导出、intiface 过滤、消费者合并和不安全公共过滤；签名 Release-Dev 构建及安装成功，最终 Runner 41 个 Pocket FFI 和 intiface 关键接口导出通过。Ruby 3 项测试/27 条断言与 Python 14 项检查通过。手机完整游戏交互尚未由本项验证。
