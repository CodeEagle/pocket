# 旧 `native/` 能力审计（排除 `pocket_host`）

审查对象是
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/native/` 的
`pocket_runtime_multi.{h,c}`、旧 Dart FFI 绑定和它们的直接调用链。这里的“可迁移”
只表示设计或契约有复用价值，不表示旧实现可以直接成为当前 SDK 的 runtime。
旧库是一个单文件 C 状态模拟器：`CMakeLists.txt` 只编译
`pocket_runtime_multi.c`，没有 QuickJS、PocketJS core、Rapier 或真实平台插件链接。

## 逐项矩阵

| 旧能力与证据 | 旧代码实际做什么 | 当前 SDK 状态 | 结论 |
| --- | --- | --- | --- |
| Host/sandbox/prewarm：`h:107-130`，`c:143-224` | 16 个静态 `PocketSandbox` 槽位和 8 个整数 prewarm id；创建/销毁只是 `memset`，没有预热 QuickJS context。`suspended` 只阻止部分 C step。 | 一个 `HostState` 持有真实 `RquickjsGuest`；Flutter 生命周期在 `PocketView` 管理。 | 不迁移 C 状态机；可复用“加载/暂停/销毁”的生命周期测试场景。 |
| 内存 tier/off-heap：`h:118-130`，`c:226-304` | tier 只写预算字段；external buffer 用 `calloc/free` 和手工字节计数，没有分配登记、上限溢出保护或与 QuickJS GC/纹理表关联。 | Native 有 QuickJS heap/PAK admission，core 纹理拥有真实资源生命周期；不宣称进程隔离。 | 不迁移固定 tier；若未来做预算，围绕真实 guest/core 资源设计计量。 |
| Watchdog/frame/dirty：`h:132-150`，`c:306-365` | watchdog 只是 `elapsed_seconds > 5` 的返回值；frame step 清空 C draw buffer，`delta_seconds` 不参与 guest 执行；dirty mask 是手工位图。 | Native 使用固定 tick、真实 guest frame、DrawList cache/delta ABI。 | 可复用 dirty/idle 观测思路；不能把旧 watchdog 当中断，也不能覆盖现有 frame cache。 |
| 3D transform buffer：`h:163-176`，`c:368-434` | 256×12 `float` 数组，写入 entity/transform 后清 dirty 标记；没有 3D renderer、矩阵校验或 JS 执行。 | 当前 SDK 的真实 DrawList 是 2D/Surface 投影，尚无 Rapier/3D renderer。 | 明确列为能力缺口；不把共享 `Float32` buffer 当已完成 3D。 |
| 2D Canvas command buffer：`h:178-185`，`c:437-471` | 64KB C buffer，矩形/圆弧/线命令由 C 结构复制进去；只提供几个旧 opcode。 | 当前 SDK 直接消费上游 DrawList v1（10 类操作、clip、纹理/字体资源），由 Flutter painter 绘制。 | 不引入第二套 Canvas ABI；可复用“批量命令+容量上限”的压测思路。 |
| Collision/BLE queue：`h:187-194`，`c:473-517` | 碰撞只是外部传入的整数 pair 队列，不执行 Rapier；BLE 只是保存最后 64 字节并复制进出，不连接蓝牙。 | BLE/传感器/相机等走 `packages/pocket_hardware` 的真实 Flutter plugin provider。 | 排除旧 C；只复用长度/背压/错误用例。真实 BLE 需平台设备验收。 |
| SharedStore/VFS：`h:196-200`，`c:519-576` | 全局 64 项、固定 64/512 字节 JSON 表；通知计数没有 watch 回调。VFS 通过字符串拼接路径，`out_cap` 未验证截断，`app_id`/host path 也未做完整 canonical sandbox。 | 当前 SDK 没有把它作为 renderer 内置跨 guest 总线；包资源由 PAK/host admission 管理。 | 不迁移；若需要跨 guest store/VFS，单独设计权限、canonical path、容量和异步通知。 |
| 旧 UI/38 tags/liquid glass：`h:196-240`，`c:582-766` | 512 个 C 节点和属性 setter；默认 glass 参数、focus/modal/style 字段只是状态，不负责 layout、命中、绘制或 shader。 | 上游 PocketJS core/JS UI 负责 layout/tree；Flutter `PocketView` 绘制 DrawOps，Glass 走明确 surface/shader provider。 | 复用名称/验收场景，不迁 C `PocketUiNode` 或旧组件解释器。 |
| Video：`h:243-245`，`c:768-805` | 只按 `dt` 累加 `decoded_frame_index` 并计算 DPR 尺寸，没有解码器或纹理。 | `PocketView` 使用 `video_player` + 授权的 Flutter Texture provider。 | 当前 SDK 已有真实路径；旧计数器不再接入。 |
| Duplex ring：`h:83-96,232-235`，`c:802-864`，旧 Dart `ffi_bridge.dart:1200-1218,1897-2006` | 8,216B 固定布局，Dart `asTypedList` 直接映射 C 内嵌数组；旧 Dart 每帧调用 `duplexStepEcho`，C 只做固定变换，JS bundle 没有读写该 ring。游标是普通 `uint32_t`，没有 atomic/fence/owner guard。 | 当前 SDK 已在 `native/src/duplex.rs`、`native/src/lib.rs` 和 `packages/pocket_flutter/lib/src/pocket_duplex.dart` 实际接入：Dart ingress → owner-thread QuickJS `__pocketDuplexEvent` → JS `pocket.duplex.emit` → egress；ABI v2 使用两条原子 SPSC 队列。 | 这是唯一已经按最小范围迁入的 native 通讯能力。可称 Dart/native transport zero-copy；JS 侧是标量回调边界，不宣称 JS 直接持有 native 指针。队列数据路径为 lock-free，JS 执行与生命周期分配不在此保证内。 |
| YooAsset/version gate：`h:232-235`，`c:866-870` | 只比较 host/request 版本范围并返回 `-426`，没有读取 manifest、PAK 或 blob。 | 当前包 admission 校验 qjbc envelope、SHA、binding generation、tick、runtime ABI，并由 services 管理签名更新/rollback。 | 复用错误语义即可；不迁移旧 C gate 覆盖当前 package verifier。 |
| Router/page lifecycle：`h:236-255`，`c:876-1008` | 静态 16 层 page entry，push/pop 改状态位和 root id；转场进度固定 `dt*3.6`，没有 JS route、节点冻结或实际动画渲染。async result 只是 256 字节 JSON 槽。 | 当前页面/状态/转场由 JS/TSX；旧四种转场的纯数学 descriptor 已在 `packages/pocket_ui`。 | 复用 descriptor 和 lifecycle 用例；不迁 C navigator。异步 push-result 仍是缺口，不得标完成。 |
| Permission/hardware：`h:256-279`，`c:1010-1024` | `simulate_grant` 直接写状态，完全不触发系统授权。 | `packages/pocket_hardware` 通过 Flutter MethodChannel 接入 iOS/Android 真实能力，JS 只能经 capability/permission contract 请求。 | 旧函数明确排除；只保留权限枚举/拒绝测试的需求来源。 |
| Plugin registry/dependency/deep link：`h:281-330`，`c:1026-1213` | 固定插件名、版本和预设 sizeKB；tree-shake 是按 enabled 计数/估算；`plugin_invoke` 返回硬编码 BLE/link JSON，`args_json` 被忽略；deep link 只是把 URI 拷贝进 256 字节字段。 | `pocket_services` 有 descriptor、权限交集、预算、撤销、版本/manifest admission；硬件 plugin 由宿主编译注册。通用 URL ingress 仍需平台层补齐。 | 可迁移 schema/权限/disabled 场景；不迁固定结果、sizeKB 估算或旧 C invoke。Deep link 作为独立 P1 平台 ingress。 |
| Syslib AOT/update/rollback：`h:292-324`，`c:1215-1365` | 只有 16 项 metadata 表；“SHA”只检查字符串长度≥6，hot update 直接替换版本/字符串，rollback 只回填旧字段，没有 payload 验证、执行或原子指针。 | 当前使用 pinned QuickJS qjbc + PAK，native envelope 做 digest/ABI 校验，services 做签名版本检查和 verified rollback。 | 完全排除旧 C OTA；当前 qjbc/PAK pipeline 是唯一发行路径。 |

行号以旧文件当前版本为准；`h:` 是 `pocket_runtime_multi.h`，`c:` 是
`pocket_runtime_multi.c`。旧文件中的“lock-free”“Rapier”“120FPS”“AOT”等注释不是
执行证据，必须以调用链和真实平台 provider 为准。

## 已实施的 duplex 最小接入

生产入口如下：

- Native ring/layout：`sdk/native/src/duplex.rs`。
- Native owner-thread bridge：`sdk/native/src/lib.rs` 的
  channel/endpoint 的 acquire、reserve/commit、peek/consume、`pocket_duplex_step`、`pocket.duplex.emit` 和
  `__pocketDuplexEvent`。
- Flutter SDK 公共 API：`sdk/packages/pocket_flutter/lib/src/pocket_duplex.dart`，由
  `pocket_flutter.dart` 导出；`FfiPocketRuntime` 通过可选符号实现
  `PocketBinaryDuplexRuntime`。

ABI v2 不再暴露可写 header；Dart 仅映射 native reserve/peek 授予的 payload。
独立 Arc endpoint 保持存储存活，reload 关闭旧 generation 后另建通道，禁止原地清空活跃游标。
两条 SPSC 使用 acquire/release 发布；已预留批次可在 close 后完成，新预留失败。
Native callback 先执行 JS，成功后才提交 ingress 游标；没有 callback 或 callback 抛错
不会静默丢当前记录。完整并发约束见 [DUPLEX_TRANSPORT.md](DUPLEX_TRANSPORT.md)。

验证：

```text
cargo test --locked --lib smoke_tests::binary_duplex_reaches_quickjs_and_returns_without_json
cargo test --locked --test duplex_layout
flutter test test/pocket_duplex_test.dart  # sdk/packages/pocket_flutter
```

`cargo test --lib` 还包含三个需要外部 `POCKET_TEST_SOURCE`/`POCKET_TEST_ASSETS` 的既有
package fixture；未设置变量时这三个既有测试会失败，duplex 相关测试不受影响。

## 集成顺序

1. 保持 ABI v2 的 SPSC 角色独占、原子发布和 owner-thread JS 约束；不共享同一个
   endpoint 给多个生产者。跨 isolate 需要显式所有权协议，不能传递外部 Uint8List。
2. 补通用 deep-link platform ingress（iOS cold/warm、Android intent、退订），由 JS
   route reducer 消费，不把 URI 状态塞进 renderer。
3. 将旧 plugin schema/manifest 作为构建期校验输入，继续由实际 Flutter plugin registry
   提供能力；禁止用旧 `plugin_invoke` 的固定 JSON 作为真机能力。
4. 3D/physics/跨 guest store/VFS/异步 router 属于新能力工程，需要真实实现和单独验收，
   不能以旧 C 字段或 demo 页面计数器标记完成。
