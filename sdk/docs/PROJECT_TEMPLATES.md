# Pocket 项目模板

Pocket SDK 提供两个创建模板。它们使用同一套 Solid/QuickJS 项目结构、同一个 pinned `buildGuest` 编译器和同一套 Flutter 薄宿主；模板只决定初始的 JS `app.tsx` 和项目说明。

## 选择模板

命令行默认使用 `app`：

```sh
cd /Volumes/ORICO/Development/Github/pocket/sdk
bun pocket.ts init /absolute/path/to/my-app \
  --template=app \
  --app-id=com.example.myapp \
  --name=my-app \
  --version=1.0.0 \
  --sdk-root "$PWD"
```

创建游戏项目时改用 `game`：

```sh
bun pocket.ts init /absolute/path/to/my-game \
  --template=game \
  --app-id=com.example.mygame \
  --name=my-game \
  --version=1.0.0 \
  --sdk-root "$PWD"
```

`--template` 只接受 `app` 或 `game`，省略时为 `app`。选择会写入生成项目的 `editor.json.template`，记录创建来源；后续构建使用项目现有源码，不会重新套模板。目标目录必须为空；模板选择无效时，CLI 会在创建目录前报错。

Pocket Studio 左上角的项目选择器可以切换已有项目。点击旁边的 **新建项目**，在创建对话框中先选择模板：

- **App**：screens、forms 和 product UI。
- **Game**：frame loop、input 和 game state。

Studio 将选择通过 `POST /api/projects` 的 `template` 字段提交，并将它保存到 `editor.json`。已有项目不会因为打开 Studio 而自动换模板。CLI 会另外生成 `vendor/pocket-ui/` 和 `flutter/`；Studio 工作区创建的是 JS 工程，直接使用 SDK 的公共 UI 包与 Preview。

## App 模板

来源文件是 [`templates/app/app.tsx`](../templates/app/app.tsx)。它保留原 starter 的可运行移动 App 行为：`MobileThemeProvider`、`MobileScaffold`、`MobileAppBar`、安全区/折叠屏 pane 计算和明暗主题切换。页面和状态都在 JS/TSX，Flutter 只生成薄宿主。

生成后主要修改：

```text
my-app/
├── app.tsx                 # App 模板的 JS UI 入口
├── manifest.json           # Guest capability/permission 声明
├── pocket.json             # Pocket app 运行配置
├── editor.json             # Studio/CLI 身份与 template=app
├── vendor/pocket-ui/       # 由 SDK 复制的公共 UI 包
└── flutter/                # 生成的薄 Flutter 宿主
```

App 模板不自动启用相机、蓝牙、网络或其他原生能力。按需使用 `--hardware`、`--bluetooth`、`--dio` 等显式选项；业务状态、路由和组件组合继续放在 JS。

## Game 模板

来源文件是 [`templates/game/app.tsx`](../templates/game/app.tsx)。它是一个可直接运行的 3×3 目标格子游戏：30 秒倒计时、命中计分、目标自动移动，以及 开始、暂停/继续、重新开始 控件。

Game 的状态（`phase`、`score`、`seconds`、`target`）全部由 JS 保存。计时使用 pinned PocketJS 的 `onFrame`、`simulationHz()` 和虚拟帧，不使用浏览器 `setInterval`、Dart 状态或持续后台轮询。按钮输入走现有 `ActionButton`；目标移动和倒计时只在 `playing` 阶段运行，暂停时不会偷偷消耗时间。

这个模板的能力边界是当前 SDK 已验收的 Solid/UI 帧模型。它不声明或伪造 3D Scene、Rapier 物理、BLE 手柄、Canvas DrawList、共享 Float32Array、VRAM 或资源流能力。需要这些能力时，应先实现并验收对应的公共 transport/API，再扩展模板。

## 构建和 Preview

两个模板走完全相同的真实构建流程：

```sh
cd /absolute/path/to/my-app
bun /Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts build . \
  --sdk-root /Volumes/ORICO/Development/Github/pocket/sdk
bun /Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts editor . \
  --port=8791
```

打开 Studio 后选择项目，点击 **构建**，再打开 Preview。App 模板应能点击标题栏的主题按钮并观察画面颜色变化；Game 模板应能点击目标格子、暂停/恢复和重启，并观察分数、目标位置及倒计时的实际 frame 变化。Preview 运行的是生成的 QuickJS bytecode/PAK，不是 source-eval 或静态成功页面。

也可以用 `bun editor/server.ts` 启动 Studio 工作区，通过新建对话框创建项目。两种入口使用同一份模板源码；修改 `app.tsx` 后都必须重新 Build，旧 Preview 不代表未构建的源码。

## Source-first 记录与消融

实现前检查了保留父工程 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`，明确排除 `pocket_host/`：

- `mini_apps/app_game_detail/main.js` 提供了旧游戏的 VSync 更新场景；其 `Scene`、3D、Rapier、共享 Float32Array 和 BLE 手柄 API 不在当前 SDK public contract 中，不能直接复制进模板。
- `mini_apps/app_canvas_lab/main.js` 展示旧 DrawList/粒子场景，但旧页面中的随机粒子和性能文案不能作为当前能力或性能验收。
- `pocketjs_super_app_demo.html` 的 `stepMasterTicker()`、输入按钮和倒计时/粒子演示用于确认交互需求；它是历史展示页，不是当前 PocketJS runtime 的模板来源。
- 当前确定性时钟契约见 [`DETERMINISTIC_FRAMES.md`](DETERMINISTIC_FRAMES.md)：业务计时使用虚拟时钟和 frame hook，不能把墙钟 timer 当作逻辑状态来源。

必要适配是把旧游戏的“固定帧更新 + 输入后改变状态”缩成当前可运行的 3×3 JS 游戏，并使用官方 `onFrame({ continuous })`。消融掉了旧 starter 独立目录、旧 Demo/宿主业务状态、3D/物理模拟、第二套游戏循环和 Dart orchestration；两个模板共用一条配置、编译和 Preview 管线。

## 验收记录

模板文件、resolver、CLI 和 Studio 的 template 选择应先通过项目模板回归：

```sh
cd /Volumes/ORICO/Development/Github/pocket/sdk
bun test scripts/tests/project_templates.test.ts
bun test editor/test/project_templates.test.ts
bun test scripts/tests/export_web_sdk.test.ts
python3 scripts/check_architecture.py
bun editor/test/project_templates_live_probe.ts
```

2026-11-06 已执行：23 项回归通过，包含模板选择、拒绝非法值、现有配置保留、外部项目与新项目同时列出、Editor 构建、导出和硬件脚手架；架构检查通过。两个中文模板均完成 `init → pinned buildGuest → QuickJS bytecode/PAK → native Preview → pointer input` 验收：App 明暗切换往返成功；Game 点击命中计分、暂停 1.2 秒时倒计时保持、继续后推进、重开归零、30 秒结束后再次重开均通过。

`project_templates_live_probe.ts` 会创建临时工程、按顺序构建并在结束时清理 Preview 与临时文件。它只验收 JS 和 native Preview，不执行 Flutter 平台打包或手机实机验收。

Studio 浏览器交互也已执行：从左上角 **新建项目** 分别创建 App/Game，展开项目列表切回 App，选择后列表关闭。桌面和 390px 窄屏检查通过，无横向溢出或浏览器脚本错误。验收浏览器与临时服务已关闭。
