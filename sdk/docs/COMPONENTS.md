# 组件契约与验收边界

旧 demo 的“38 组件”不是 PocketJS 原生协议：20 个名称能对应上游 API，另 18 个属于业务组件。新工程不保留旧 C 枚举、`PocketUiNode` 或 Dart 组件 switch。

## 固定上游契约

本地可复核入口：

- `.cache/pocketjs/contracts/spec/spec.ts`：NODE_TYPE 与 DrawList v1。
- `.cache/pocketjs/framework/src/primitives.ts`：基础组件。
- `.cache/pocketjs/framework/src/components.ts`：JS 组合、焦点、Portal 等。
- `.cache/pocketjs/framework/src/native-tree.ts`：仅接受 `view/text/image/surface` host tag。

原生节点只有 **4 类**：`view`、`text`、`image`、`surface`。

DrawList v1 有 **10 类**：`RECT`、`GRAD_RECT`、`GLYPH_RUN`、`TEX_QUAD`、`SCISSOR`、`SCISSOR_POP`、`TRI`、`TEX_TRI`、`TEXT_RUN`、`SURFACE_QUAD`。

Flutter 绘制的是 native 投影的操作与资源；并非每个 JS 组件都需要一个 Flutter Widget。颜色按上游 ABGR 解释并转换，不能沿用旧 demo 的 ARGB 假设。

## 上游 20 项

| 旧名称 | 本工程对应 API / 位置 | 验证范围 |
| --- | --- | --- |
| View | `View` → view | 编译、真实 native、Flutter 显示与交互通过 |
| Text | `Text` → TEXT_RUN | 同上；不代表 GLYPH_RUN 已支持 |
| Image | `Image` → image | 示例 About 使用 SVG PAK；编译通过，未专项视觉验收 |
| Sprite | `Sprite` → image + sprite metadata | 上游提供，示例未挂载 |
| Surface | 正式名称 `CompositorSurface` → native `SURFACE_QUAD` | 不是旧别名；当前 retained host-surface bridge 只允许 `glass` 与 `platformTexture`，视频是后者的 Texture provider，不宣称任意 compositor |
| Screen | JS View 组合 | 当前示例使用，真实链通过 |
| Focusable | JS 焦点/按压包装 | guest 按钮使用同等 view + focusable 契约，真实点击通过 |
| FocusScope | JS 焦点作用域 | 计数与往返导航通过；不得将导航排除在活动 scope 外 |
| FocusGrid | JS 方向键遍历 | 经 Grid 组合；方向键未专项验收 |
| ActionHandler | JS 输入 marker | 上游提供，示例未专项验证 |
| Portal | JS overlay | 通过 Modal 引用；未专项验收所有 overlay 情形 |
| Modal | JS Portal + focus scope | 示例源码存在；点击打开/关闭未列入当前回归门禁 |
| ActionBar | JS Portal 底栏 | 示例移除：它遮挡全局导航，构成重复底栏 |
| AuxiliarySurface | JS 辅助输出 | renderer 有路径；未专项验收 |
| AuxiliaryPortal | JS 辅助 overlay | 未专项验收 |
| Named | JS DevTools 名称 | 示例使用，不新增原生节点 |
| Grid | JS View/FocusGrid 组合 | 示例使用；编译与页面切换通过 |
| Lazy | JS 挂载生命周期 | static probe 验证 JS 状态触发挂载 |
| Gallery | JS 页面组合 | 上游提供；示例的 Gallery 路由名称不代表使用了这个组件 |
| DeepZoom | JS Image/UV/TILESET 组合 | 上游提供，示例未挂载 |

## 业务 18 项

这些不是固定上游导出，不能继续宣称为“底层组件”。基础业务组合实际实现位于
`guest/ui/index.tsx`，mobile 组合位于 `guest/ui/mobile.tsx`；`guest/components.tsx`
仅保留兼容 re-export。

| 旧名称 | 新工程处理 |
| --- | --- |
| View.Header | JS `Header` |
| View.PageIntro | JS `PageIntro` |
| View.SectionHeading | JS `SectionHeading` |
| View.ActionButton | JS `ActionButton`；真实按压测试通过 |
| View.Badge | JS `Badge` |
| View.EmptyState | JS `EmptyState` |
| View.MetricCard | JS `MetricCard`；显示实际 guest 状态，移除假“已挂载8项”指标 |
| View.StatusBar | JS `StatusBar` |
| View.NavigationBar | JS `NavigationBar`；往返页面且状态保留通过 |
| View.ScrollButton | 不保留无独立语义的别名；按需使用 ActionButton |
| View.ScrollRail | 未实现真正滚动语义，删除原先仅按钮行的占位包装 |
| View.Keyboard | 已移除 JS Keyboard/自绘 OSK 包装；JS `InputField` 直接通过 PocketView 挂载 Flutter `TextField`/`EditableText` 和 system-IME bridge，文本与路由仍由 JS 持有；不等同于上游 `GuestFrame.text` 已完整接通 |
| View.Sparkline | 不声称折线语义；示例改名 `MiniBarChart` |
| View.Text | JS `ViewText`（标题和说明组合） |
| View.Card | JS `Card` |
| View.Row | JS `Row` |
| View.WrapLines | 删除仅包一层 Text 的占位包装；需要时使用上游 wrapText 契约实现 |
| View.WrapTextPage | 尚未实现分页语义，不保留空壳 |

