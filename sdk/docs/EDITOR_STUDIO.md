# 本地 Pocket Studio

Studio 编辑原始 JS/TS 项目，使用 SDK 已有的 `buildGuest` 构建 QuickJS 字节码，提供网页交互预览和 Flutter 设备部署。默认页面仅显示预览、测试包与折叠高级设置，Copy preview link 供 Codex 浏览器直接访问。内置聊天已移除，详见 [预览页说明](EDITOR_PREVIEW_PAGE.md)。业务页面仍属于 JS；这次没有增加 Dart 页面或第二套布局引擎。

## 启动 Showcase

```sh
cd demo/js
bun run editor
```

浏览器打开 **http://127.0.0.1:8791**。`editor:status` 查看服务，`editor:stop` 停止这一个服务。8791 使用独立的 workspace 和日志，不替换原有 8790 更新服务。服务由当前 macOS 用户的临时 launchd job 托管，不安装登录项；退出登录或重启后需要重新启动。

通用消费者可以直接运行：

```sh
cd sdk
bun pocket.ts editor /absolute/path/to/js-project \
  --flutter-root=/absolute/path/to/flutter-project --port=8791
```

Flutter 根目录是启动时的可信配置，网页不能提交任意本地路径或命令。仅需网页预览时可以省略 `--flutter-root`。首次使用需按 SDK 集成指南准备 Bun、Pinned PocketJS、Rust native probe 和消费者的 Flutter 依赖。

若本机尚未构建网页预览需要的 probe，先完成 SDK bootstrap，再在仓库根目录执行 `cargo build --manifest-path sdk/native/Cargo.toml --bin pocket_probe`，然后启动 Editor。也可以通过启动环境变量 `POCKET_NATIVE_PROBE` 指定已有二进制。

## 编辑与预览

1. 选择项目和源文件，修改并保存。
2. 构建，查看真实编译日志和 QJBC/PAK 产物。
3. 网页预览接收真实运行时帧；可以点击、滚动、输入和切换视口。
4. 选择设备并部署，检查 Flutter 实际效果。

显示名称与机器名称分开：设置中的 Display name 更新 `pocket.title`，保留已有合法的 `pocket.name` slug；保存配置保留消费者自定义入口、输出名称和其他 app 字段。`editor.json` 保存 Editor 的版本/build 等构建身份，遵循 SDK 既有优先级。

网页端不是 Flutter Web。`preview.ts` 启动 SDK 的 `pocket_probe`，加载已构建的 QJBC/PAK，执行 PocketJS 布局、Guest 事件和帧逻辑。`client/preview.js` 将真实 FrameResult 的 DrawOps 和资源投到 Canvas2D。运行时的 demand schedule 决定下一次唤醒，SSE 推送帧；没有持续空闲绘制探针。最后一个浏览器订阅断开后释放空闲 probe，活动会话数量有上限。

Canvas 的字体、圆角栅格、资源解码与 Flutter 可能不同，浏览器性能数据不能代替 Flutter 真机 FPS/功耗验收。System catalog 映射启动真实 SystemUI，并为已安装且有构建产物的子应用启动独立 native probe；adapter 将真实 child DrawOps 按 host-surface rect 做裁剪/缩放、资源命名空间隔离和输入坐标转换。Showcase 的 Profile → Lobby → 返回结果链已用真实 JS guest 验证。子 probe 接收 `system.runtime.create` 的 `memory.heapLimitBytes`/`maxPakBytes`，由现有 native QuickJS/PAK admission 执行；浏览器不承诺 GPU、Dart 或操作系统内存配额。原生硬件、视频和依赖原生 textInput 插件的输入框不会被伪造为成功；相应行为需要部署到设备确认，浏览器键盘事件转发不等于完整原生 IME。未知 host capability 返回明确 unsupported 错误而不是永久 pending。源码保存后需重新构建，旧构建的预览不代表未构建的最新源码。

## 模拟器与真机部署

`devices.ts` 使用 `flutter devices --machine` 枚举当前可用目标，支持 iOS Simulator、Android Emulator、连接的 iOS/Android 设备。未启动的模拟器需要先在 Xcode/Android 工具中启动；无线设备需先建立 Flutter 可识别的连接。

部署先执行同一 SDK 字节码构建流程，再执行绑定消费者的 `flutter run --machine`。带 System 子应用的消费者复用既有 `build:system` 管线。设备 ID 必须来自实际枚举；命令使用固定 argv，网页不能传 shell 命令。日志与任务历史有容量限制，构建/启动有并发锁，取消只终止 Studio 自己启动的子进程。

