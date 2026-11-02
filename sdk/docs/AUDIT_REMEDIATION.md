# a5dd273 审查修复记录

本轮与 Argon 隔离分工：Argon 负责 OTA/Store、Editor 安全、方法权限和 iOS 硬件 manager；本轮负责生产通道、二进制帧、调度、构建工具链、可选依赖与测试入口。这里的验证不替代 Argon 修改合并后的权限/更新全链路验收。

## 来源与消融

遵循薄宿主架构，参考保留工程（排除 pocket_host）：

- `pocketjs_flutter_demo/native/pocket_runtime_multi.c` 的 BinaryDrawCmd 说明紧凑数值传输的价值；仅参考传输思路，当前 PFB1 编码仍消费真实 PocketJS FrameOp，不迁入旧 C 状态数组、伪引擎或第二套布局。
- `pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_graphics.js` 的 SVG 规格继续保留。删除当前 SDK 中无人消费的 compute3dMechaFrame/compute2dParticleFrame、line/arc 命令类型及仅自测数学结果的测试；没有伪装为已集成渲染能力。
- 系统硬件实现仍在 pocket_hardware，消费工程通过已有 pluginFactories 注册，不再同时维护 enableHardware 开关与工厂两套注册机制。核心包依赖解析结果已验证不含 pocket_hardware，Showcase 显式依赖该插件。
- 历史 sdk/migrations 归档已被前序提交清理，当前不存在；来源文档与 AGENTS 已纠正，不再要求读取缺失归档。

## 已调整的接口

- 核心 pocket_sdk barrel 只导出应用入口、配置、会话、插件契约及必要 controller/event/duplex 类型。低层绘制与诊断从 pocket_flutter 显式导入。
- 硬件消费者移除 enableHardware，添加 pocket_hardware 依赖，并配置返回 HardwarePlugin 的顶层工厂。具体代码见 SDK_INTEGRATION.md 和 demo/lib/main.dart。
- 内置 metadata 的 version/build 进入 Session runtimeInfo/status，不能再将内置包报告为 build0。构建侧的来源与平台产物隔离见 TOOLCHAIN_NOTES.md。
- 新帧 ABI 使用紧凑二进制 DrawOp 与原始像素字节，Dart 立即复制借用 buffer 后解码。不是跨 runtime 生命周期持有原生像素指针，也不宣称整个渲染链零拷贝。旧 JSON ABI 保留用于明确的兼容/探针用途。

## 报告中需要纠正的判断

- P2-4 所述 patchIosSceneDelegate 与 PocketHardwareManager.handleIncomingDeepLink 不存在于 a5dd273。实际 patchIosSceneLifecycle 用于 Flutter scene 启动，不是 Deep Link 业务注入。不能据此删除启动兼容补丁或宣称已提供 Deep Link 能力。
- 仅因 Referrer-Policy=no-referrer 不能推导浏览器 POST 必定省略 Origin；Editor 仍应严格校验所有写入口，但具体浏览器攻击须实测。上一轮已实际证明的是另一个 loopback Origin 的 multipart 跨端口写入，此项交由 Argon 修复。
- 原生 SPSC 通道的零拷贝指的是预留槽位与原子游标的传输；指针兼容适配仍可能构造原有 JS 事件，不能宣传全链路零分配。

## 验证

默认 cargo test、默认 bun test、Flutter SDK/Showcase 单测与依赖图检查已执行；最终命令、数量与平台构建结果在本轮完成时追加。不会把未运行的真机硬件、IME 或性能测试记为通过。
