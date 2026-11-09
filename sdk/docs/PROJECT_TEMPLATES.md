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
- **Game**：图形化游戏场景、frame loop、input 和 game state。

Studio 将选择通过 `POST /api/projects` 的 `template` 字段提交，并将它保存到 `editor.json`。已有项目不会因为打开 Studio 而自动换模板。CLI 会另外生成 `vendor/pocket-ui/` 和 `flutter/`；Studio 工作区创建的是 JS 工程，直接使用 SDK 的公共 UI 包与 Preview。

## App/Game 的开发顺序

两个模板都按同一个功能优先顺序开发：先用 TCA（State、Action、Reducer、Effect）风格把 App 或 Game 的完整功能做完，再加测试用例，最后做 UI。这里的 TCA 是 JS/TS 的状态组织方法，不要求引入当前 SDK 没有的第三方 TCA 包。

1. **功能先行**：在 UI 之前完成完整的业务或游戏状态机。App 先跑通页面流程、提交、错误和返回；Game 先跑通开始、进行中、暂停、恢复、重启、结束和计时等状态。
2. **测试随后**：为 State/Action/Reducer/Effect 补主路径、边界、错误和异步测试；Game 还要覆盖暂停/恢复、重开和倒计时结束。测试必须验证状态转移和效果，不以静态 UI 文件存在作为通过条件。
3. **UI 最后**：将已验证的状态和动作绑定到 `@pocket/ui`、`View`、`Focusable` 等组件。UI 只负责呈现与派发动作，不新增一套业务状态或计时循环。

这条顺序适用于从模板生成的项目以及后续扩展；需要改动交互时，先修正并测试状态逻辑，再调整视觉层。

## 网络与游戏的业务 Worker（AI 开发规则）

- 首次加入官方 `net.http` 网络功能时，AI 自动补齐 `worker.ts`、`pocket.json` 的 `domains.worker`、HTTP node/channels，以及 `runtime.worker` / `net.http` 声明。请求、流式接收和解析走官方 Worker IO，UI 通过 channel 接收进度和结果。
- 宿主读取构建后的 Worker descriptor 后自动装载业务 Worker；官方 Worker HTTP 还需可信宿主配置精确的 `workerHttpOrigins`。不要生成通配授权、启动即联网或 UI frame loop 内请求。
- 游戏寻路、AI 决策、地图生成和批量重计算按需要放入业务 Worker；UI、输入、动画、计分及生命周期仍复用现有 JS 状态和 `onFrame`。简单小游戏不创建空转 Worker，不逐帧复制完整世界状态。
- `renderWorker` 是独立的 Web 渲染开关，默认 `false`；网络和游戏功能不能顺带打开它。是否开启应依据目标游戏的实测。
- 当前初始模板不自带 `worker.ts`。以上“自动”指 AI 开发功能时负责补齐并验证接入；构建器不会扫描并改写现有 `fetch` 或 `dio.request`。`--dio` 选择的原生 Dio 插件会自动使用独立 IO Worker isolate，保持 `dio.request` 接口；它不是 `domains.worker` 或渲染 Worker 开关。Dio 继续使用 `network` 权限及插件 `allowedOrigins`，纯 Dio 功能无需额外创建 JS Worker。
- 采用同一 pinned QJBC/descriptor 管线，不新增另一个 JS runtime。验证真实请求/计算、channel 返回值、错误、取消和隐藏/恢复，不能以文件存在代替可用性验证。独立 Worker 执行域不等于所有宿主都使用独立 OS 线程，也不保证 FPS 提升。

### 配置与自动启动的范围

按固定上游 `apps/worker-http/{pocket.json,worker.ts,main.tsx}` 复用契约：`domains.worker.entry` 指向 Worker 源码；`nodes` 声明 `{ "name": "http", "kind": "http" }`；`channels` 显式声明方向、recordBytes 与 capacity。UI 使用 `@pocketjs/framework/worker/channels` 的 `worker.channel()`，Worker 使用 `@pocketjs/framework/io` 的 `io.channel()` / `io.http()`，通过 `@pocketjs/framework/worker` 的 `settle()` 等待完成。不要自造 `fetch` fallback 或消息协议。

AI 需要同时更新 `pocket.json` 的 engine capability、Guest manifest 及 Worker 源码。`buildGuest` 会编译 Worker QJBC 并生成 admission descriptor；现有宿主随后自动装载/attach Worker，不需要用户另找“启用线程”按钮。这个自动启动只对已经正确声明并打包的业务 Worker 成立。

Worker HTTP 不依赖 Dio。Flutter 的可信宿主通过 `PocketAppConfig.workerHttpOrigins` 授权；独立 Web 构建可用 `--worker-http-origin=https://api.example.com`，运行时读取相应配置。Studio 默认新项目及 CLI 生成的 Flutter 宿主不会自动授权业务服务地址；AI 接入网络时必须完成相应宿主配置，不能虚构创建表单已有 origin 开关。具体 API、生命周期和平台限制见 [Web Worker](WEB_WORKER_IMPLEMENTATION.md) 与 [Worker IO](WORKER_IO_IMPLEMENTATION.md)。

App 和 Game 的模板介绍会随 Studio 复制为项目 `README.md`；CLI 也生成同一规则的新项目 README。已有项目不会被创建流程追溯改写，硬件能力仍按需声明和接入。

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

来源文件是 [`templates/game/app.tsx`](../templates/game/app.tsx)。它是一个可直接运行的图形化“星尘捕手”小游戏：深色星空场景、漂移星核、顶部 HUD、30 秒倒计时和命中计分。星核的可点击区域固定为 80 像素，等待点击时只做小幅漂移，命中后才换位置并显示粒子爆发和 `+1` 反馈；开始、暂停/继续、重新开始和结束后的再来一局都在游戏场景内完成。画面和交互由 JS 组合，避免把游戏退化成 App 模板式的说明卡片和表单页。