## JS mobile 组合与转场

本轮的 mobile UI 仍是 JS/TSX 组合，不是 Flutter 业务 Widget 树。`guest/ui/mobile.tsx`
导出 `MobileThemeProvider`、`MobileScaffold`、`MobileAppBar`、`MobileCard`、
`MobileButton`/filled/outlined/text aliases、`MobileBadge`、`MobileListTile`、
`MobileSegmentedControl`、`MobileSwitch`、`MobileStepper`、`MobileDialog`，并复用官方
`View`/`Text`/`Focusable`/`Modal`。`guest/mobile-pages.tsx` 将它们接到 Mobile UI、
Transitions、Glass、Hardware 四个可操作页面；`guest/app.tsx` 负责 route stack 和
约 220ms 的 JS-owned transition tick。

`guest/legacy.ts` 的 `computeTransitionDescriptor` 提供
`IOS_SPRING_PARALLAX`、`SHARED_AXIS_Z`、`LIQUID_GLASS_MORPH`、`PORTAL_EXPAND` 四种
纯 JS 描述器；`buildLiquidGlassRecipe` 只生成形状、模糊/折射参数和采样数据。它们不是
旧 demo 的 Dart renderer，也不把样式数学本身当作设备视觉验收。

## 通用 surface provider 的实际范围

| 层 | 当前实现 | 验收边界 |
| --- | --- | --- |
| JS 注册 | `GlassSurface` / `PlatformTextureSurface` 调用 `pocket.registerSurface(packageId, kind, payload)`，kind 仅为 `glass` 或 `platformTexture`；cleanup 调 `releaseSurface` | `tests/mobile_ui.test.ts` 检查注册/释放、recipe 与路由；JS 不能注册任意 native view/compositor |
| Native | `native/src/lib.rs` bridge 验证 package、kind、JSON 和数量上限，保留 node/clip/order，投影为 `SURFACE_QUAD` | retained surface Rust smoke test 覆盖更新、clip、销毁/释放；视频不能由此外推为任意媒体或 3D surface |
| Flutter | `PocketHostSurfaceOp` 由 `pocket_view.dart` 分块 stack 插入；`glass` 进入 `_PocketGlassFilter`，`platformTexture` 只有 host `authorizePlatformTexture` 后才渲染 `Texture` | `pocket_surface_test.dart` 覆盖 descriptor/paint order/clip、Texture 授权撤销；真实摄像头帧和设备视觉仍未单独完成 |
| Glass shader | `pocket_surface.dart` 在 `ImageFilter.isShaderFilterSupported` 且 shader 成功时使用 `liquid_glass.frag` 的 refractive path；非 Impeller/不支持/加载失败保持明确 frosted `BackdropFilter`/tint fallback | fallback 不冒充折射；Impeller/non-Impeller 视觉差异需设备验收 |

## 仍需补齐的底层能力

- Native 未接 `GLYPH_RUN` opcode 3；当前配置以 `TEXT_RUN` 渲染文字，不能宣称完整 DrawList v1 全支持。
- `SURFACE_QUAD` 已有受限通用 provider bridge：native/Dart/JS 只接受 `glass` 与 `platformTexture`。视频接入是 `platformTexture` + 已授权 Flutter `Texture` 的一条 provider；没有任意 compositor、任意 Flutter view 或 3D renderer。
- 当前示例的输入生产端是 guest `InputField` 发出的 `textInput.open/update/close`，由 Flutter `TextField`/`EditableText` 与 system IME client 承接并回传 JS；上游 `GuestFrame.text` 的硬件键盘/IME 通道仍未接通，因此不能宣称所有硬件键盘/IME 已完成。
- `demo/integration_test/system_keyboard_test.dart` 已在 iPhone Duo 模拟器通过真实 guest、中文/emoji、selection/composing、删除、done 和导航保留 draft 回归；平台编辑事件使用 TestTextInput。实际系统键盘生命周期与逐帧画布几何另由 `system_keyboard_lifecycle_test.dart` 验证，详见 VALIDATION。`demo/integration_test/hardware_native_test.dart` 是生产 MethodChannel hardware 回归入口；iOS/Android 真实硬件结果仍需对应设备验收，不在此处预先标通过。
- 视频、辅助 surface、多语言字体、真机和性能不能由当前计数/导航测试外推。

## 宿主硬件 provider

`packages/pocket_hardware/lib/src/hardware_plugin.dart` 的 `HardwarePlugin` 是通过标准
Flutter plugin registry 编译进宿主的 `flutter.hardware` provider，不是下载包可以替换的
代码。`HardwareCapabilities` 覆盖
权限查询/请求、相机预览与 Texture 生命周期、镜头/闪光灯/拍照、照片列表/删除、BLE、
传感器、生物识别、位置和天气；`MethodChannelHardwarePlatform` 将非对象响应、
`MissingPluginException`、平台错误和超时转换为结构化失败。`demo/test/hardware_plugin_test.dart`
已有 descriptor、Android-shaped contract、unsupported、timeout、late result、Texture cleanup
和 weather coordinate 单测；真实 iOS/Android 权限、相机、传感器由 `hardware_native_test.dart`
做设备集成，当前由 root 按目标设备验证。

实际执行命令和结果见 [VALIDATION.md](VALIDATION.md)。
