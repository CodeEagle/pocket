# 旧 Demo 中的 SDK 能力复用

> 历史基线记录：当前状态请先看 [2026-11-03 源码复核与待选迁移项](LEGACY_REUSE_REVIEW_20261103.md)。下文部分“已迁 / 尚缺”结论已被后续实现或消融调整，不能直接用作当前能力清单。

来源：`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps` 与 `native`。
审查日期：2026-11-02。明确排除旧仓库的 `pocket_host/`。
本记录区分公共 SDK 能力与消费端示例；登录、天气页面和账号数据属于 Demo，不能作为 SDK 能力迁移完成的依据。

`native/` 的逐项真实行为、当前 SDK 对照和可迁移边界见
[LEGACY_NATIVE_AUDIT.md](LEGACY_NATIVE_AUDIT.md)。

## 公共实现

| 旧来源 | 当前 SDK 落点 | 边界 |
| --- | --- | --- |
| `syslib/pocket_syslib_graphics.js` | `packages/pocket_ui/src/graphics.ts`，从 `@pocket/ui` 和 `@pocket/ui/graphics` 导出 | 粒子帧计算、六实体轨道与线段计算、SVG 图形规格；纯数学，不包含 Scene/Rapier/3D renderer |
| `syslib/pocket_syslib_router.js` | `packages/pocket_ui/src/legacy.ts` | 四种转场描述计算；旧 C Navigator、跨沙盒返回值没有因此实现 |
| `pocketjs_uikit.js` | `packages/pocket_ui/src/legacy.ts`、`mobile.tsx` | Glass recipe、SDF 计算与真实 Flutter glass surface；旧独立 surface runtime 不重复引入 |
| `syslib/pocket_syslib_flutter_ui.js` | `packages/pocket_ui/src/mobile.tsx` 及新增 JS widgets | 用现有 PocketJS/Solid primitives 组合；不恢复旧 `{tag,props,children}` VDOM 和 Dart 组件解释器 |
| `syslib/pocket_syslib_hardware.js` | `packages/pocket_hardware` | iOS/Android 真实权限和硬件 provider；旧固定返回值不能迁入生产 provider |
| `syslib/pocket_syslib_ota.js` | `packages/pocket_services` | 当前签名 qjbc/PAK 更新链路；不引入第二套旧 syslib OTA 状态机 |
| `native/pocket_runtime_multi.c/.h` duplex ABI | `native/src/duplex.rs`、`pocket_duplex.dart`，详见 `DUPLEX_TRANSPORT.md` | ABI v2 两条 lock-free SPSC、原子发布、批量 FFI 与独立 Arc 生命周期；真实 QuickJS 回调与 emit，JS 是标量边界，旧 C echo 不再使用 |

## 仍属于能力缺口

旧 `app_game_detail` 所需的真实 Scene 资源加载、Rapier 碰撞、BLE 手柄持续通知、跨 runtime 的共享状态，以及旧 router 的完整异步 push-result 生命周期，目前不能仅凭旧声明视为当前 SDK 已支持。

旧 `.pjc`、`build_aot`、runtime bundle、插件锁表和页面元数据不与当前 QuickJS qjbc ABI 混用。公共 API 按当前构建管线重新编译，外部项目从 SDK package 导入，不依赖旧 Demo 目录。

## 验证方式

- 图形计算：`bun sdk/packages/pocket_ui/test/graphics.test.ts`。
- Demo 只作为 SDK 消费端：使用同一公共 `@pocket/ui` 入口绘制粒子和 UI；测试需验证真实 QuickJS 指针交互与帧变化。
- Duplex 的布局、背压、生命周期与真实接入分别记录，不能以 C echo 冒充 JS 端到端零拷贝。

## 全仓库复审范围（排除 pocket_host）

已逐层查看旧仓库的 `lib/`、`native/`、`mini_apps/`、`tools/`、`ios/`、
`android/`、`macos/`、`shaders/`、`assets/svg/`、`wechat_host/`、
`web_wasm_preview/`、`test/`、`tests/`。不运行旧工程、不生成旧缓存；结论来自实现和调用链，
不是 README、界面文案或截图。

### 优先整合的 SDK 技术