Game 的状态（`phase`、`score`、`remaining`、`target`、动画进度和命中反馈）全部由 JS 保存；`remaining` 是唯一的时间信号，显示值直接由它计算，不再维护冗余的 `seconds` 状态。计时使用 pinned PocketJS 的 `onFrame`、`simulationHz()` 和虚拟帧，不使用浏览器 `setInterval`、Dart 状态或持续后台轮询。输入使用官方 `Focusable`；顶部 HUD 的暂停入口和场景内的开始、继续、重新开始入口共享同一套 phase 状态，目标移动、倒计时和粒子反馈只在 `playing` 阶段运行，暂停时不会偷偷消耗时间。

这个模板的能力边界是当前 SDK 已验收的 Solid/UI 帧模型：使用 `View` 组合星点、行星、轨道、星核和粒子爆发，使用 `Focusable` 处理 80 像素星核命中区和场景内操作，并以 `onFrame` 驱动漂移、倒计时和反馈动画。它不声明或伪造 3D Scene、Rapier 物理、BLE 手柄、Canvas DrawList、共享 Float32Array、VRAM 或资源流能力。需要这些能力时，应先实现并验收对应的公共 transport/API，再扩展模板。

## 构建和 Preview

两个模板走完全相同的真实构建流程：

```sh
cd /absolute/path/to/my-app
bun /Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts build . \
  --sdk-root /Volumes/ORICO/Development/Github/pocket/sdk
bun /Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts editor . \
  --port=8791
```

打开 Studio 后选择项目，点击 **构建**，再打开 Preview。App 模板应能点击标题栏的主题按钮并观察画面颜色变化；Game 模板应能点击漂移星核、观察粒子和 `+1` 反馈，使用顶部暂停和场景内继续/重开/再来一局，并观察分数、星核位置及倒计时的实际 frame 变化。Preview 运行的是生成的 QuickJS bytecode/PAK，不是 source-eval 或静态成功页面。

也可以用 `bun editor/server.ts` 启动 Studio 工作区，通过新建对话框创建项目。两种入口使用同一份模板源码；修改 `app.tsx` 后都必须重新 Build，旧 Preview 不代表未构建的源码。

## Source-first 记录与消融

实现前检查了保留父工程 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`，明确排除 `pocket_host/`：

- `mini_apps/app_game_detail/main.js` 提供了旧游戏的 VSync 更新场景；其 `Scene`、3D、Rapier、共享 Float32Array 和 BLE 手柄 API 不在当前 SDK public contract 中，不能直接复制进模板。
- `mini_apps/app_canvas_lab/main.js` 展示旧 DrawList/粒子场景，但旧页面中的随机粒子和性能文案不能作为当前能力或性能验收。
- `pocketjs_super_app_demo.html` 的 `stepMasterTicker()`、输入按钮和倒计时/粒子演示用于确认交互需求；它是历史展示页，不是当前 PocketJS runtime 的模板来源。
- 当前确定性时钟契约见 [`DETERMINISTIC_FRAMES.md`](DETERMINISTIC_FRAMES.md)：业务计时使用虚拟时钟和 frame hook，不能把墙钟 timer 当作逻辑状态来源。

必要适配是把旧游戏的“固定帧更新 + 输入后改变状态”缩成当前可运行的星空图形化 JS 游戏，并使用官方 `onFrame({ continuous })`。消融掉了旧 starter 独立目录、旧 Demo/宿主业务状态、3×3 九宫格按钮层、`ActionButton` 游戏控制层、冗余 `seconds` 时间状态、3D/物理模拟、第二套游戏循环、静态占位画面和 Dart orchestration；两个模板共用一条配置、编译和 Preview 管线。

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

2026-11-06 本轮已执行：7 项模板回归通过，覆盖模板选择、默认值、非法值拒绝、非空目录保护、现有配置保留、外部项目列表和 Editor 构建；架构检查通过。Native Preview live probe 也已通过：App `themeToggle`；Game `graphicMotion`、空白区域不计分、命中粒子/`+1`、指针计分、暂停 1.2 秒冻结倒计时、继续、重新开始、30 秒结束和再来一局均通过。另用 Playwright Chromium 检查了真实 Preview 的 ready、playing、hit 三个画面；截图确认星空场景、漂移星核、命中反馈和 HUD 均发生实际帧变化。

`project_templates_live_probe.ts` 会创建临时工程、按顺序构建并在结束时清理 Preview 与临时文件。它只验收 JS 和 native Preview，不执行 Flutter 平台打包或手机实机验收。

Studio 浏览器交互也已执行：从左上角 **新建项目** 分别创建 App/Game，展开项目列表切回 App，选择后列表关闭。桌面和 390px 窄屏检查通过，无横向溢出或浏览器脚本错误。验收浏览器与临时服务已关闭。

### 点击可用性修正（2026-11-06）

真实浏览器检查确认开始、暂停和鼠标按压能进入 JS；旧版星核每 1.2 秒自动瞬移，玩家瞄准后输入到达时可能已经点在空白处。消融自动换位计时器 `moveElapsed`，只在命中时更换目标位置，保留小幅连续漂移及 80 像素命中区。回归增加真实按压时长（120/300 ms）和等待 1.4 秒后目标仍在原命中范围内的验证；旧版在目标稳定性断言失败；修复后完整 native Preview 验收通过，包含计分、粒子、空白不计分、正常按压、暂停/恢复、重开和 30 秒结束。已同步修复当前 Studio 的 `my-pocket-game2` 工程并重新构建；系统 Chrome 中等待后使用 300 ms / 180 ms 真实鼠标按压，连续命中从 0 分增加到 2 分。
