# Flutter 游戏输入接入

本次补的是官方 PocketJS 输入协议的 Flutter 宿主入口，不把触摸或键盘冒充成物理手柄。

使用高层 SDK 时，通过宿主配置显式启用：

```dart
const config = PocketAppConfig(
  appId: 'my.game',
  keyboardInputEnabled: true,
  keyboardAutofocus: false,
);
```

`PocketGuestSession` 将配置传给同一个 `PocketView`；Session 仅在显式开启时授予 `input.buttons`。默认触摸和动态 viewport 已有实际通道，现已对齐其准入清单。左右模拟轴仍不能由键盘开关自动获得。原生 policy 合并和 config copy 保留这两个选项；远程包不能自行开启宿主输入策略。

Showcase 在自己的宿主组合入口为已打包的 `dev.pocket-nexus.*` 官方 demo 显式开启键盘，点击其画布后可直接使用上述按键；这项 Demo policy 没有放进公共 SDK 的默认能力。

## 已接入

`PocketViewController` 现在提供两个受校验的宿主入口：

```dart
controller.sendButtons(
  buttons: 0x4000, // PocketJS BTN.CROSS
  analog: (128 << 8) | 128,
  rightAnalog: (128 << 8) | 128,
);

controller.sendAxes(<int, double>{
  0: 128, // LEFT_X
  1: 128, // LEFT_Y
  2: 128, // RIGHT_X
  3: 128, // RIGHT_Y
});
```

`sendButtons` 发送官方 `input.buttons` 位掩码；`analog` 和 `rightAnalog` 使用固定上游的两个 8-bit 轴打包格式（0..0xffff），中心值是 128。`sendAxes` 使用官方 `input.axes` 的 0..255 轴值，超出范围的值会被限制到协议范围，非法轴号或非有限值会被拒绝。native runtime 会在下一帧采样并保留按住的按钮；轴样本是输入边界的当前值，不在 Dart 侧复制一套 JS 状态机。

`sendButtons` 表示外部 provider 的当前完整位图，不是追加单个按键。启用键盘后，PocketView 在 host 侧把外部位图和键盘当前按住的位图做 OR，再发布一个 `input.buttons` 样本。因此外部 provider 清零时不会清掉仍由键盘按住的位；键盘释放时也不会清掉外部 provider 的位。View 销毁或 runtime detach 会丢弃两个 host source，避免下一代 Guest 继承旧设备状态。模拟轴仍完全由外部 provider 通过 `sendButtons`/`sendAxes` 提供，不与键盘状态合并。

## 键盘映射（显式开启）

`PocketView` 默认不抢宿主焦点。桌面 Showcase 或游戏页面可以显式开启：

```dart
PocketView(
  keyboardInputEnabled: true,
  keyboardAutofocus: false, // 点击画布时获得焦点；需要启动即接收键盘时再设 true
  controller: controller,
  // 可覆盖默认绑定，值为官方 BTN 位：
  keyboardButtonMap: <LogicalKeyboardKey, int>{
    LogicalKeyboardKey.keyF: 0x4000,
  },
)
```

默认绑定包括方向键/WASD、Space/Z（CROSS）、X/Escape（CIRCLE）、J（SQUARE）、K（TRIANGLE）、Q/E（L/R trigger）、Enter（START）和 Tab（SELECT）。点击游戏画布会获得键盘焦点；`keyboardAutofocus` 默认关闭，避免启动时抢宿主焦点。KeyDown/KeyUp 只在位掩码变化时发布，KeyRepeat 不重复制造 pressed edge；焦点丢失、`inputEnabled=false`、生命周期暂停和销毁都会发送一次清零样本，避免按钮卡住。正在使用 PocketJS 的系统 IME 文本框时，键盘事件交给文本编辑器，不会同时变成游戏按钮。

方向键与 WASD 等别名按“仍被按住的物理逻辑键集合”聚合：同时按住 ArrowRight 和 D 时，释放其中一个仍保持 RIGHT，直到两个都释放。运行期间更换 `keyboardButtonMap` 也会按当前按键集合重新计算，不会残留旧位。隐藏/非 active 的 View 不接收新键盘事件，恢复时必须重新按键。

键盘入口只代表真实 Flutter 键盘事实。要接入物理手柄，应用需要从对应平台插件获得按钮/轴状态，再调用上述 controller API；本次没有伪造 `Gamepad` provider，也没有在 target profile 中宣称 `input.buttons` 或 `input.analog.*` 已默认可用。I2C/UART、陀螺仪和相对轴仍需各自的真实硬件 provider。

