# iPhone Duo 原生壳适配核对

核对日期：2026-11-02。当前 Flutter 壳位于 `../demo/ios`，范围是它的窗口/安全区
桥，以及 iPhone Duo 的官方尺寸变化要求。本文保留来源记录中的 `host/` 路径；它对应当前
Demo，而不是 SDK 的第二个入口。公共 SDK 已承担原生几何、窗口同步和 JS 自适应；设备验证边界见下文与 VALIDATION。

## 结论

当前原生壳没有发现会把 iPhone Duo 锁成旧比例或 letterbox 的配置：

- `host/ios/Runner/Info.plist:31-43` 同时声明 portrait、landscape left/right；没有原生
  `supportedInterfaceOrientations` 锁定代码。
- `Info.plist:73-93` 已使用 `UIApplicationSceneManifest`、`UIWindowScene`、
  `FlutterSceneDelegate` 和 `Main` storyboard；`AppDelegate.swift` 仅做 Flutter/plugin
  注册，没有创建一个以 `UIScreen.main.bounds` 为尺寸的旧窗口。
- `UIRequiresFullScreen` 不存在，等价于没有声明 full-screen-only；不要为了“修 letterbox”
  强行设置 true。当前没有必要新增配置键，避免改变 iPad multitasking 语义。
- `host/ios/Podfile:1,38-48` 与 Xcode project 的 Debug/Profile/Release 均将最低部署版本
  设为 iOS 15.0。这是最低运行系统，不是编译 SDK；不会阻止 Xcode 使用当前 SDK。
- 本机只读工具输出为 `Xcode 27.2 (27B52)`、iPhoneOS SDK `27.2`，可用 iOS 27.1
  runtime 的 `iPhone Duo` simulator（当前 UDID：`4D366210-290E-46DB-8BC6-3C5233700409`）。
  Project 的 `SDKROOT = iphoneos` 没有旧 SDK 路径或 `SDKROOT = iphoneos15` 之类 pin。

原生平台代码已从 Runner 迁入自动注册的 `pocket_flutter` 和 `pocket_hardware` 插件。没有为了适配 Duo 增加 `UIRequiresFullScreen`；它不能替代尺寸自适应。

## 官方要求与参考文章