| 优先级 | 技术 | 实现证据 | 可迁移内容 / 当前差距 |
| --- | --- | --- | --- |
| P1 | Deep Link 输入 | `ios/Runner/SceneDelegate.swift` 的冷启动和 URLContext；`AppDelegate.swift` 转发 | 旧 iOS 有实际平台事件入口；当前 SDK 缺少通用 URL ingress。应由薄平台插件传给 JS，由 JS 处理路由和权限；需补 Android 冷/热启动与退订测试 |
| P1 | 二进制双向通道 | `native/pocket_runtime_multi.h`、`lib/core/ffi_bridge.dart` 中共享 ring 映射 | 固定 16B 消息、双队列、批量/背压可复用；旧 JS 未实际参与，旧 C echo 不能当端到端零拷贝。详见 `DUPLEX_TRANSPORT.md` |
| P1 | JS 公共组件 | `mini_apps/syslib/pocket_syslib_flutter_ui.js` | 本轮已导出 Divider、Chip、确定型进度、FAB、IconButton、NavigationDestination；映射到当前官方 primitives，不复制旧 VDOM/Dart renderer |
| P1 | 图形计算与资源 | `syslib/pocket_syslib_graphics.js`、`assets/svg/` | 已迁公共数学函数和 SVG specs；真实 3D/物理仍是缺口，数学输出不等于 renderer |
| P2 | 按需调度与绘制隔离 | `lib/render/pocket_ui_components.dart` 的 `_syncTickerState`、`RepaintBoundary`、page subtree cache | 可提取空闲停 tick、resume、转场缓存失效的回归场景；当前 PocketView 已有 idle/dirty 机制。不可搬入 Dart 页面栈与无限常驻页面缓存 |
| P2 | 帧诊断 | `lib/core/perf_monitor.dart` 的 addTimingsCallback 与 HUD 更新节流 | 当前已记录 FPS 与历史；可补 UI/raster/jank 细分及 HUD 自触发过滤。旧预填 60FPS 和固定耗时不能作为测量结果 |
| P2 | 导航生命周期与返回值 | `syslib/pocket_syslib_router.js`、旧 Dart router 对照 | 转场公式已迁；可把 push-result/cancel 与 appear/disappear 提炼为纯 JS SDK 契约。freeze/prewarm 必须绑定真实 runtime，不能照搬 C 状态位 |
| P2 | 插件 schema 与类型生成 | `mini_apps/pocket_plugins.json`、`tools/sync_pocket_plugins.py` | 可借鉴版本/权限/方法 schema、TS 类型生成和 disabled 配置；需要从实际编译插件注册表推导，不能相信固定 sizeKB 或字符串裁剪报告 |
| P2 | 传感器数据工具 | `syslib/pocket_syslib_hardware.js` 的气压高度与 BLE packet decoder | 可做独立带范围/长度校验的数据工具；旧 malformed packet 返回固定温湿度必须删除。不能代替真实硬件传输 |
| P3 | 新宿主适配协议 | `wechat_host/core/wx_pocket_host.js` | retained node 协议和 canvas command 映射可作未来宿主样例；当前文件实际走 setData/WXML，未加载 PocketJS WASM core，不是可直接发布的跨端 SDK |

### 已覆盖，避免重复实现

- 原生系统键盘：旧 `_PocketFlutterNativeKeyboardInput` 提供参考；当前 SDK 已使用 Flutter EditableText，继续补真实输入回归即可。
- iOS 真实硬件：旧 AppDelegate 的权限/相机/BLE/定位/生物识别已迁 provider，并改成统一 Texture；Android 旧 Activity 是默认 runner，当前 Android 实现已超过旧目录。
- Liquid Glass：旧 shader 的 SDF、边缘光与采样思路有价值；当前 SDK 已有 recipe 和 shader surface，保留一套实现并做视觉/性能对照。
- QuickJS 字节码、签名更新、rollback、PAK 资源、固定 tick、DrawList 与 delta cache：沿用当前 SDK，不用旧模块覆盖。

### 明确不能按原实现集成

