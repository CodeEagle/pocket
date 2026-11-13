# Pocket Studio（Pocket 原生编辑器）

Studio 是用 Pocket 自己构建的编辑器：界面是 TSX（`@pocket/ui`）编译成的 QuickJS 字节码，运行在
macOS 上的薄 Flutter 宿主里；后端仍是 `sdk/editor` 的 Bun 服务。`studio/` 与 `demo/` 一样只是 SDK 的消费者。

> 网页 Studio（`bun pocket.ts editor <项目>`）对 Pocket Studio 已覆盖的功能现为 **legacy**；视觉小说编辑器、微信预览、Noble
> 蓝牙和 Codex 仍只在网页 Studio（负责人决定）。macOS 验收通过后 `--pocket` 将成为默认入口。

- [`js/`](js/)：Studio guest（`app.tsx`、`src/studio-client.ts` 能力客户端、项目列表、文件树、只读查看器）。
- [`lib/main.dart`](lib/main.dart)：薄宿主（≤ 100 行），注册 `PocketStudioPlugin` 与剪贴板插件，仅向
  `dev.pocket.studio` 授予 `studio.*` 与剪贴板权限，预览子应用 `dev.pocket.studio.preview` 没有任何授权。
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：分层、冻结的 `studio.*` 能力表、权限模型、路径脱敏、服务生命周期。
- [`docs/PARITY.md`](docs/PARITY.md)、[`docs/M0_REPORT.md`](docs/M0_REPORT.md)：网页 Studio 对照清单与审计。

只支持 macOS（`macos/`）。构建与运行：

```sh
cd studio/js && bun install && bun run build   # 产物写入 studio/assets
cd .. && flutter pub get
flutter run -d macos \
  --dart-define=POCKET_STUDIO_SDK_ROOT=/绝对路径/pocket/sdk \
  --dart-define=POCKET_STUDIO_PROJECT_ROOT=/绝对路径/某个 Pocket 项目 \
  --dart-define=POCKET_STUDIO_WORKSPACE=/绝对路径/studio-workspace
```

或一条命令（仅 macOS）：`bun sdk/pocket.ts editor --pocket [<项目>] [--port=N] [--workspace=DIR]`。它把可信配置写入
`<workspace>/pocket-studio-host.config.json`，把 `studio/js` 作为额外项目根（Studio 可以打开、构建并发布自己），再运行
`flutter run -d macos`；非 macOS 会报错 “Pocket Studio host is macOS-only; use the web Studio (bun pocket.ts editor) on this platform”。

Studio 自更新：在“设置 → Studio 更新”点“检查 Studio 更新 / 应用更新”，宿主走已签名的测试频道（`POCKET_STUDIO_UPDATE_CHANNEL`
可改为 `stable`），失败的构建由 SDK 自动回滚到上一个健康版本；内置字节码始终是后备。详见 `docs/ARCHITECTURE.md`。

可信配置（SDK 路径、端口、项目根）只来自这里的 `--dart-define`（或 `--dart-define-from-file=studio.config.example.json`），
guest 看不到绝对路径、签名密钥、socket 或 CSRF 令牌。宿主会附着到已在运行的编辑器服务，否则用
`bun <sdk>/pocket.ts editor` 启动并在退出时停止。

测试（Linux 容器可跑，使用真实原生库）：

```sh
cd studio/js && POCKET_SOURCE_BUILD=1 TMPDIR=/tmp bash scripts/test_guest.sh
cd .. && POCKET_NATIVE_LIBRARY=/path/to/libpocket_flutter.so flutter test
```
