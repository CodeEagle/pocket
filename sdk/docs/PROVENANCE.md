# 来源与版本

- PocketJS 上游：`pocket-nexus/pocketjs`，固定 revision `99924de47c62fa36f526a8791055d91cbbdb3836`。
- 源归档 SHA-256：`82d5d72ca242b5827379e0e7a53114bc9ee2093af0a9306336a5def543708cba`；由 `scripts/prepare_upstream.py` 校验后展开到本目录 `.cache/pocketjs`。
- Native/Flutter 适配来源：用户自有 `PocketJSKit` 的 `native` 与 `packages/pocket_flutter`，本次抽取到独立目录并按最小宿主边界裁剪。上游补丁在 `native/patches` 保留。
- 本仓库原 demo 用于组件、交互、系统输入和业务场景核查；可复用的纯 JS 逻辑与真实原生适配继续按需迁移，不整体导入其 Dart 业务树、模拟 runtime、旧 AOT/OTA。具体来源与当前缺项见 [框架对照](FRAMEWORK_GUIDE.md)、[输入复用](INPUT_REUSE.md) 和 [滚动复用](SCROLL_REUSE.md)。
- `pocket_services` 从 PocketJSKit 的签名包、update、host、plugin 和 stream 模块裁剪，移除游戏配置与业务容器依赖；签名 guest manifest 是独立能力契约。
- `guest/ui` 和演示页由 JS 组合；`guest/ui/mobile.tsx`、`guest/mobile-pages.tsx`、`guest/legacy.ts` 是本仓库的 mobile composition/transition/glass 适配层，沿用旧 UIKit/Router 的纯 JS 词汇和数学，但不引入旧 Dart hydration 或第二套 renderer。
- `package_info_plus` 8.3.0 作为真实外部 Flutter 插件示例；可复用的 `pocket_hardware` package 将 `flutter.hardware` provider（Dart adapter、iOS/Android MethodChannel、Texture manager）通过标准 Flutter plugin registry 编译进宿主，真实权限/Texture 设备验证入口在 `demo/integration_test/hardware_native_test.dart`，由 root 按目标设备验证。
- `native/src/bytecode.rs`、`pocketjs_bytecode` CLI 和 `guest-rquickjs-bytecode.patch` 是本次新增，复用 Cargo.lock 固定的 rquickjs 0.12.2 / QuickJS 序列化 API。
- `native/src/lib.rs` 的 `pocket.registerSurface`、`packages/pocket_flutter/lib/src/pocket_model.dart` 的 `PocketHostSurfaceOp`、`pocket_view.dart`/`pocket_surface.dart` 的 surface stack 是本仓库的 `SURFACE_QUAD` bridge；provider allow-list 是 `glass` 和 `platformTexture`，不是任意 compositor。`pocket_surface.dart` 的 `liquid_glass.frag` shader 在支持路径提供折射，其他路径保持明确磨砂 fallback。
- `editor/server.ts`、`editor/client/`、`editor/test/editor_live_probe.ts` 复用旧 PocketJSKit editor 的本地 project/build/publish 工作流（详细来源见 [EDITOR_REUSE.md](EDITOR_REUSE.md)），改为当前 guest scaffold + qjbc/PAK + `scripts/package_update.ts`。多文件 GET/PUT 有路径、symlink、构建/密钥/二进制保护；`app.js` 只作诊断，不成为 runtime 回退来源。
- PocketJSKit 原工程完整源码快照、清单、摘要和许可已按清理前约定归档到 `migrations/pocket_flutter_poc-source-20261102.tar.gz` 与同名 JSON，入口和清理状态见 `migrations/README.md`。当前构建和运行不依赖旧绝对路径、symlink 或待删除的原目录。
- 保留原 MIT LICENSE。缓存、编译产物、签名私钥和用户业务项目不属于源码交付。
- 工具链基线：Flutter 3.35.7 / Dart 3.9.2，Rust 1.93.1；Bun 使用上游 lockfile 安装编译器依赖。

来源 Git 基线（本地工作区可能含未提交改动，不能以 commit 代替实际文件快照）：

- PocketJSKit 所属仓库：`4c21e7fc3d737b43fa00f6b100fef6e2a3236160`。
- 原 demo：`d95fdcddab3a6ac3ef0d742406c76379918adbf0`。

## 本轮实现与验证边界

- `tests/mobile_ui.test.ts` 覆盖 mobile controls、四种 transition descriptor、glass recipe、surface registration 文本契约和 route stack；`packages/pocket_flutter/test/pocket_surface_test.dart` 覆盖 surface descriptor、clip/paint order、Texture 授权/撤销。它们证明源码协议与 widget 生命周期边界，不等于 Impeller/非 Impeller 的真机视觉一致性。
- `demo/test/hardware_plugin_test.dart` 直接导入 `pocket_hardware`，覆盖 descriptor、Android-shaped contract、unsupported/timeout、相机 Texture cleanup、weather coordinates 和 late result。`hardware_native_test.dart` 使用标准 plugin 注册后的生产 MethodChannel，但 Android/iOS 实体硬件验证仍需对应设备，本文件不宣称设备结果已通过。
- `editor/test/editor_server.test.ts` 覆盖编辑器 HTTP/state/signing plumbing；`editor/test/editor_live_probe.ts` 使用真实 guest/compiler 进行 qjbc、PAK、signed manifest/blob/host.json 及坏源码不发布旧 build 的闭环。临时 workspace/artifact 不写入 `host/assets/`。
- `packages/pocket_services/lib/src/pocket_plugin.dart` 的 activation failure/revocation 和 `packages/pocket_sdk/lib/src/pocket_session.dart` 的 cache fallback、generation/timer cancellation 是旧审计后已落地的源码修复；对应服务/update lifecycle 测试已有记录，未执行的设备验证仍看 [VALIDATION.md](VALIDATION.md)。
