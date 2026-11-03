# JS SystemUI 多应用平台

2026-11-03。本轮目标是保留 PocketJS 的 JS-owned 架构，在真实 QJBC/PAK、独立 QuickJS realm、现有更新/插件/按需调度上补应用协作。来源审查见 [MINI_APP_PLATFORM_PARITY.md](MINI_APP_PLATFORM_PARITY.md)。实施由 GPT-6 Luna / max 子代理分别负责 JS 内核、Flutter 实例通道、官方 System manifest 校验，主代理负责消费端、消融和实际运行验收。

## 来源与边界

固定上游 revision 为 `99924de47c62fa36f526a8791055d91cbbdb3836`。官方 `contracts/spec/pocket-system.ts` 定义 `PocketSystemV1`：`roles.systemUI`、`applications.catalog`、安装快照和后台执行政策。`framework/src/manifest/system.ts` 负责 System plan 准入；`programs/web/system-engine.js` 使用独立 realm、child map 和显式 surface reconciliation。SystemUI 是包的角色，不是一种 Dart 页面。

保留旧 Flutter demo 的 `lib/core/pocketjs_bundle_runner.dart` 有应用表、切换和结果，但由 Dart 持有业务状态；`native/pocket_runtime_multi.c` 的预热/冻结只是静态状态模拟。旧工程没有完整接通官方 SystemUI。复用其交互需求和关闭/恢复场景，运行底座继续使用当前 SDK 的真实 QuickJS。SDK 不从旧仓库加载源码或资源。

Flutter 目前没有正式 target profile 和动态 child `CompositorSurface` 接线。因此本轮的全屏应用呈现适配器不声称等价于官方 Web/桌面完整 System compositor。构建工具可以验证官方 System manifest；只有真实 target registry 满足要求时才能得到官方 `ResolvedSystemPlan`，不能借 Web profile 冒充 Flutter 支持。嵌入任意子 surface、focus projection、桌面窗口合成仍需后续原生适配。

## 唯一的策略所有者

JS SystemUI 中的 SDK 内核维护应用注册表、打开调用链、结果 token、生命周期决策、预热/LRU 和消息邮箱。普通小程序用 `@pocket/ui/platform` 发起打开/返回、存储与消息；SystemUI 用 `@pocket/ui/system` 安装内核。它们共享已有 HostBridge，不新增运行时或轮询总线。

Flutter 的 `PocketSystemHost` 只持有由可信消费工程指定的 appId→构建资源映射，以及 opaque 实例、generation 和待完成 RPC 的传输事实。它提供 create/present/destroy/post/respond 与存储 IO；不选择返回目标、维护应用栈、生成结果 token 或决定淘汰对象。身份取自发起请求的实例，Guest 参数不能冒充 caller。只有固定 SystemUI 实例可以调用 `system.*`。

曾尝试的 Dart manager/stack 已撤出。Dart 消息邮箱也删除，只保留持久 KV、IO 串行化、配额与共享区域的宿主授权上限，避免 JS/Dart 两套平台状态。

## 运行契约

- SystemUI 是已存在的控制 realm，`configure` 返回它的 instanceId；内核不能再 create 一个 SystemUI。同一 appId 至多一个驻留实例。
- 默认最多三个驻留实例，**包含 SystemUI**。预热也计入上限；只能淘汰没有活跃调用链引用、非前台的实例，无候选时拒绝。宿主另有更高的硬性实例上限作为资源防御，不替 JS 自动淘汰。
- JS 显式提交要呈现的实例列表。普通隐藏实例停止 ticker/deadline，暂停虚拟时钟与前台硬件；恢复不补算隐藏时长。SystemUI 即使 UI 不可见也保留控制事件处理能力，但没有工作时照常停表。默认支持 `backgroundExecution: "suspend"`，不把未实现的 `continue` 伪装为可用。
- `open` RPC 立即返回 token；最终结果通过 `platform.result` 事件投递，避免一次跨 App 交互占用整个请求超时。返回、取消、启动失败、关闭都只结算一次。循环调用、失效 generation、后台 caller 和无权限目标必须拒绝。
- JS 所有策略变更及 runtime failure 经过同一串行队列；嵌套步骤使用内部操作，不能在同一队列中等待再次入队而死锁。
- JSON payload 做独立快照，单值上限 64KiB；邮箱上限 32。消息 source/target、共享 namespace 和可打开目标由 JS ACL 校验；存储再经过可信宿主 IO grant 上限。隐藏接收者的消息不会强制恢复其 UI。
- 原生通道保留已有 PFB1 绘制二进制和 SPSC pointer duplex。平台低频控制消息复用有界 RPC JSON，不把应用策略放入原生绘制层。

