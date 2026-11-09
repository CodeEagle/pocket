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
- Xcode project 的 Debug/Profile/Release 均将最低部署版本设为 iOS 15.0。
  这是最低运行系统，不是编译 SDK；不会阻止 Xcode 使用当前 SDK。
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

`packages/pocket_flutter/ios/pocket_flutter/Sources/pocket_flutter/PocketDisplayGeometry.swift` 在 27.1+ SDK 编译、且运行系统提供 UIKit ReservedRegion 时，按
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

## 2026-11-04 截图反馈：右上角状态区与 MiniApp 关闭按钮

来源截图（仅作问题记录，未复制到仓库）：

- `/Volumes/ORICO/mac-caches/tmp/codex-clipboard-mN9Aow.png`：折叠态。
- `/Volumes/ORICO/mac-caches/tmp/codex-clipboard-v9wWpT.png`：展开态。
- 最新反馈截图 `/Volumes/ORICO/mac-caches/tmp/codex-clipboard-YC0oQV.png`、
  `/Volumes/ORICO/mac-caches/tmp/codex-clipboard-F4pMw1.png` 仅用于确认折叠态 contour 下方
  的视觉间距与展开态首次挂载的 late-viewport 问题，仍未复制到仓库。

本轮已在 JS SDK 实施局部策略；Device Hub 截图复测仍未完成，不能把它写成“真机已解决”：

- 折叠态与展开态的 MiniApp 关闭按钮统一保持在顶部 `MobileAppBar` 右侧的 `reservedActions="mini-app"`（60px）预留槽位内（即 `Guest A` / `Guest B` 徽章右侧、右侧状态栏安全区左侧），不再下移到折叠态右侧状态条下方。
- 展开态右上角避让区域不足，状态图标向下覆盖横幅；状态横幅只增加局部 contour 余量，正文其余区域不重新加全局 right/top inset。

### JS 实施边界

- `sdk/packages/pocket_ui/src/responsive.ts` 的 `topRightOcclusionFrame()` 使用 active
  `occlusion.frame + margins`，只返回实际贴顶/贴右且非全高的局部 contour；不使用屏宽、机型名或
  固定图标尺寸。展开态 app-bar/StatusBar 使用明确的 `DISPLAY_UI_SAFETY_GAP=12` logical px UI 间距；该值不是
  OS margin。
- `system-surfaces.tsx` 继续以 raw `reservedInsets` 作为 OS safe-area 权威，统一对顶部 `44×44`
  close hit target 应用一次 `reservedInsets` 后执行横向 `avoidDisplayOcclusions(..., { prefer: "horizontal" })`，
  使关闭按钮在折叠态（`x=330..374, y=8..52`）和展开态（`x=815..859, y=8..52`）均位于顶部 `Guest A` 右侧。
  30px 同心圆视觉和 44px 触控区不变。
- `SafeAreaScaffold` 使用 `pageInsets` 释放 open Duo 中“`safeArea.right` 恰好等于局部右上
  occlusion 宽度、且存在纵向 division（active/inactive 均可）”的保守投影；folded 无 division
  时仍保留全局 right。`StatusBar` 组件自身增加局部右余量，长 detail 收缩/换行，并在 label/detail
  之间保留显式 gap；这是组件级保守 reserve，不是通用位置测量，也不把整页正文变成保守窄栏。
- `sdk/packages/pocket_ui/src/display.ts` 在已有 display event lane 上缓存每个 host bridge
  的最新 canonical geometry，并让晚挂载的 MiniApp surface replay 它；同宽 partial keyboard/resize
  更新沿用先前 safeArea/reservedRegions，不会因 raw packet 缺字段而首帧回到 camera/status 区。

这套策略依赖 native 提供正确的 `reservedRegions`。若 OS 只给 safeArea 或缺少局部 contour，SDK
不会伪造图标矩形；页面只能保留保守 safe-area，仍需补齐宿主几何事实。

已完成的 JS 回归与仍待设备验收：

1. JS/native fixture 已验证折叠 contour、展开 active/inactive division、长 detail、44px hitbox 和 geometry 更新；测试为
   `bun test packages/pocket_ui/test/responsive_occlusion.test.ts`、
   `bun test packages/pocket_ui/test/safe_area_native.test.ts`、
   `bun test js/tests/mobile_ui.test.ts`；`duo_close_native.test.ts` 另覆盖晚订阅者在完整+partial
   viewport 后首次稳定 close 命中。
