# 原 demo 的 Flutter 输入/IME 复用核对

本记录只核对两个原项目的 Flutter 输入实现；`pocket_host` 不是参考实现来源。重点是系统 `TextField`/`EditableText` 与系统 IME，不把 PocketJS 自绘 Osk 当成系统键盘。

## 结论

两个原项目都有可用的系统 `TextField`，但成熟度和边界不同：

- `PocketJSKit` 有真正的 PocketJS → Flutter 文本输入协议：guest 发 `textInput.open/update/close`，Flutter 在 guest rect 叠加 `TextField`，再回传 `textInput.edit/submit`。它是当前 bridge 的协议和端到端验收参考。
- 旧 `pocketjs_flutter_demo` 的 `View.Keyboard` 是一个 VDOM 组件内的普通 Flutter `TextField`。它能唤起真实系统键盘并做文本双向绑定，但不是 DrawList 输入覆盖层，也没有 selection/composing、会话 id、rect 更新或 stale-event 语义。
- 当前 renderer 已继承第一项的协议和第二项的 Flutter 原生编辑器原则；当前 renderer 的稳定 key、精确 session、UTF-16 selection/composing、外部点击时序和 viewInsets 防误关逻辑是针对原 demo 缺口补上的，不能回退到原实现的简化版本。

## PocketJSKit：协议/端到端参考

| 文件与行 | 观察 | 对当前实现的结论 |
| --- | --- | --- |
| `/Volumes/ORICO/Development/TryJoy.c/TryJoyMono/App/repos/pocket_flutter_poc/PocketJSKit/packages/pocket_flutter/lib/src/pocket_view.dart:935-1128` | `_textInputRectFromParams` 解析 guest rect；`_openTextInput` 创建 controller/focus node 并 post-frame requestFocus；controller listener 发 `textInput.edit`（text、selection、composing）；submit 发 `textInput.submit` 后关闭；事件入口处理 `open/update/close`。 | 已继承为当前 bridge 的基本协议和 Flutter `TextField` overlay 模式。原实现允许缺少 event id（`:1012-1015`），当前实现应继续要求精确 session id。 |
| 同文件 `:1637-1679` | 在 DrawList scene children 尾部追加 `Positioned` + `TextField`，按 guest rect 缩放。原 `Positioned` 没有稳定 key。 | 直接复用“按 guest rect 叠加”的结构；不要复用无 key 版本。canvas block 数量变化会改变 Stack sibling，稳定的外层 overlay key 是系统键盘焦点不丢的必要修复。 |
| `/Volumes/ORICO/Development/TryJoy.c/TryJoyMono/App/repos/pocket_flutter_poc/PocketJSKit/test/pocket_view_test.dart:1318-1408` | widget test 验证 open、rect、输入编辑、selection/composing、submit、字段移除，以及编辑器点击不重新发 guest pointer。 | 可直接复用为协议回归场景；它使用 `testTextInput`，不能代替真机硬件 IME 生命周期测试。 |
| 同文件 `:1410-1487` | 验证 `textInput.update` 更新 text/selection/composing，`textInput.close` 移除字段。 | 可直接复用 update/close 断言；当前实现另需 stale session 和 dispose 断言。 |
| `/Volumes/ORICO/Development/TryJoy.c/TryJoyMono/App/repos/pocket_flutter_poc/PocketJSKit/integration_test/pocket_poc_test.dart:630-725` | 真实 FFI runtime + Solid guest：点击 DrawList 的 `Flutter input`，等待 key `pocket-text-input-flutter-ime-demo`，输入中文/emoji，设置 selection 2..10、composing 0..2，等待 guest 回显，再发送 done 并验证 submit。 | 这是最有价值的端到端测试脚本和 guest 回显设计；当前 host 的设备测试应沿用其操作顺序。原测试仍是 Flutter test binding 的 `testTextInput`，不能宣称覆盖真实候选栏/硬件键盘。 |
| `/Volumes/ORICO/Development/TryJoy.c/TryJoyMono/App/repos/pocket_flutter_poc/PocketJSKit/apps/solid-tests/app.tsx:523-588` | guest 对 `textInput.edit/submit/close` 做 id 过滤；`open` payload 为 `{id,text,rect}`；edit 读取 selection/composing，submit 记录最终 text。 | 可直接复用协议最小 guest fixture；特别是 id 过滤和 selection/composing 回显。 |
| `/Volumes/ORICO/Development/TryJoy.c/TryJoyMono/App/repos/pocket_flutter_poc/PocketJSKit/SUPPORT.md:18-20,26` | 明确推荐 Flutter 标准 `TextField`/`EditableText` 作为独立系统 IME overlay，按 PocketJS layout rect 定位；Osk 是另一种官方自绘组件；真实硬件/中文候选/无障碍仍需独立验证。 | 架构边界与当前实现一致；不能把 Osk 的通过等同于系统 IME 已覆盖。 |