## 实施和验收顺序

1. 先核查旧 demo 和固定上游，明确能保留的行为、真正缺失的 host 接线；禁止第二套 C/VDOM runtime。
2. 校验官方 System manifest 与 package identity，明确 catalog、installed、required、SystemUI role 的关系；ACL 单独配置。
3. 独立验证 JS 内核的 A→B→C 结果/取消/失败、并发串行化、后台拒绝、快照/邮箱上限、预热和 LRU，不依赖 Flutter 假页面。
4. 验证薄宿主真实首帧才完成 create、隐藏实例不连续推进、generation 关闭取消请求、只有 SystemUI 能调用管理 primitive。
5. Showcase、Profile、Lobby 都构建为真实 QJBC/PAK；用实际输入完成共享身份、嵌套打开、消息和返回。对比不预热与预热时 create 次数、打开时延和驻留上限；检查隐藏实例 tick，不以画面截图代替行为。
6. 顺序运行 JS、SDK/桥接/服务 Flutter 测试与静态检查，运行 Duo 集成场景；任何未运行或失败证据必须保留并说明，不能把模拟 primitive 单测当真机证明。

FPS 采样与历史不裁到 60；90/120/144Hz 的值按实际记录，图表按数据/刷新率缩放。按需停表后的静态页面没有连续 FPS，输入响应时延与持续动画 FPS 分别评价。模拟器结果不能替代设备 Energy Log 或高刷新率真机数据。

## 实际运行与消融

2026-11-03 在 iPhone Duo Simulator 上运行真实 QJBC/PAK 的 `demo/integration_test/multi_app_test.dart`，三个业务 case 通过：

| 场景 | 实际验证 |
| --- | --- |
| Showcase → Profile → Lobby → 返回 | 实际 pointer 输入、嵌套结果只结算一次、共享 identity、独立消息；根页面计数状态保留，隐藏 Profile 的 ticker 停止。 |
| 冷启动与预热 | 预热获得真实首帧；再次打开复用同一 Session/instanceId，驻留数包含 SystemUI 且不超限；关闭后 generation 不复活。 |
| 故障清理 | 通过现有 Session `onError` 回调注入运行错误，验证子实例释放 native slot、可重新创建；SystemUI owner 失败会退役其子实例。这不是在 guest 中实际执行 throw 的覆盖。 |

冷启动/预热打开在最后一次 debug 模拟器运行分别约 203ms/105ms，`residents=2, reused=true`；另一次为 331ms/200ms。等待观测粒度约 30ms，这些单次值不能当稳定性能收益或真机能耗结论。消融的功能证据是预热后复用真实实例，而非重新创建。

真实运行还暴露了单测未捕获的 Promise 续体停滞：`host.response` 已投递，但 idle 时间抵扣后的下一边界为零 tick，尚未排空的 QuickJS job 未进入需求提示。已在原 scheduler 添加 pending-job 事实，保持唤醒直到下一真实 fixed tick 走原有 `Guest::frame → collect`；不虚构 tick，不增加第二事件循环。修复后上述三个 case 以及真实系统键盘的一项生命周期/滚动场景均通过。

复现命令（将设备 ID 替换为本机已启动模拟器）：

```sh
cd demo
flutter drive --no-pub --no-dds \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/multi_app_test.dart \
  -d DEVICE_ID
```

本轮完整命令和分层结果见 [VALIDATION.md](VALIDATION.md)。JS 协议 fixture、宿主 shape/admission 单测与上述实际设备交互分别覆盖不同边界，不互相冒充。