2. Duo Flutter integration 已在真实 iPhone Duo simulator（UDID `4D366210-290E-46DB-8BC6-3C5233700409`）
   验证两次 folded 顶部 close：viewport `466×678`、contour `Rect(382,0,466,174)`、Pointer center
   `(352,30)`，两次均 `closedByRealPointer=true`；这同时验证了 Flutter→PocketView→JS 输入映射与
   folded 顶部 app-bar hitbox。
3. 仍需在 Device Hub 分别保存 folded、open 和 resize 中间帧截图，确认真实状态图标的包围盒与
   `frame + margins` 一致；测试 fixture 不能替代真实系统像素证据。open posture 的真实点击仍需姿态切换后补测。
4. 本轮未重启服务、未改变 Flutter/native 几何桥。

补充自动化：`bun test sdk/packages/pocket_ui/test/duo_close_native.test.ts`（仓库根目录）
构建真实字节码并实例化 `SystemAppSurfaces`，在同一个 native runtime 中切换折叠/展开/再折叠几何。
测试逐次点击折叠态右上状态区、折叠态右侧状态条下方、折叠态顶部 `Guest A` 右侧槽位（`x=352, y=30`）、
展开状态区、展开顶部槽位（`x=837, y=30`），以及反向折叠后的状态区/右轨/顶部槽位；断言命中结果为
`0 / 0 / 1 / 0 / 1 / 0 / 0 / 1`，防止仅统计总点击数造成假阳性。
另有 late-subscriber + partial viewport fixture；它验证首次稳定 close hit 落在顶部 `Guest A` 右侧槽位，
不把透明入场动画的首个 admitted frame 冒称为已测位置，因为 pocket_probe DrawOps 不暴露该节点的 computed style。
这是实际 PocketJS 命中测试，仍不代替 UIKit 状态图标的设备截图复测。

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

## 2026-11-04 异形滚动列表与全量 UI 渐进式宽度避让

### 问题根因

1. **右上角异形遮挡重叠（摄像头挖孔 + 时间 + 信号环）**：
   - `demo/js/app.tsx` 根 `<SafeAreaScaffold edges={["top"]} ...>` 未消费 `"right"`，而旧 `SafeAreaScaffold.topRightContentReserve()` 在 `pageInsets(current).right > 0`（折叠态 Duo `right = 84`）时直接返回 `0`，导致折叠态下 `Header`、`Tabs`、`PageIntro`、`Card` 等与右上角 `84×174` 状态区发生重叠。
   - 嵌套 `<MobileScaffold>`（默认 `edges="none"`）覆写了父级 `SafeAreaScaffoldContext`，导致子页面丢失 `displayGeometry` 与右上角 contour 信息。
   - 列表滚动时，位于异形区下方的子组件（`Card`、`MobileCard`、`Row`、`List`、`TileGrid` 等）上滑进入右上角遮挡区时不会动态收缩右侧宽度。

### 来源复用与改动

- **复用来源**：复用 `sdk/packages/pocket_ui/src/responsive.ts` 的 `topRightOcclusionFrame()` 与 `sdk/packages/pocket_ui/src/ui.tsx` 的 `ScrollablePage` + `committedLayout`（`pocket.getLayout`）坐标换算链路，并在 `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:_reservedRegionsForHost` 合并 Flutter `MediaQuery` / `FlutterView.displayFeatures`（`DisplayFeatureType.cutout` → `occlusion`，`hinge/fold` → `division`），使 Android 全系单挖孔、药丸孔、刘海屏及 iOS 27.1+ `ReservedRegion` 在竖屏和横屏下均上报精确遮挡框，不新增第二套布局引擎或 Dart 状态机。
- **`sdk/packages/pocket_ui/src/responsive.ts`**：
  - 新增 `hasLocalLeftOcclusionInset(geometry)`、`hasLocalRightOcclusionInset(geometry)` 与 `hasLocalTopRightOcclusionInset(geometry)`：识别 `safeArea.left` 或 `safeArea.right` 仅由局部侧边/角部 occlusion（如 Duo 右上角状态簇、横屏左右侧刘海、灵动岛或单个摄像头挖孔）投影产生的情形，释放整页冗余侧边安全边距，使挖孔上方与下方区域保持全宽。
  - 新增 `DISPLAY_CONTOUR_CLEARANCE_PX = 5`、`DISPLAY_CONTOUR_BOTTOM_TRIM_PX = 14`、`DISPLAY_CONTOUR_RAMP_PX = 5`、`leftOcclusionFrames`、`rightOcclusionFrames`、`sideContourReservesForBand(geometry, visualTop, visualBottom, options)` 与 `topRightContourReserveForBand`：支持重叠多区域左右侧 contour，保持 UI 边界距离真实异形区 `5px`，并对高占比顶角状态胶囊底部内收 `14px`；当子项从下方滑入 `[cutoutBottom, cutoutBottom + 5px]` 过渡带时按 C1 连续 Hermite smoothstep（`3t² - 2t³`）渐进收缩；对于 `cutoutTop > 0` 的横屏居中刘海或单挖孔，当子项继续上滑至 `[cutoutTop - 5px, cutoutTop]` 上方过渡带时按同一 smoothstep 曲线渐进恢复全宽（贴顶 `cutoutTop = 0` 的角部遮挡滑出顶边后仍保持不回弹以防屏外重排跳动）。