Apple 的 [Prepare - iPhone Duo](https://developer.apple.com/iphone-duo/prepare/) 明确说明：

1. iOS 27 SDK 让 app 在展开/折叠时动态 resize；iOS 27.1 SDK 或更高版本才是 edge-to-edge
   的优化目标，工具栏和 tab bar 可能在状态栏下方竖向排列。
2. 不要用 `UIScreen.main.bounds`、一次性读取的启动尺寸、`UIDevice.current.orientation`、
   `statusBarOrientation`、固定设备尺寸或“phone/pad idiom”决定布局；使用 view/window
   bounds、trait/size class，并在尺寸改变时重新布局。
3. 使用 Xcode 27.1+ 的 iPhone Duo simulator/Device Hub 检查展开、闭合、旋转和折叠姿态。

Apple Tech Talk [Prepare your app for iPhone Duo](https://developer.apple.com/videos/play/tech-talks/111461/)
进一步说明：内屏不按 supported interface orientation 决定布局；应依赖 size class、trait
collection、scene bounds；safe area/边距可能不对称，iOS 27.1 的 `ReservedRegion` /
`UIViewReservedRegion` 可供自绘栏和 edge-to-edge UI 避开摄像头/折叠区域。它还说明
`UIRequiresFullScreen` 仍会被尊重，但开合仍会触发 resize；所以该键不能作为“禁止变化”的
替代方案。

用户提供的 [知乎参考文章《iPhone Duo 适配详解，需要改变的不止是布局模型》](https://zhuanlan.zhihu.com/p/2081732020691117995)
通过 Safari 正常 UI 读取（自动抓取返回 403，未绕过安全限制）。文章是第三方解释，不作为
规范来源；与 Apple 要点一致的部分是：外屏/内屏保持同一 UI 状态、布局跟随可用空间而不是
简单按 portrait/landscape 切两套页面、工具栏/Tab 可转为侧边竖向区域，并要处理摄像头和
折叠中部的 `Reserved Region`/不对称 safe area。文章给出的“局部位移、保持信息架构”的
建议也意味着不要在开合期间把整页当成固定比例图片缩放。

## 当前壳与尺寸链证据

| 文件/行 | 当前行为 | Duo 结论 |
| --- | --- | --- |
| `host/ios/Runner/Info.plist:31-43` | iPhone 支持 portrait、landscape left/right；iPad 另列四向 | 没有单向锁；内屏仍由可用尺寸/size class 驱动，不能在 JS 中读取方向代替尺寸 |
| `host/ios/Runner/Info.plist:73-93` | 动态 scene manifest，`FlutterSceneDelegate`，单 application scene，`Main` storyboard | 窗口属于 scene，不是 `UIScreen.main.bounds` 静态窗口 |
| `host/ios/Runner/AppDelegate.swift` | `FlutterAppDelegate`，只调用 `GeneratedPluginRegistrant`；几何与硬件由公共插件自动注册 | 没有 orientation lock、固定 window frame 或原生业务页面 |
| `host/ios/Runner/Base.lproj/Main.storyboard:14-21` | Flutter view `widthSizable`/`heightSizable`，无固定约束 | 初始 storyboard rect 的 600×600 只是设计画布，不是运行时窗口尺寸 |
| `host/ios/Runner.xcodeproj/project.pbxproj:462,592,643` | Debug/Profile/Release 最低 iOS 15.0；`SDKROOT=iphoneos` | 部署下限与编译 SDK 分离；当前 Xcode 27.2 会使用 SDK 27.2；ReservedRegion bridge 的源代码需要 27.1+ SDK 才能识别新 UIKit 符号 |
| `host/ios/Runner.xcodeproj/project.pbxproj:465-466,646,649` | `SUPPORTED_PLATFORMS=iphoneos`、`TARGETED_DEVICE_FAMILY=1,2` | iPhone/iPad 壳均可构建；没有把 Duo 当成 iPad 专属页面 |
| `packages/pocket_sdk/lib/src/pocket_app.dart` | `PocketApp` 挂载 `PocketGuest` / `PocketView`，外层不使用 `SafeArea` 裁切画布 | 背景 edge-to-edge；系统几何经 bridge 提供给 JS，JS 安排交互控件 |
| `packages/pocket_flutter/lib/src/pocket_view.dart:827-947` | 依据实际 host RenderBox、`View` DPR 和逐侧 `viewPadding` 计算 safe area，向 native/guest 发 `display.viewport` | 已能处理 nested SafeArea 和左右不对称 inset；不是把设备全局尺寸硬编码进 guest |

`packages/pocket_flutter/ios/Classes/PocketDisplayGeometry.swift` 在 27.1+ SDK 编译、且运行系统提供 UIKit ReservedRegion 时，按
布局/scene/hinge 变化读取 division/occlusion 区域，并通过 `display.viewport.reservedRegions`
送给 JS；Dart 会把窗口坐标裁剪、变换到当前 PocketView 本地 guest 坐标。低于 iOS 27.1 的
运行时会以 `supported=false`/空数组安全回退，不能把“旧运行系统返回空”误写成“旧 SDK 可
编译”：新符号要求构建机使用 iOS 27.1+ SDK，但部署下限仍可保持 15.0。`@pocket/ui`
基于实际 viewport 和 reservedRegions 自适应，不在原生壳中新增第二个页面或布局引擎。

## 已有验证与未验证项

已有源码/记录可以证明：

- `docs/VALIDATION.md` 记录 iPhone Duo iOS 27.1 simulator 的真实 guest、键盘展开收起、
  每帧画布 1:1/左上锚定、滚动和更新链；`host/integration_test/page_scroll_test.dart`
  以及 `system_keyboard_lifecycle_test.dart` 覆盖的是 resize/输入生命周期，不是所有折叠
  姿态。
- `../demo/integration_test/hardware_native_test.dart` 与 `docs/HARDWARE_REUSE.md` 记录生产
  MethodChannel hardware contract 的 iPhone Duo 目标运行结果；这不证明 Duo 的折叠布局、
  ReservedRegion 或物理设备权限已经覆盖。
- 原生配置检查没有将现有模拟器运行态当作折叠验证。新增 viewport 单元测试覆盖
  不对称 safeArea、嵌套宿主点击和键盘重叠，真实开合姿态仍须设备验证。

仍需在 Duo simulator/Device Hub 逐姿态验收：

- 外屏闭合 portrait、外屏 landscape、内屏完全展开 portrait/landscape、半折 tent/桌面姿态、
  open/close/rotate 动画中间帧，以及可用时的左右 Split View。
- 每个姿态记录 PocketView RenderBox size、`display.viewport` 的 width/height、四个 safeArea
  值和首个/最后一个 DrawList frame；确认页面不因旧逻辑整体 contain 缩小、横向居中或跳回
  另一套业务路由。
- 检查 JS mobile UI 的 toolbar、Tab、输入框和 Hardware 页在不对称左右 inset 下仍可点击；
  折叠中部不放关键按钮或文本。当前 showcase 仍是全 JS 页面，原生只提供壳、
  renderer、IME 和明确 capability bridge。

## 可复核的模拟器操作

当前 Xcode 27.2 的 `xcrun simctl help` 没有 `pose` 子命令，因此不应记录一个未经支持的
`xcrun simctl pose ...` 命令。先查找/启动 Duo：

```sh
xcrun --sdk iphoneos --show-sdk-version
xcrun simctl list runtimes
xcrun simctl list devices available | rg 'iPhone Duo'
DUO_UDID=4D366210-290E-46DB-8BC6-3C5233700409
xcrun simctl boot "$DUO_UDID"       # 已 booted 时无需执行
```

姿态由 Xcode 27.1+ Device Hub 的 iPhone Duo 控制条执行：选择 `open`、`close`、`rotate`、
`fold`，并在每一姿态等待 app 完成 resize 后截图/录制。`simctl` 只负责设备状态和证据采集，
例如：

```sh
xcrun simctl io "$DUO_UDID" screenshot artifacts/duo-open.png
xcrun simctl io "$DUO_UDID" recordVideo --codec=h264 artifacts/duo-fold.mov
# 完成 open/close/fold 后按 Ctrl-C 结束录制
```

Device Hub 是 Apple 官方建议的完整 native experience 测试入口；若未来 Xcode 增加 pose
CLI，应先以 `xcrun simctl help` 为准，再把确切参数写入这里。本文没有启动 app 或执行
上述折叠操作。



## 公共 SDK 后的实际开合验证

`duo_geometry_native_test.dart` 已在 Device Hub 执行 open → partially open → closed → open。真实 UIKit 数据经自动注册的 `PocketFlutterPlugin` 进入 JS：展开 951×669，闭合 466×678，division 活动状态随姿态改变；这些数值是本次设备记录，不是运行时布局常量。

真实回归曾捕获“旧 951pt native frame + 新 466pt FlutterView”形成的 569pt 右 inset。现在同时等待 native geometry、FlutterView 与自动 viewport 的 PocketJS frame 尺寸一致后发布事件；最终回归没有再出现异常 inset，并增加设备断言。固定预览视口继续保留原来的缩放/坐标映射。区域 ID 使用 UIKit ID 的 Hashable identity，避免把 `String(describing:)` 的重复 `ID()` 当稳定标识。

`@pocket/ui` 提供 `createDisplayGeometry()`、`deriveResponsiveLayout()`、`availableDisplayPanes()`；监听、safe-area/occlusion 与 division 解释属于公共库，应用使用相同结果组合导航和页面。完整旋转、多窗口与物理 Duo 的姿态矩阵仍未完成，不能由这条开合测试推断全部通过。

## 2026-11-04 底部 TabBar 统一与 iPhone Duo 开合修复

### 问题根因

1. **并非 UIKit `UITabBar`**：Showcase 导航由 JS guest 组件 `sdk/packages/pocket_ui/src/ui.tsx:NavigationBar`（导出别名 `TabBar` / `BottomNavigationBar`）绘制在 Flutter 画布上。
2. **展开态变成右侧竖向窄条 + 右侧 84pt 空白**：原实现于 `width >= 720` 或存在纵向 `division` 时切换为竖向 `rail`（`width: 104, marginR: 84`），与需要保持底部水平等分 `TabBar` 的产品预期不一致。
3. **展开后折叠缩到左下角约 104pt 小方块**：
   - 展开切回折叠时 `<NavigationBar>` 未重新挂载，内联 `style` 从 `{ width: 104, marginR: 84, ... }` 变为 `{ paddingL, paddingR, paddingB }`；而 PocketJS `setStyleObject`（`sdk/.cache/pocketjs/framework/src/native-tree.ts:704-722`）仅覆盖新传入键、不清理被省略的旧键，导致 `node.overrides` 中残留 `width: 104` 与 `marginR: 84`，压过 `w-full`。
   - 同时 iPhone Duo 将右上角状态区域（`13:12` + 圆环）保守投影为全局 `safeArea.right = 84`，底部栏直接消费 `paddingR: 84`，在残留的 `104pt` 宽度内仅剩 `20pt` 内容区，导致 `Home` / `Gallery` / `Host` 挤在左下角。

### 来源复用与改动

- **复用来源**：`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart:2239-2345` 的 `BottomNavigationBar` 契约（底部固定高度 + `bottom` 安全区填充 + `Expanded` 等分水平排布）。
- **`sdk/packages/pocket_ui/src/responsive.ts`**：新增并导出 `bottomBarInsets(geometry)`。底部 `TabBar` 消费 `bottom` 安全区（`34pt`），仅当 active occlusion 实际与底部栏高度带相交（`top + height > geometry.height - (64 + base.bottom)`）时才保留水平边距，避免右上角局部状态区投影的 `safeArea.right = 84` 挤压底部 TabBar。
- **`sdk/packages/pocket_ui/src/ui.tsx`**：`NavigationBar`（并导出 `TabBar` / `BottomNavigationBar` 别名）在所有姿态下统一渲染为底部全宽水平等分 `TabBar`（`flex-row items-center w-full shrink-0` + 子项 `flex-1`），内联 `style` 仅设置 `{ paddingL, paddingR, paddingB }`，不再写入 `width` 或 `marginR`。
- **`demo/js/app.tsx`**：移除主壳的左右 `rail` 分支，统一为单列 `flex-1 flex-col h-full overflow-hidden`（上方路由视口 `flex-1 w-full h-full overflow-hidden` + 底部 `<NavigationBar>`）。

### 验证记录

- `bun sdk/packages/pocket_ui/test/navigation_bar_native.test.ts`：覆盖 `390×844`、`720×844`、窄宽切换及 iPhone Duo `951×669`（展开）→ `466×678`（折叠）→ `951×669`（再展开）全链路 native 布局断言，三枚 Tab 等宽、同线且底部安全区生效。
- `bun test tests/mobile_ui.test.ts tests/guest_state.test.ts` 与 `bun tests/guest_ablation.ts --required`（于 `demo/js`）：通过。
- 使用 `pocket_probe` 加载重建后的 `demo/assets/app.qjbc` + `demo/assets/app.pak` 注入真实 `duo_geometry.json` 采样：展开态（`951×669`）Tab 中心点 `159 / 475.5 / 792.5`（`y: 616`），折叠态（`466×678`）Tab 中心点 `78 / 232.5 / 388.5`（`y: 625`），往返切换无宽度残留且页面纵向拖拽滚动正常。