### PocketJSKit package example 的价值

`packages/pocket_flutter/example/lib/main.dart:141-155` 只挂载 `PocketView`、`device_control.js` 和 PAK；`packages/pocket_flutter/example/test/widget_test.dart:5-17` 只验证宿主挂载文案，没有 input/IME 测试。实际输入参考在上面的 `apps/solid-tests` fixture、package test 和 `integration_test/pocket_poc_test.dart`，不是 package example 本身。

## 旧 pocketjs_flutter_demo：简单系统输入组件参考

| 文件与行 | 观察 | 对当前实现的结论 |
| --- | --- | --- |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart:2523-2532` | `View.Keyboard` 映射到 `_PocketFlutterNativeKeyboardInput`。 | 证明旧 demo 的此组件确实使用 Flutter 原生输入，而不是仅绘制 JS 按键。 |
| 同文件 `:3507-3682` | `TextEditingController` + `FocusNode`；监听 `node.propListenable`；`currentInput` 变化时把 selection 放到末尾；`onChanged` 写回 `node.props['currentInput']` 并 dispatch `textInputChanged`；按钮调用 `SystemChannels.textInput` 的 `show/hide`；dispose 移除监听并释放 controller/focus。 | 可直接借鉴普通 Flutter 输入组件的 controller/focus/dispose 和显式 show/hide 细节。不能直接搬到 DrawList overlay：没有 guest rect、`textInput.open/update/close`、selection/composing 往返、session/stale 保护、outside tap/drag 时序或 viewport/inset 处理。 |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_flutter_ui.js:827-829` | `ui.keyboard({currentInput})` 生成 `View.Keyboard` VDOM。 | 仅是旧 VDOM API，不是当前 DrawList text-input contract。 |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_pages.js:724-768` | Showcase 的 “Flutter TextField 软键盘” 页面把 `ui.keyboard({currentInput:'$typedText'})` 放入卡片；页面文案和 `$typedText` 绑定展示系统输入用例。 | 可作为产品级手工演示入口；它把输入组件固定在 VDOM 布局中，不能证明 guest rect 动态 overlay 已解决。 |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/app_login/main.js:35-43`；`mini_apps/app_ui_showcase/main.js:29` | 两个 mini-app 使用 `ui.Keyboard`，但依赖 VDOM 组件自己的 `buffer`/state。 | 适合验证旧组件文本回显和业务绑定，不是可直接移植的 IME bridge fixture。 |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart:1001-1015,1749-1775` | host 在 retained VDOM 中原地同步 `View.Keyboard.currentInput`；收到 `textInputChanged`/`keyboardSetText` 后更新 `typedText`、节点文本和树。 | 可借鉴“状态由 guest/runner 持有、Flutter 只编辑”的原则；当前 bridge 已将该原则落实为带 id 的 `textInput.edit`，无需增加第二套 `typedText` 通道。 |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/ffi_bridge.dart:550-577,625-649` | `View.Keyboard` 只是组件 tag 注册与 VDOM 映射。 | 没有额外原生 IME ABI 可复用。 |
| `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/test/pocket_38_components_screenshot_test.dart:82-177` | 主要是截图、导航、权限和插件流程；没有 `TextEditingValue`、IME action、selection/composing 或 viewInsets 生命周期断言。 | 不能作为系统键盘回归测试；只可作为 showcase 视觉覆盖参考。 |

## 当前 renderer 的继承边界

### 已继承

- Flutter `TextField`/`EditableText` 作为系统 IME client，而不是在 Dart 重做键盘页面。
- guest rect 定位、controller + FocusNode、post-frame focus、`textInput.edit`、`textInput.submit`、`textInput.close`，以及 guest 的文本/selection/composing 回显。
- PocketJSKit 的 `textInput.open/update/close` 与 `textInput.edit/submit` 命名和最小 payload 形状。
- PocketJSKit 的测试场景：中文/emoji、selection/composing、submit 后 overlay 消失、编辑器触摸不重发 guest pointer。

### 有意没有继承、或已加强