- **`sdk/packages/pocket_ui/src/ui.tsx` & `sdk/packages/pocket_ui/src/mobile.tsx`**：
  - `MobileAppBar` 顶部标题栏去除底色背景与底边线（保持透明），直接融入页面背景。
  - 来源核对：保留 parent 的 `mini_apps/syslib/pocket_syslib_flutter_ui.js:272-300` 将可选 `backgroundColor` 传给 `View.Header`，原生实现见 `lib/render/pocket_ui_components.dart:1907-1926`；当前 Root 的 `demo/js/app.tsx:930-934` 与 `MobileScaffold` 的 `mobile.tsx:672-676` 继续分别提供浅色 `#FAFAFA` / 深色 `#09090B` canvas，因此适配后由父 shell 持有页面底色，AppBar 不再叠一层固定色块。
  - 新增 `ScrollablePageContext`、`ContourConsumedContext`、`useScrollContourReserve` 与 `ScrollContourItem`（同时支持 `leftReserve` 与 `reserve`），在 `ScrollablePage` 的手势拖拽、动量帧、内容重排与 `display.viewport` 变更时同步测量子项真实未缩进左右边界（不重复累加容器 `p-4` / `mx-5` 边距），使子项边界精确停在距离真实异形区/单挖孔 `5px` 处；在缩进状态下启用裁剪，并在恢复全宽时保留组件声明的 `overflow-hidden` 属性。
  - 全量覆盖公共 UI 组件：`Header`、`MobileAppBar`、`PageIntro`、`SectionHeading`、`Tabs`、`StatusBar`、`EmptyState`、`Card`、`MobileCard`、`GlassSurface`、`Row`、`List`、`TileGrid`、`MobileListTile`、`MobileSegmentedControl`。
- **`demo/js/app.tsx`**：
  - 将 `HomePage`（顶部横幅、`HomeExplore`、标题行、双栏面板、底部状态行）、`GalleryPage`（`GalleryTile` 按整行左右边界统一计算双列网格卡片宽度）、`RuntimePage`、`PerformancePage`、`StressPage` 全部接入 `ScrollContourItem` / `useScrollContourReserve`，并重新编译 `demo/js` 及 `profile`、`lobby` Mini-App 字节码。

### 验证记录

- `flutter test test/pocket_view_viewport_test.dart`（于 `sdk/packages/pocket_flutter`）：验证 `DisplayFeatureType.cutout`（横屏刘海/单挖孔）自动转换为 `display.viewport.reservedRegions` 内的 guest 坐标 `occlusion`。
- `bun test sdk/packages/pocket_ui/test/responsive_occlusion.test.ts`：验证 `hasLocalLeftOcclusionInset`、`hasLocalRightOcclusionInset`、`sideContourReservesForBand` 与 `topRightContourReserveForBand` 在顶角状态区、横屏左侧刘海（含上下双端 5px smoothstep 过渡带）、横屏右侧 28px 单挖孔、多区域叠加及全高遮挡下的几何契约。
- `bun test sdk/packages/pocket_ui/test/safe_area_native.test.ts`：通过 `pocket_probe` 运行编译后字节码，验证 `MobileAppBar` 透明无底色、双列网格右列距异形区 5px 避让、顶角与横屏左侧单挖孔下列表卡片从下方全宽滑入异形区缩进（距异形区 5px）并继续上滑到横屏单孔上方后恢复全宽、以及静止态内容重排自动同步的完整闭环。
- 2026-11-08 透明 AppBar 回归复验：使用 pinned Bun 1.4.4 与 SDK native-tools 包，隔离运行 `safe_area_native.test.ts`，390px 与 320px portrait、landscape 与 contour scroll 全部通过（1 test，退出码 0）。
- `cd demo/js && bun run test && cd ../.. && python3 sdk/scripts/check_architecture.py`：全部通过。