`input.buttons` 是官方逐 GuestFrame 采样协议，不是 Dart 侧的按下/释放事件队列。一个 vblank 前发生的快速 KeyDown/KeyUp 可能只以最终快照进入同一 GuestFrame；需要可靠边沿时，应用应保持按键跨过至少一个 GuestFrame，不能依赖宿主补造边沿队列。

## 来源与消融

固定上游契约来自 `sdk/.cache/pocketjs/contracts/spec/input.ts` 和 `contracts/spec/spec.ts` 的 `BTN`/`ABSOLUTE_AXES`。native 既有 `queue_buttons`、`queue_axes` 与 `GuestFrame` 编码路径被直接复用；Flutter 只新增 Focus/Keyboard 事件到同一个 `input.buttons` 通道，不新增 Dart 游戏状态、ticker 或布局层。

保留父工程（排除 `pocket_host/`）中的输入参考只用于确认边界：其 `native/pocket_runtime_multi.c` 也有同名按钮/轴 JSON 解析，但父工程没有可直接复用的真实 Flutter 游戏手柄 provider。旧 `View.Keyboard` 是文本 IME 组件，不是游戏按钮输入，因此没有迁回。

## 验证

```sh
cd sdk
flutter test --no-pub packages/pocket_flutter/test/pocket_view_input_test.dart
flutter analyze --no-pub packages/pocket_flutter
```

回归覆盖：键盘方向键的按下/释放变为 `0x0020 → 0`，键盘与外部位图合并及各自释放，controller 轴值验证和边界限制，runtime detach 清理，既有 pointer/IME/焦点/销毁场景。它证明 Flutter→runtime 消息和协议边界，不代表真机手柄、蓝牙手柄、浏览器 Gamepad API 或物理设备 FPS 已验收。

补充回归包括：方向键与 WASD 别名共同按住、映射切换、重复键事件、点击画布获取焦点、inactive 清零及 IME 隔离；native QuickJS 测试验证按钮 `0 → 0x4000 → 0` 和轴变化到达真实 GuestFrame。该 native 用例使用测试 source fixture，并非编译 QJBC 的证明。

## 独立 Web 的游戏输入

`PocketWebRuntime` 显式传入 `gameInput: true`（或宿主 config 的同名开关）后，画布可获得键盘焦点，并采集标准映射的 `navigator.getGamepads()` 设备事实。按键映射与上面的 Flutter 默认映射一致；标准手柄 face/d-pad/肩键与双摇杆直接投影到官方按钮位及 packed axes。摇杆死区默认为 0.15，不为未知映射的设备猜测轴含义。

Web 采样仅在画布获得焦点、页面 active 且存在标准手柄时逐帧读取设备；只有状态变化才通过现有 `inputFrame` 唤醒 Guest。不增加第二个游戏 ticker；hide/blur/disconnect/dispose 清理按住状态和采样回调。桌面文本输入拥有焦点时不发送游戏按键。

来源为固定上游 `contracts/spec/spec.ts` 的 BTN/packed analog 和既有 `WechatHost.advance`/`web_advance` ABI；保留父工程的 `web_wasm_preview/index.html` 没有可直接复用的标准 Gamepad provider。新增 `targets/web/game_input.js` 只填补浏览器设备事实入口。

`scripts/tests/web_game_input.test.ts` 覆盖别名、重复边沿、focus、composing/系统快捷键、双摇杆/死区、断连和释放。`scripts/tests/web_game_input_guest.test.ts` 实际编译 UI QJBC/PAK，加载固定 WASM，并把键盘/标准手柄样本送进官方 frame；观测文字 `0:32896 → 1:32896 → 2:65280 → 2:32896` 及真实软件渲染像素哈希变化。设备样本由测试注入，不能代替物理 USB/蓝牙手柄兼容验收。

## Visual Novel 键盘适配

Lantern 复用上游 `@pocketjs/framework` 的同一焦点树：
`sdk/.cache/pocketjs/framework/src/input.ts` 将方向键映射到焦点遍历，并由 `BTN.CIRCLE` 激活当前 `Focusable`；`FocusScope` 提供自动聚焦、子树输入隔离和恢复焦点。保留父工程的 `mini_apps/app_ui_showcase/main.js`、`mini_apps/app_nav/main.js` 已用 `FocusScope`、`FocusGrid`、`Focusable` 构造键盘/手柄导航，父工程 `docs/03_DUAL_HOST_UI_COMPONENTS_SPEC.md` 记录其原生 Flutter 焦点域适配。旧 `View.Keyboard` 是文字输入组件，因此不迁作剧情控制器，也没有另建 JS 按键状态机。