1. `native/pocket_runtime_multi.c` 的 sandbox、内存分层、watchdog、3D、视频、插件和 OTA 很多是状态模拟；它没有 QuickJS JS 执行。复用 ABI/需求场景，不能另起第二 runtime。
2. `lib/core/pocketjs_bundle_runner.dart` 与 `lib/render/pocket_ui_components.dart` 由 Dart 维护业务状态和旧 VDOM，整体移入会违背 JS 拥有业务 UI 的边界。
3. `lib/core/real_hardware_bridge.dart` 的 fallback 把失败伪装成照片、BLE、传感器、天气等成功数据；必须排除。
4. `tools/compile_pocket_syslib_aot.py` 的 `compile_pjc_binary` 返回 `header + js_bytes`，其中 payload 是删注释/空白后的源码；Node 求值生成 VDOM JSON 也不是 QuickJS 字节码。不能作为真实 AOT 管线。
5. `tools/sync_pocket_plugins.py` 通过 `m_name in js_source` 保留方法，并用预设 sizeKB 估算节省；不是 AST 调用图或实际二进制裁剪，生成的锁表/声明文件也不证明 Flutter 插件被编译和注册。
6. `web_wasm_preview/index.html` 的 ring 是 JS 对 `WebAssembly.Memory` 的 DataView 读写，echo 也是 JS 函数；没有实例化 WASM 模块，也没有跨 worker 原子同步。可借鉴布局，不能宣传 WASM runtime 或 lock-free。
7. `tests/verify_architecture.py` 用 ctypes 测旧 C 状态；截图测试走旧 Dart renderer，且含机器绝对路径。可提取用例，但不能作为当前真实 JS runtime、硬件、120FPS 或隔离安全的验收结果。

### 建议顺序

先补 Deep Link 平台 ingress 与有实际消费者的二进制通道；同步完善公共 JS widgets。
随后补导航返回值/生命周期和诊断指标。多 guest、资源预算、VFS、3D 与构建期原生插件裁剪属于
新能力工程，需要独立设计、资源限制与验收，不能用旧 mock 接口快速标记完成。

### 消融与验收要求

- 仅保留当前 QuickJS runtime、Solid primitives、签名更新状态机；不并入旧 C runtime、Dart VDOM、`.pjc` pipeline 或第二 OTA manager。
- 共享 ring 与已有 JSON/stream 通道按用途并存：低频控制继续走现有消息协议，固定数值高频消息才走二进制通道，不再包装第二份业务状态。
- 原生通信须验证实际 JS 消费/回写、队列满、缺少 handler、handler 抛错、reload/dispose 后访问；ABI 布局通过不等于全链路通过。
- 性能验收应以同载荷（1/64/255 条）、同设备 release/profile 的 CPU 时间、分配量、FFI 次数和 p95 帧时比较；本轮不依据旧文案宣称 120FPS 或固定百分比提速。

## 本轮新增实现的验证记录

- `cargo test --locked --lib binary_duplex`：5 项通过，实际 QuickJS 处理/回写、缺少 handler 与异常 handler。
- `cargo test --locked --test duplex_layout`：6 项通过，原子 SPSC 百万消息并发、满队列、角色独占与关闭竞态；另有手动 release benchmark。
- `pocket_flutter: flutter test test/pocket_duplex_test.dart`：传输协议、批量 FFI 次数和 dispose 访问保护；最新实测与真实 FFI 记录见 `DUPLEX_TRANSPORT.md`。
- `bun sdk/packages/pocket_ui/test/graphics.test.ts`：纯图形计算测试通过。

这是源码/主机侧定点验证记录。ABI v2 的 Android arm64 与 iOS arm64 simulator 原生库已重建并检查导出；需随宿主发布。
不能用之前 Android APK/模拟器结果证明新 FFI 已在设备上通过，也不能据此声称端到端性能改善。
- `flutter_widgets.test.ts`：独立 SDK 消费 fixture 编译通过，不导入 Demo 内部。
- `flutter_widgets_native.test.ts`：真实 QuickJS 指针回调通过；FAB 禁用/恢复、Chip 与导航项选中颜色更新，进度实际 DrawOp 宽度从 50%→60%→70% 增长通过。
- 移除本轮业务 Mini Apps 页面后，重新构建当前 Showcase：243,948 字节 qjbc、334,112 字节 PAK；架构边界检查通过。
