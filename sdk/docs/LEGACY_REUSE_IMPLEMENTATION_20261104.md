# 旧能力补齐实施记录

来源评估：[2026-11-03 复核](LEGACY_REUSE_REVIEW_20261103.md)。

本轮实施 A1 Deep Link（用户要求可选）、A2 插件类型生成、A3 系统栏、A4 触觉，以及 B1/B2 硬件持续流与 BLE GATT。纯数学 / 数据工具按消费者需要再迁；完整 3D、VFS、独立 syslib OTA、微信多 Guest 和全 App 合计资源预算不在本轮实现范围。

## 边界

- Deep Link 默认关闭。标准 SDK / 标准脚手架不强制依赖平台体验包、不注册 URL scheme。消费工程显式接入后才开启，能力只放 manifest optional；关闭时没有链接收集、后台监听或定时查询。
- JS 管理页面、路由、订阅与展示；平台包仅承接 URL 事实、系统栏和触觉 IO。硬件仍使用已注册 provider 与真实权限模型。
- 复用当前 HostBridge、PocketStreamBridge 和二进制通道，不增加事件总线、轮询器或另一个 Dart 页面状态机。
- 不复制旧模拟 runtime、假成功硬件数据、伪 AOT 或估算 tree-shake。

## 分工

| 工作 | 所有权 | 执行 |
| --- | --- | --- |
| 平台体验 provider / iOS / Android | `packages/pocket_platform/` | Luna Max / ui_foundations |
| JS stream adapter / 平台体验 API | `packages/pocket_ui/src/host.ts`、新增 streams / platform-experience 子路径 | Luna Max / ui_secondary_pages |
| 类型 schema / 生成器 | services 的 descriptor schema、新 `scripts/plugin_types.ts` | Luna Max / ui_fps_badge |
| 真实硬件持续流 / GATT | hardware Dart/iOS 与 Android 分开所有权 | Luna Max / hardware_stream_ios、hardware_stream_android、android_stream_cleanup |
| 集成 / 脚手架 / 消费示例 / 验收 | 主代理 | 不覆盖之前的 UI / 内存和并行改动 |

所有子任务禁止继续派生代理。

## 验证记录

持续流接入前复核发现既有通道存在双向监听冲突、远端取消未处理异常、provider 错误被当作正常结束、撤销仅通知远端而未释放本地 producer 的问题。使用现有事件 wire 修复，不引入替代通道。

- `flutter test test/pocket_host_stream_test.dart`（services）：6 项通过，覆盖双向接收、取消释放、异步错误、同步抛错、选择性撤销与销毁、非 JSON 输出。
- 消融：在 `/tmp` 用本轮前 HEAD 的 `pocket_host.dart` 执行相同 6 项回归，6 项全部失败；替换为修复后的通道全部通过。清除了重复事件转发和按 JSON 内容去重的逻辑，连续相同传感器 payload 仍应各收到一次。本消融证明协议正确性，不是 FPS/功耗测量。

## 已接入的消费者路径

| 能力 | SDK 入口 | 消费方式 |
| --- | --- | --- |
| 可选 Deep Link | `pocket_platform`、`pocket.ts init --deep-link-scheme=SCHEME` | 双层原生/Dart opt-in；JS 显式 initial/latest/subscribe，无默认路由或监听 |
| 系统栏与触觉 | `pocket_platform`、`@pocket/ui/platform-experience` | Showcase 在 JS route/theme 变化时设置系统栏；Hardware 页面显式触觉测试 |
| 插件类型 | `PocketPluginSchema`、`pocket.ts types` | 数据 schema + 实际 host registry，生成既有 HostBridge/stream adapter 客户端 |
| JS 持续流 | `@pocket/ui/streams` | 复用既有 wire，唯一 stream ID、有界缓冲/读取/并发、虚拟调度 deadline、取消释放 |
| Sensor / GATT | `pocket_hardware` | iOS Core Motion/CoreBluetooth；Android SensorEventListener/BluetoothGatt；JS Hardware 页面显式开始/停止、选 characteristic 读/写/通知 |

默认 Showcase 没有 Deep Link manifest 能力或原生 URL 声明。`--platform-experience` 只打开系统栏/触觉。

## 验证闭环