- 不接受缺失 id 的 update/close；旧 PocketJSKit 的宽松匹配会让旧会话覆盖新会话。
- 外层 `Positioned` 有稳定 key；只给内层 `TextField` key 不足以阻止 canvas block 变化重建 `EditableText`。
- 不因短暂 `viewInsets == 0` 自动关闭；焦点、显式 guest close、submit、outside tap、runtime dispose 才是关闭来源。
- outside pointer 在完整 down/up 后、下个 post-frame 才 dismiss；拖动不关闭，避免键盘收起改变 viewport 后 pointer-up 无法命中导航目标。
- UTF-16 code-unit offset、composing 无效范围、keyboard type/action、多行/密码等 metadata 由当前 bridge 单独处理；旧 demo 两者都没有完整语义。

### 可直接复用清单

1. 以 `PocketJSKit/apps/solid-tests/app.tsx:523-588` 为最小 guest fixture：open 发送 `{id,text,rect}`，edit/submit/close 按 id 回显状态。
2. 以 `PocketJSKit/test/pocket_view_test.dart:1318-1487` 为协议 widget test 的操作顺序和断言集合。
3. 以 `PocketJSKit/integration_test/pocket_poc_test.dart:630-725` 为真实 runtime 的端到端场景；设备测试另加真实 viewInsets、焦点稳定和导航点击。
4. 只有在实现独立 VDOM `View.Keyboard` 时，才复用旧 demo `pocket_ui_components.dart:3526-3567,3584-3626` 的 controller/focus/dispose/show-hide 代码；不要把它当成 DrawList overlay 的替代实现。

## 未发现的能力

在两个原项目中都没有一套同时覆盖真实硬件键盘候选栏、后台/前台、导航期间 focus 保持、动态 DrawList sibling 变化、stale session 和 selection/composing 的真机系统 IME 测试。原有 simulator/widget tests 只能证明协议与 Flutter test text-input 通道；真实设备验证仍属于当前 host 的独立验收项。

## 键盘动画的视口适配

用户录屏 `Screen Recording iPhone Duo 02-11-2026 at 12.17.35.mp4` 显示键盘出现时整页暂时缩小并居中，随后恢复满宽。逐帧定位为新宿主约束与旧 native frame 之间的 contain 缩放；不是 JS scroller 的反向弹跳。连续 native resize 探针中的输入框 visual rect 单调上移。

对照来源为 Kit `lib/main.dart:32-51`、`packages/pocket_flutter/lib/src/pocket_view.dart:1390-1521`，以及旧 demo `lib/render/pocket_ui_components.dart:3851-3859`、`lib/ui/mini_app_host_page.dart:69-83` 的宿主布局。复用原有 native viewport resize 和 JS 滚动，只修正框架的过渡绘制：自有 runtime 的自动视口保持旧 frame 的 1:1 尺寸，通过显式宽高的 OverflowBox 顶左裁切，直到新 frame 到达。显式 viewport、注入 runtime 和不支持 resize 的旧库继续使用固定预览 fit。

没有增加第二个滚动动画、reveal 事务或重复的布局状态。设备回归在键盘展开/关闭的每个 Flutter frame 检查主画布比例与锚点，结果记录在 VALIDATION.md。

## 14.44.40 录屏：输入外观与导航横跳

本次继续复用上述 Kit 的原生编辑器协议，没有增加输入组件或第二套键盘。录屏暴露出原实现遗漏的两个边界：

- Flutter overlay 继承了 Kit 的固定深色装饰，与 JS 的白色输入 shell 不一致。现在 `InputField` 由 JS 同时声明 shell 和 `textInput.open/update` 的颜色、字号、圆角、边框与内边距，Flutter 按参数显示真实编辑器。仅样式更新保留 controller、选区和 composing。
- `native/src/lib.rs` 的 `resize_viewport` 先发只含 `width/height` 的 `display.viewport`；旧 `parseDisplayGeometry` 会清空缺省安全区与保留区域。键盘高度变化期间因此出现右 rail → 左 rail → 右 rail。现在缺省字段保留已有快照，同宽高度变化保留区域，宽度变化丢弃旧区域坐标，显式全零/空数组仍能清除；左右 inset 相等时统一使用默认右 rail。

消融直接比较旧 `>=` 与新 `>` 在中性几何样本上的左右 rail 判定，并加入左右 division 的连续 height-only resize、显式清除断言。没有添加定时器、方向锁、另一套导航偏好或键盘动画。实际设备验收增加每帧 JS 锚点横坐标和宽度检查；此前仅检查画布比例与焦点的测试不足以捕获 JS 布局换边。
