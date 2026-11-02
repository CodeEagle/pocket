# 整合评估与架构决策

## 目标

Flutter 是 PocketJS 的绘制与系统适配器。应用页面、组件组合、交互状态、导航和业务流程只由 JS/TSX 定义。PocketJS 自身 native engine 执行布局和命中测试属于引擎实现，并不意味着把业务写进 Flutter。

```text
JS/TSX（页面、组件、状态、路由）
  → 固定版本官方编译器 → QuickJS 预编译字节码 + PAK
  → QuickJS guest / PocketJS core（布局、输入、DrawOps）
  → FFI frame + resources
  → Flutter Canvas / Texture（绘制、输入、IME、生命周期）

文本输入是同一边界上的显式 bridge：JS `InputField` 发出 `textInput.open/update/close`，PocketView 挂载 Flutter `TextField`/`EditableText` 作为 `TextInputClient`，再由系统 IME 提供编辑值；最后编辑事件回到 JS 的 draft reducer。JS 保持文本、路由和业务状态，Flutter 不复制业务输入状态。该 bridge 不代表上游 `GuestFrame.text` 硬件键盘通道已接通。
```

不能把“38 个组件”理解成 Flutter 再实现 38 套组件逻辑。组件属于 PocketJS 契约；Flutter 消费引擎输出的绘制与媒体指令。组件导出存在、可编译、真实输入可交互、真机显示正确是不同验收层级。

## 两个来源的取舍

| 来源 | 采用 | 排除 |
| --- | --- | --- |
| pocketjs_flutter_demo | 组件与交互需求、宿主产品方向 | Dart 业务页面生成器、模拟 C runtime、占位 SHA/AOT/OTA、模拟微信运行时 |
| PocketJSKit | pinned compiler、Rust RquickjsGuest、FFI、Canvas painter、资源与输入桥接；editor 的本地项目/构建/发布协议作为脚手架来源 | 故事 GameConfig、阅读器/业务模板、旧 editor 的 page-graph/WASM preview、COS、JS 之外的应用状态/路由编排 |

Kit 更接近真实运行底座，但它已混合游戏模板、编辑器和发行工具，不应直接整仓复制。旧 demo 保留作为参考，本目录独立运行；没有让旧路径成为构建依赖。

## 边界

- Flutter：窗口/视口、绘制、资源解码、纹理、输入与 IME、生命周期、必要的原生能力授权与调用。文本输入的当前演示路径是 Flutter `TextField`/`EditableText` system-IME bridge；权限不能由下载的 JS 自己授予。
- Native：QuickJS 执行、PocketJS core/layout/input、资源表、预算与 FFI。所有调用在同一所有者线程顺序执行。
- JS：页面结构、组件组合、应用状态、交互动作、应用内导航。更换 JS/PAK 应能改变界面与行为，无须修改 Dart。
- 签名发行、版本回滚、能力与插件生命周期放在独立 `pocket_services`，不会进入 renderer。`editor/` 是本地开发/签包脚手架，不是业务 runtime；游戏配置协议、旧 editor 的 page graph/WASM preview、跨沙盒总线、3D 和微信宿主继续排除。
- 外部 Flutter 插件在构建时注册；更新包仅包含 JS 字节码和资源。业务页面使用 `guest/ui` 组合，无第二套 Flutter 业务 UI 库。
- 字节码采用与运行时相同的 QuickJS 编译器；它不是机器码 AOT，也不靠压缩或包装 JS 冒充字节码。
- 不声称内存预算等同进程隔离，不把桌面验证写成 iOS/Android 真机验收。

## 本轮新增决策

### Editor 是真实 qjbc 发布脚手架，不是 API 空壳

`editor/server.ts` 和 `editor/client/` 提供 project list/create、配置、`app.tsx` 兼容
入口及任意安全 guest source 文件的 GET/PUT、构建、日志、artifact 和发布 UI。它从当前
仓库 `guest/` scaffold 复制项目，调用 pinned compiler、`native/target/*/pocketjs_bytecode`
和 `scripts/package_update.ts`，发布 `app.qjbc`、PAK blobs、`latest.json` 与
`host.json`。多文件接口拒绝 traversal/symlink、构建目录、密钥和 qjbc/PAK 写入；`app.js`
仅是诊断 artifact，runtime 不从字节码回退源码。当前 HostSession 直接消费 manifest/blob
和 host.json，`.tar.gz` 只作为离线导出。

旧 Kit editor 的页面图、WASM preview、故事/阅读器模板和 COS 依赖没有复制，因为它们不
属于当前薄 Flutter host 的构建闭环；这不是把 editor 永久排除，而是把可运行的本地闭环
收敛到当前 qjbc+PAK+签名 ABI。

### Surface QUAD 只开放明确 provider kind

JS 组件通过 `pocket.registerSurface` 注册 `glass` 或 `platformTexture`，Native 保留
surface handle、geometry、clip、order 并发出 `SURFACE_QUAD`，Dart `PocketHostSurfaceOp`
再选择对应 renderer。`platformTexture` 需要宿主先通过
`PocketViewController.authorizePlatformTexture` 授权，视频只是这条 Texture provider 的
一种使用；不开放任意 compositor、任意 native view 或 JS 自带纹理句柄。

`pocket_surface.dart` 在 shader filter 可用并成功加载 `liquid_glass.frag` 时走 Impeller
refractive path；非 Impeller、能力不支持或 shader 失败时保留明确 frosted backdrop/tint
fallback。JS `buildLiquidGlassRecipe` 负责形状与参数，不把 fallback 说成折射。

### Mobile UI、转场和硬件边界仍以 JS/编译宿主为准

`guest/ui/mobile.tsx`、`guest/mobile-pages.tsx`、`guest/legacy.ts` 负责 mobile composition、
四种 transition descriptor、glass recipe 与页面状态；Flutter 只绘制 native frame、surface
和系统输入。`HardwarePlugin` 是编译进宿主的 `flutter.hardware` provider，下载 JS 只能经
capability/permission bridge 请求，不能携带或替换原生代码。

源码单测和 renderer surface test 可以证明协议/状态/生命周期边界；`hardware_native_test.dart`
的真实 iOS MethodChannel/权限/Texture 结果由 root 进行中，本文件不把设备验证写成完成。

## 消融验收

1. 原项目 Dart bundle runner、模拟 C runtime、业务模板完全不参与构建，真实 JS 仍能产生绘制帧。
2. JS 中修改状态或响应真实引擎输入后，输出帧改变；Dart 不提供对应业务动作。
3. 使用不同 JS 内容时输出不同，不允许 runtime 初始化失败后回退成 Dart 演示画面。
4. 保留实际需要的资源/IME/媒体适配；“最薄”不是删除系统必需的正确性处理。当前 bridge 的编辑协议回归和真实系统键盘生命周期回归已在 iPhone Duo 模拟器通过，记录见 `VALIDATION.md`；hardware provider 的 iOS/Android 单测与生产 channel 已在位，但实体硬件仍由 root 按目标设备验证；不能据此推断上游 `GuestFrame.text`、真机或所有硬件键盘场景已完成。

实际命令与结果记录在 VALIDATION.md，未执行的验证不得记作通过。