VN 在标题和手札 modal 使用现有全屏 `FocusScope`；剧情对白和选项使用现有 `Focusable`，对话/首个选项在节点注册时通过官方 `focusNode` 获得焦点。没有为每句对白或每组选择再建局部 scope，以保留舞台顶栏和底栏的 pointer hit testing。关闭剧情手札后明确恢复到当前对白或首个选项，标题 Escape 无处理器所以不会越过标题；Escape 也不会改变对白或选择。Space/Enter 通过焦点确认启动标题操作、显全/继续对白、选择当前高亮选项或触发菜单项。宿主配置 `keyboardButtonMap` 仅覆盖 Lantern 的 Space、Enter、numpad Enter 为 `BTN.CIRCLE`，Escape 为 `BTN.CROSS`，方向键和其他应用的默认映射不变。

适配源：

- 父工程 `mini_apps/app_ui_showcase/main.js`：FocusScope 内 FocusGrid 与 Focusable 操作项；保留焦点遍历/确认模型。
- 父工程 `mini_apps/app_nav/main.js`：子应用焦点域中的动作网格；保留子树导航边界。
- 父工程 `docs/03_DUAL_HOST_UI_COMPONENTS_SPEC.md`：FocusScope 与 Flutter `FocusTraversalGroup` 对应关系；当前 Pocket 通过 `PocketView` 的 `input.buttons` 和 PocketJS 焦点树接入，不迁回该旧 Flutter UI。
- 固定上游 `sdk/.cache/pocketjs/framework/src/input.ts`、`components.ts`、`input-api.ts`：方向、Circle 确认、`Focusable`/`FocusScope` 的运行契约。

Pocket `PocketAppConfig.keyboardButtonMap` 将 per-app 覆盖透明传给既有 `PocketView.keyboardButtonMap`，其自定义键只优先于相同键的默认项。Lantern Host policy 使用 Space/Enter/numpad Enter → `0x2000`（`BTN.CIRCLE`），Escape → `0x4000`（`BTN.CROSS`）。`demo/js/tests/novel_keyboard_native.test.ts` 在真实 native `pocket_probe` 加载 Lantern QJBC/PAK，以 `input.buttons` GuestFrame 样本验收标题/对白确认、Escape 手札、选择焦点与分支，以及 Escape 不跳过标题和选择；这验证 Guest 协议，不代替 Flutter 物理键设备兼容性测试。

焦点适配时确认了一个真实的结构更新故障：`FocusTarget` 若在 `onCleanup` 中再次读取 `props.onNode`，choice 项的动态 JSX getter 会访问已卸载的 `Show` value accessor。引擎的 listener 边界会捕获这个清理异常，使 story snapshot 已切换到新对白，但 retained UI 和自动记录仍停在旧选择。现在 `FocusTarget` 在节点注册时捕获 `onNode` 与 `autoFocus`，清理只调用捕获的 callback；没有增加焦点状态机或绕过 `Focusable`。

真实原生回归使用最终 Lantern QJBC/PAK 和固定 `sdk/.pocket-build/current-native-tools/bin/pocket_probe` 顺序运行：

- `bun test tests/novel_keyboard_native.test.ts`：通过。GuestFrame 按键从标题进入剧情、显全/继续对白、Escape 打开/关闭手札、方向键移动选择并以 Circle 确认第二项。
- `bun test tests/novel_native.test.ts`：通过。真实 pointer 操作覆盖保存/加载、回溯、选择分支、多个结局与限时路径。
- `bun test tests/novel_viewport_native.test.ts`：通过，24 项断言覆盖手机和桌面视口，以及指针目标。
- `bun test tests/spine_native.test.ts`：通过，4 项断言确认 Spine 动画与菜单暂停。
- Flutter 3.47.9 `flutter test --no-pub test/pocket_config_test.dart` 与 `flutter test --no-pub packages/pocket_flutter/test/pocket_view_input_test.dart`：均通过；覆盖宿主键位策略透传、映射覆盖、真实按键边沿、别名、外部输入合并、焦点与 IME 隔离。
