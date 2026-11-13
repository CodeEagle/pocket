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

## 快捷键（M7）

主修饰键为 Cmd（macOS）/ Ctrl（其他）。完整表在“设置 → 键盘快捷键”，来源是同一个 `js/src/keymap.ts`。

| 快捷键 | 动作 |
| --- | --- |
| Cmd+S | 保存当前文件（代码视图获得键盘时由编辑器自己的 save 意图处理） |
| Cmd+F | 查找（编辑器内由 CodeView 处理；在其他页面时切到源码页并打开查找栏） |
| Cmd+B / Cmd+Shift+B | 构建 / 构建并刷新预览 |
| Cmd+P | 快速打开（模糊文件查找；↑↓ 选择，Enter 打开，Esc 关闭） |
| Cmd+W | 关闭当前标签（有未保存修改会先询问） |
| Cmd+Shift+[ / ] | 上一个 / 下一个标签 |
| Cmd+1 … 9 | 切换到第 N 个侧栏页面 |
| Cmd+Shift+P | 打开发布页 |
| Esc | 关闭对话框或快速打开（都没有时交给编辑器） |

优先级：编辑器作用域的键（保存、查找、方向键等）在 CodeView 获得键盘时属于编辑器；全局键（构建、快速打开、切页……）总是先于编辑器；
没有绑定的键原样交给编辑器。焦点在 Flutter 输入框（`InputField`）时，按键属于输入框。详见 `docs/ARCHITECTURE.md`“键盘与快速打开（M7）”。

## 测试

在 Linux 容器里运行，使用真实原生库与真实编辑器服务（路径按本机调整；`POCKET_SOURCE_BUILD=1 TMPDIR=/tmp` 让固定版本编译器使用本地缓存）：

```sh
export POCKET_NATIVE_LIBRARY=/绝对路径/pocket/sdk/native/target/debug/libpocket_flutter.so
export POCKET_SOURCE_BUILD=1 TMPDIR=/tmp
cd studio/js && bash scripts/test_guest.sh        # 单元、构建字节码、探针上的 guest 测试（含键盘与性能剖析）
cd .. && flutter analyze && flutter test --no-pub  # 真实库 + 真实服务的 M1-M7 退出测试（含录制/回放回归）
```

* `test/studio_recording_test.dart`：用 SDK 的录制设施录下“打开 -> 编辑 -> 保存 -> 构建 -> 发布”，离线回放并核对每个帧摘要，再回放导出的归档，并与 `test/fixtures/journey_checkpoints.json` 的语义检查点对比（`STUDIO_UPDATE_FIXTURES=1` 重新生成）。
* `js/tests/studio_profile.test.ts`：5,000 行文件打开/滚动/键入 100 键/构建/发布的帧耗时、RSS、标签开关泄漏与 QuickJS 堆上限；数字见 `docs/PERFORMANCE.md`。

## 故障排查

* **“bytecode package requires host-native fonts”**：字体度量必须在录制的第一个事务之前安装；`PocketView` 已在 compositor 配置前同步字体（M7 修复）。自带宿主请先调用 `syncPocketHostFonts`。
* **Guest 单轮 250 ms 预算**：探针返回 `pocket_probe frame failed`。大文件读写已在 `studio-client.ts` 切片；新增重计算请用 `yieldTurn` 分片。
* **`flutter test` 被跳过**：未设置 `POCKET_NATIVE_LIBRARY`，或找不到 `bun`（用 `POCKET_BUN` 指定）。
* **`bun install` 之后才看到 SDK 改动**：`studio/js/node_modules/@pocket/ui` 是拷贝；修改 `sdk/packages/pocket_ui` 后在 `studio/js` 重新 `bun install`。
* **macOS 上 `--pocket` 报错或窗口空白**：先 `cd studio/js && bun run build`，确认 `studio/assets` 有 `app.qjbc`；Cmd+W/Cmd+P 被系统菜单吞掉等问题见 `docs/RELEASE_CHECKLIST.md`。
* **服务端口占用**：`--port=N` 另选端口；宿主会附着到已运行的编辑器服务。
* 所有 macOS 才能验证的验收项集中在 `docs/RELEASE_CHECKLIST.md`。