- Services 全套 `flutter test --reporter expanded`：39 项通过。
- 新脚手架、生成器、JS streams、platform experience 四组 Bun 测试：21 项通过；另全套 JS UI 测试与 panel transport 测试 23 项通过。
- 真实 provider contract：通过 `demo/test/plugin_contract_export_test.dart` 从实际 HardwarePlugin、PocketPlatformPlugin、PocketHost/PocketPluginManager 导出 21 个注册能力，再执行 CLI 和严格 tsc；包含 array 的 BLE/sensor schema 与关闭时不存在的 links。该检查发现并修复 readonly array 不符合公共 JsonValue 约束的问题，不使用镜像 HostBridge 类型。
- `sdk/scripts/tests/streams_runtime.test.ts` 使用 buildGuest 生成真实 qjbc/PAK，pocket_probe 加载并执行 SDK 的 HostBridge/stream/platform client，验证重复样本、stream error/cancel、idle 后响应、optional links 拒绝及后续真实绘制。
- 普通 Showcase iOS simulator build、Android `:pocket_platform:compileDebugKotlin :pocket_hardware:compileDebugKotlin`、Demo analyze 已通过；Swift parse 不能代替 Xcode typecheck，本轮真实构建已发现并修复 String?/NSNull 类型错误。
- SDK `flutter test --reporter expanded`：67 项通过、4 项因缺少专项 runtime/Worker fixture 跳过；SDK analyze 通过。新可选包须在自身目录先 `flutter pub get`，无需为了分析而把它加入核心 SDK 依赖。
- 平台包 `flutter test`：8 项通过，覆盖默认 native 零调用、短窗口去重与重复打开、单 links owner、迟到激活清理、真实系统栏 base 恢复、单调时钟触觉限频与 schema。
- 独立 opt-in 消费工程 `/tmp/pocket-optin-20261104`：真实 `init --deep-link-scheme=pockettest`、buildGuest、iOS simulator 构建及 `flutter test integration_test/deeplink_test.dart -d 90B4AA40-E9B8-46B5-B70F-144ADEF9CB32` 通过。测试由主机 `xcrun simctl openurl` 注入 `pockettest://open/one`、窗口外再次相同 URL、`pockettest://open/two`，使用真实 JS SDK订阅并断言 DrawOps 文本 `events=1/2/3` 和 latest URI。初次 OS“打开应用”确认后重新运行通过；不是直接调用 Dart fake transport。此证据覆盖 warm URL 与重复 URL，不包含冷启动 URL 或 Android 设备验收。
- Demo 的 guest state、QuickJS ablation、native guest probe 全套脚本通过（复用当前 buildGuest 资产）；启动系统栏请求按真实 requestId 应答并校验 style，离屏区域先真实滚动再检查绘制。
- 全套 Demo `flutter test`：45 项通过；平台包 8 项、硬件包 8 项通过。JS SDK、脚手架、类型生成器与真实 bytecode stream probe 合并运行：33 项通过。另真实 Ruby 执行的 CocoaPods 输出声明和 scene patch 测试通过。

## 原生边界补强

- GATT read/write/CCCD 同一串行队列；断连与 timeout 先撤销队列和 producer，再完成请求，迟到回调按 operation/peripheral/characteristic identity 隔离。iOS 同一 characteristic 正在通知时 read 明确返回 busy，避免 CoreBluetooth 共用 callback 被误当作读结果。
- pending start 取消、CCCD enable/disable 失败、session dispose、scan/one-shot sensor timeout 均有 owner/generation 清理；guest stream ID 在原生侧加可信 session/provider 前缀。
- iOS manager/EventChannel 当前每进程仅支持单 FlutterEngine；多 JS app/session 使用同一引擎。未实现同进程更换引擎的 native sink 重绑，不宣称多 engine 已支持。
- 新独立工程首次 iOS 构建暴露 CocoaPods 1.16.2 将 static XCFramework 输出误登记为 `PocketFlutter.framework`、实际复制 `.a` 的问题。`patchIosMinimum` 在现有 Podfile 的受支持 post_install 中加入幂等输出修正；不增加第二个 copy phase，不绕过链接依赖。保留 consumer Ruby 逻辑；自定义 unsupported hook 在写文件前拒绝自动修改。清缓存首次构建验收见下方最终记录。

## 最终补强与验收

- 将可选 URL ingress 拆为独立 `PocketDeepLinkPlugin`（`flutter.links`，3 个 links 能力，background-safe）；`PocketPlatformPlugin` 只管理 foreground 系统栏/触觉。共用一套内部实现与现有 stream/controller 队列，不增加路由/录制/页面状态机。此拆分消除了后台撤销 UI 时同时丢失链接的路径。
- 最终 opt-in 模拟器测试四步通过：首次 warm URL、窗口外重复相同 URL、不同 URL、按系统 Home 回桌面后通过 URL 唤回，真实 JS DrawOps 的计数依次达到 1/2/3/4。复用原有订阅，后台唤回没有另造订阅恢复器。冷启动 URL 和 Android URL 交付仍未专项验收。
- `demo/integration_test/legacy_capabilities_test.dart` 最终通过：真实 JS 点击默认关闭的 links、触觉和系统栏；传感器流必须显示真实样本或结构化拒绝（先滚动到结果区域，不能把离屏 culling 当作无结果）；返回 Home 后计数正常，未产生 Guest exception。
- 硬件包最终全套 11 项通过。新增 300 条按序采样及 native stop 一次的真实 Host/PluginManager 回归，移除旧 provider 的 256 条短限制；沿用宿主累计事件预算（默认 10000）和 per-event bytes 限制，不自动重订阅或新增配额状态机。原生写入前还校验 iOS maximumWriteValueLength / canSendWriteWithoutResponse，未就绪明确 busy，由 JS 选择重试。
- 独立工程 `flutter clean` 后首次 `flutter build ios --simulator --debug` 一次通过（59.1s），验证修正后的 `.a` 输出依赖；最终普通 Showcase iOS 构建通过（39.4s）。Android 插件与 app Kotlin 编译通过；Android unit-test task 为 NO-SOURCE，不能计为真实 native 行为测试。
- 默认/experience-only/links 三种脚手架、scene patch、真实 Ruby 输出修正最终通过；source-only init 测试单独设 30s 文件 IO 预算，避免并行原生编译时触发 Bun 默认 5s 超时。
- SDK 与平台包最终 analyze 无问题，architecture boundary 与 diff whitespace 检查通过。临时消费工程/安装包已清理，普通 Showcase 已恢复到 iPhone 18 Pro 模拟器；小体积源码、日志保存在 ignored `.pocket-build/legacy-integration/`，无需保留临时编译缓存。

单测/模拟器不能代替实体 BLE 外设、真实传感器、触觉体感、高刷新率和功耗验收；本轮没有声称获得 FPS/能耗数值收益。