状态到 `running` 表示 Flutter 已启动预览。可以继续编辑源码；需要重新构建、停止旧部署并再次部署，当前没有声称 TSX 自动热重载到已运行的字节码。真机仍需要消费者工程本身的签名、开发者模式、USB/无线信任和系统权限；错误在部署日志中显示，Studio 不代办这些系统授权。

## 给 Codex 打开预览

选择并构建项目后点击 **Copy preview link**，把绝对链接交给 Codex 浏览器即可直接打开并操作预览。独立预览路径为 `/api/projects/<project-id>/preview`；本地页面无需 Codex 登录，不发送模型请求。

源码和构建操作仍使用当前项目文件与 pinned `buildGuest`，代码修改在外部 Codex 中完成。页面不再保留内置聊天、模型选择、附件和聊天区域标注状态。旧传输 API 暂保留给既有调用方，网页不会访问它们。

## 代码职责与复用来源

| 代码 | 职责与来源 |
| --- | --- |
| `editor/server.ts` | 复用既有 Editor 的文件、安全、构建与签名发布边界，组合新路由。 |
| `editor/preview.ts`、`client/preview.js` | 使用现有 native probe/FrameResult；新增本地 SSE 与 Canvas 投影适配，不复刻布局引擎。 |
| `editor/devices.ts` | 可信消费者绑定、固定命令、设备枚举、部署任务与进程生命周期。 |
| `editor/codex.ts` | 复用 pinned PocketJS `tools/companion/codex.ts` 的 CLI/App Server 传输，增加项目/图片/区域/任务边界。 |
| `editor/client/` | 编辑、预览、设备日志、悬浮对话的纯网页 UI。 |
| `scripts/editor_service.sh` | macOS 服务托管，复用原入口并按端口隔离状态。 |

实现前检查了保留的旧工程 `pocketjs_flutter_demo`（排除 `pocket_host/`），参考 `native/` 的 Guest 执行链和 `web_wasm_preview/index.html`。保留当前 SDK 已迁移的 Editor 项目/构建工作流，扩展现有 native probe。旧网页中的演示图形不是通用 Guest 执行器，因此没有复制为“Demo 已支持网页”的占位实现。Codex 接入复用当前 pinned 上游 `tools/companion/codex.ts` 传输；没有复制用户凭证或引入新的认证存储。没有保留新模块的兼容别名、重复模型清单或后台空闲帧轮询。原来的签名发布入口保留在折叠的 Advanced 区域。

## 验证

```sh
cd sdk
bun run test:editor
python3 scripts/check_architecture.py
```

Editor 回归覆盖既有文件/安全/构建发布流程，以及 Codex 传输、图片/区域边界、真实 native Guest 输入变帧、设备固定命令/并发/取消。真实模型请求、浏览器和模拟器验收结果应与单元测试区分；测试不伪造模型或设备上线成功。

本轮实际验收：

- `bun run test:editor`：28 pass / 0 fail；架构边界检查与客户端语法检查通过。
- 本机 CLI 返回 ChatGPT 登录状态和 8 个动态模型；真实请求完成，无凭证文件读取或复制。
- Playwright Chromium 从网页保存并恢复源码、真实构建、点击 Showcase 计数 `00 → 01`。
- 网页框选后，真实模型收到截图和 `(25,52,325,160)` 区域，识别出 `Made to feel native.`；后续消息沿用同一 thread。
- 通过 Editor 网页按钮真实执行 System 主/子应用构建及 `flutter run --machine`，在 iPhone 18 Pro Simulator 安装并显示首页；状态到达 `running`，刷新网页后恢复该任务与停止按钮。
- 移动 `390×844` 与平板 `768×1023` 切换后，已校验运行时实际尺寸；使用有效的 10-bit pointer 范围，避免提供超出 1023 坐标的交互预设。
- Canvas 已验证贴图加载、圆角 mask、ARGB tint 与资源增量重放；真实 Hero 圆角内像素 `(28,80)` 为 `[49,93,235,255]`。新订阅者会补齐已有贴图，普通帧仍只传资源增量。
- 独立的两个 Chromium 客户端都通过圆角/图标像素检查；第二个客户端收到 8 份缓存资源，未因原生资源只发增量而缺图。
- Android 真机已被实际枚举；本轮没有安装到该真机，不将枚举成功当作真机部署验收。

本地验收日志/截图位于 `/tmp/pocket-studio-acceptance-verified.log`、`/tmp/pocket-studio-deploy-ui-final.log`、`/tmp/pocket-studio-preview-fixed.png`、`/tmp/pocket-studio-device-final.png`，属于临时证据，不是 SDK 发布产物。

测试包与模拟器 Check/Apply 的接入、版本规则及实际验收见 [Editor 测试包与模拟器热更新](EDITOR_TEST_PACKAGES.md)。
