# e06720e 修复复审与后续修复验收

本次先独立复审 `e06720e5ab88e9ff211d3eedfe2d768cb77a004b`，对照
`de8b051d3d87829ce25f50c021b74c0a11b7d6c8`、早期基线 `bee700ebce1d044cfa27ad31c39e7e0f05bca149`
和 `POCKET_SDK_AUDIT_REPORT_de8b051.md`。随后依据用户明确授权，派遣六个
GPT-5.6-Luna / Max 子代理执行五项残余缺陷修复及消融；总负责人整合、复核并串行运行 Flutter。

## 结论与快照边界

**原始 e06720e 未完全达到合入标准。** 原报告的大部分问题已修复，但首个可见帧失败唤醒、
Offload 回复排空后的唤醒重武装、零 tick 模拟摇杆输入仍有 P1 残余；Worker HTTP 总预算、
微信销毁重入仍有 P2 残余。已有测试全绿不能证明这些缺陷闭环。

**本轮工作区修复已通过下述提交前本机验收。** 五项残余均有针对性运行证据，
没有在已执行范围内确认新的阻断缺陷。不能把工作区修复后的结果归给原始 e06720e，
也不能把 CLI/FFI/Node 结果当成微信真机或 Flutter 设备集成验收。

- 原始目标隔离目录：`/tmp/pocket-remediation-e06720e`；证据：`/tmp/pocket-remediation-logs/`。
- 修复合并验证目录：`/tmp/pocket-fix-verify`；最终证据：`/tmp/pocket-fix-e06720e/`。
- 正式工作区原有并行改动先保存到 `preexisting.patch` 与 `preexisting-status.txt`，没有回滚。
  合并验证包含捕获时已有的 UI/性能改动，因此最终测试数量与原始目标不同。
- Demo QJBC/PAK 重建在隔离目录执行。没有用隔离目录产物覆盖正式工作区的既有资产。
  验证期间另有并行编辑 `demo/integration_test/showcase_mobile_test.dart`；该后续编辑不属于本轮修复，
  设备集成测试也不在已执行证据中。

## 原报告逐项复核

以下行号指本轮最终源码；删除项给出替代入口。表中“目标状态”评价原始 e06720e，
“本轮结果”评价此次未提交修复。已彻底修复指列出的代码缺陷，不表示所有设备场景均已验收。

| 原报告项 | e06720e 目标状态 | 本轮结果及代码、运行证据 |
|---|---|---|
| P0-1 Showcase 能力声明 | 已彻底修复 | `demo/js/manifest.json:50`、`demo/assets/guest-manifest.json:50` 声明 `system.runtime.awaitFirstFrame`；`demo/lib/main.dart:23` 增加 compositor 能力。真实 `showcase_admission_test.dart` 通过。`sdk/scripts/flutter_target.ts:65` 保留仅 SystemUI 的 role capability；额外负向探针证明普通 profile 子应用声明 compositor 被拒，见 `compositor-isolation.log`。 |
| P0-2 CLI / Editor Worker 产物 | 已彻底修复 | `sdk/pocket.ts:630`、`:653` 和 `sdk/editor/server.ts:748` 拷贝两份 Worker 文件；`:839` 允许读取。`sdk/scripts/build_guest.ts:553`、`:555` 写 worker 元数据，`:574` 保留 domains/描述符/权限。原目标 CLI 与 Editor 真实构建探针均退出 0，见 `cli_worker_repro.log`、`editor_worker_repro.log`；最终 build_guest、package_update、Worker fixture/Session 测试通过。 |
| P1-1 未闭合 turn / Worker 异常回放 | 已彻底修复 | `sdk/native/src/worker_trace.rs:719` 校验未消费事件及活动 turn；`replay.rs:398` 在 prepare stop 之前校验；`lib.rs:734` 的 `stop_worker_checked` 在 join 后检查 `runtime.last_error()`。`sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart:2935` 拒绝嵌套 begin、孤立 end、尾部未闭合 turn。原目标及最终真实 Worker 录音篡改探针均拒绝三种篡改，最终 `worker-tamper-final.log` 2 通过。 |
| P1-2 Record captureStop 切分 | 已彻底修复 | `sdk/native/src/worker_trace.rs:604` 在 Record 模式等待活动 turn 排空，超时标 incomplete；相关 Record cut/timeout Rust 测试及真实 `recording_worker_ffi_test.dart` 通过。最终消融保留 `replay.rs:516` 先关闭 Worker batch 再传播 clock quota failure 的顺序。 |
| P1-3 微信空闲时钟与 scale | 已彻底修复 | `sdk/targets/wechat/template/wechat-host.js:230`、`:275` 按实际经过时间跳帧，schedule 注册时不提前跳；`:146` resize 保留启动 scale。原目标探针得到 `skipAtSchedule=[]`、提前唤醒只推进 1 帧、scale=2；最终 lifecycle 测试保留 scale/hide/show 回归。仅 Node/Bun 证据。 |
| P1-4 awaitFirstFrame / isPresented | 部分修复 | 目标已要求首帧且 compositor 可见，但 Offstage 已产帧后失败不会拒绝 visible waiter。本轮在 `sdk/lib/src/pocket_system_host.dart:1239` 将失败拒绝移出 `!hasEverProducedFrame` 分支，已修复该残余。真实宿主 FFI 回归验证失败拒绝、等待中销毁、重建；旧逻辑消融因 TimeoutException 失败，修复逻辑通过。SystemUI 是 compositor 根，`isPresented=true` 语义保留并说明于 `:1379`；现有并行集成断言已使用此语义，未运行设备集成。 |
| P1-5 Offload 重武装 / 排空 | 部分修复 | 目标已修复 request/cancel 两队列排空及 Dart 各自 256 计数、二次取消排空；仍漏掉最后 reply 消费。本轮 `sdk/native/src/offload.rs:590`、`:609`、`:1257` 在同锁下检查三队列并重武装，已修复。原 FFI notify_count=2，修复后=3；新增 Rust 回归覆盖后续 submit、cancel、多回复及陈旧回复。Dart 入口 `pocket_offload_binding.dart:157` 保留。 |
| P1-6 按需调度 / 零 tick / 空闲时间 | 部分修复 | 目标的 `demand.rs:101` 等已覆盖轴、motion、连续工作，idle credit 消费逻辑及补丁 `bindDpadScroll` 已修复；但零 tick GuestFrame 仍漏模拟摇杆及回中。本轮 `sdk/native/src/lib.rs:1730`、`:1776` 复用 external_work_pending，`:2224` 包含双摇杆，已修复。真实 QuickJS 回归验证左/右样本、回中恰好一次、不额外推进虚拟时间。`pocket_view.dart:1025` 保留 resize 唤醒。 |
| P2-1 asyncStop / io.fact 交错 | 已彻底修复 | `sdk/native/src/worker_trace.rs:68` 将离线 io.fact 交由 Worker 消费，`worker.rs:1905`、`:2802` 按全局顺序注入，等待时不越过其他 Actor。Rust 交错/stop 回归及真实 Worker+HTTP 离线回放通过。 |
| P2-2 System LRU / 取消 / 栈回退 | 已彻底修复 | `sdk/packages/pocket_ui/src/system.ts:1235` 保护已呈现分屏实例；`:1267` destroy 清理 presented ids；`:1343` 允许后台调用父取消自己的调用；`:1419` 向仍存活外部调用方投递取消。最终 system_kernel Bun 测试通过，包含子调用方 cancel 与分屏 LRU 场景。 |
| P2-3 Worker / Dart HTTP | 部分修复 | 目标已修复 Dart `pocket_offload_runtime.dart:321` 的 openUrl 后取消检查、`:342` 自定义 Content-Type、`:365` 跨源敏感头和 `:382` 改为 GET 的实体头清理；Worker 已每跳计算剩余预算，但一次阻塞 body read 仍可越界。本轮 `sdk/native/src/worker.rs:3501` 同时设置 ureq overall timeout，已修复该传输阶段残余；延迟 headers+body 与重定向累计耗时两项回归通过。DNS 不可中断的 ureq 边界单独保留在模块文档。 |
| P2-4 Session runtimeInfo / Worker 版本 | 已彻底修复 | `sdk/lib/src/pocket_session.dart:237` 返回 active/embedded Worker；`:393` 使用独立 Worker expectedTickHz，bindingGeneration 使用对应描述符。真实 OTA/Session/Worker 准入测试通过。 |
| P2-5 微信 cleanup / 初始化 resize | 部分修复 | 目标已缓存启动中的 window/keyboard 变化并在 `pages/index/index.js:82` 补发 resize，但 dispose 取消时仍可重入新请求。本轮 `wechat-host.js:346` 关闭请求准入，`:642` 在 abort 前设置既有 disposed，隔离每项 abort 异常，finally 先释放引用再 native destroy，已修复。旧模板 2 通过/3 失败，修复模板 5 通过。 |
| P2-6 子 viewport | 已彻底修复 | `sdk/lib/src/pocket_system_host.dart:333` 不再传显式 viewport，走 `pocket_view.dart:2273` 的自动视口；`demo/integration_test/guest_interaction_test.dart:49` 优先选择 inputEnabled PocketView，支持多实例。Flutter compositor/input/view 测试通过；设备键盘集成未运行。 |
| P3-1 surface 焦点 / align | 已彻底修复 | `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:2205` 排除零尺寸及裁剪后不可见 application surface；`pocket_model.dart:121` JSON 和 `:688` 二进制均拒绝超出 0..2 的 align。最终模型、合成及输入测试通过。 |
| P3-2 mini-app target / 文档 | 已彻底修复 | `demo/js/scripts/build_mini_apps.ts:15` 在 resolveSystemDocument 显式选 `pocket-flutter`；validateSystemFile 仅做 schema 校验，不应向它添加无效 target。该构建路径已由 test_guest 实际重建并执行；对应 compositor 文档已经修正。此次移除 buildGuest 无消费者的 target 参数，保留真正的平台 resolve。 |

## 残余问题的触发与修复依据

1. **P1：Offload 回复消耗后丢失下一次通知。** provider 已取走 request、完成后仅 replies 非空，
   Dart 回调消费完 reply 后 wake_pending 仍为 true，下一 submit/cancel 被合并。原真实 FFI
   `notify_count=2`；修复后 `=3`。最小修复是消费最后 reply 时复用三队列判空与同锁重武装，
   没有新增轮询或第二个通知状态。
2. **P1：Offstage 已产帧后失败，openApp 等待队列挂起。** failure 被放在 hasEverProducedFrame 分支之外，
   但 visible waiter 只在首次产帧前拒绝，JS 串行事务队列不能及时处理 failed 事件。原链路探针显示
   等待期间 destroys=0；本轮真实宿主测试以相同前提复现，旧逻辑抛 TimeoutException，修复后直接得到运行失败。
3. **P1：零 delta 帧漏模拟摇杆及回中。** demand capture 知道有模拟输入，实际零 tick GuestFrame 判定却漏掉它，
   原 FFI `analog_zero_events=0`、下一 tick 才 `=1`。修复复用已有 one-shot external work 标记，不增加时钟推进。
4. **P2：Worker HTTP body 阶段可跨总截止时间。** 单次读 timeout 不等于完整请求 timeout；原传输探针
   300ms 预算下读完一个字节已耗 571ms。受控消融 old agent 492ms 后仍 Ok(1)，fixed agent 301ms 超时。
   修复保留每跳绝对 deadline，仅补全 pinned ureq 的 overall timeout。
5. **P2：微信 dispose 重入泄漏请求。** abort/取消响应同步发出新请求时，disposed 尚未设定，原探针
   得到 `reentrantPendingAfterDispose=["reentrant"]`。修复在任何 abort 前关闭准入；provider abort 或 native destroy
   抛异常后仍释放引用。没有新增 disposing 状态或 response 兼容重载。

## 消融项

| 原报告项 | e06720e | 本轮结果 |
|---|---|---|
| 重复 wasm-shim.c | 已彻底修复 | 保持删除；build_wechat 仍从固定并校验的上游支持源码构建。 |
| scalar TraceClock ABI / last_* | 未修复 | 已彻底修复：删除旧 begin/end/last getter，`sdk/native/src/replay.rs:498` 直接返回 transient envelope；Worker/offload v2 空轨道及 quota 清理顺序保留。 |
| PocketRecordingLimitException | 未修复 | 已彻底修复：删除无构造/捕获的类型及导出，quota 仍通过 incomplete 表达。 |
| recording 别名 | 未修复 | 部分修复：删除零调用 completed；recordedBytes/stop 有现存公共消费者，保留，避免为删别名强迫消费者迁移。 |
| duplex 空桩 / ABI 包装 | 未修复 | 已彻底修复：删除恒空 get_ring 与 actual_abi 别名；Dart/probe/bench 使用 canonical runtime_abi。 |
| Demo host barrel / 配置复制 | 未修复 | 已彻底修复：删除 demo/js/host.ts，直接导入 @pocket/ui/host；`sdk/lib/src/pocket_config.dart:112` 保留单一字段复制边界。 |

删除导出是明确的接口收缩：若仓外消费者调用旧 C ABI、`PocketRecordingLimitException`、`completed`
或旧 buildGuest 字符串重载，需要迁移至 canonical API。仓内调用扫描、构建和真实 FFI 均通过，
但不能据此推断仓外调用不存在。模块出处、保留行为和取舍见六份 `REMEDIATION_*.md`。

## 最终命令与真实计数

工作目录均为 `/tmp/pocket-fix-verify` 下对应项目，原始目标的同类记录另保留在
`/tmp/pocket-remediation-logs/`。Flutter 严格串行。测试环境为：

```sh
export CARGO_TARGET_DIR=/Volumes/ORICO/Development/Github/pocket/sdk/native/target
export POCKET_NATIVE_LIBRARY=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/debug/libpocket_flutter.dylib
export POCKET_RECORDING_WORKER_FIXTURE_DIR=/tmp/pocket-worker-fixture-fixed
export POCKET_NATIVE_PROBE=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/debug/pocket_probe
export TMPDIR=/tmp
```

| 实际命令 | 最终结果 | 日志（位于 /tmp/pocket-fix-e06720e/） |
|---|---|---|
| `cargo build --locked --manifest-path sdk/native/Cargo.toml` | PASS | cargo-build.log |
| `cargo test --locked --manifest-path sdk/native/Cargo.toml` | 82 passed / 0 failed / 1 ignored（手动吞吐基准） | cargo-test.log |
| `python3 sdk/scripts/prepare_upstream.py --verify-only` | PASS，固定 revision 99924de47c62fa36f526a8791055d91cbbdb3836 | upstream.log |
| `python3 sdk/scripts/check_architecture.py` | PASS | architecture.log |
| `bun sdk/scripts/tests/worker_recording_fixture.ts /tmp/pocket-worker-fixture-fixed` | PASS，生成真实 UI/Worker QJBC 和 pak | worker-fixture.log |
| `(cd sdk && bun test)` | 76 passed / 0 failed | bun-sdk.log |
| `(cd demo/js && bun test)` | 14 passed / 0 failed | bun-demo-serial.log |
| `POCKET_NATIVE_PROBE=.../pocket_probe bash demo/js/scripts/test_guest.sh`（从 demo/js 执行 `bash scripts/test_guest.sh`） | PASS，真实 QJBC 篡改影响首帧；pointer/input/host response/stress 通过 | guest.log |
| pocket_services `flutter analyze --no-pub` / `flutter test --no-pub --concurrency=1 --reporter expanded` | analyze 0 issues；27 passed / 0 failed / 0 skipped | flutter-services-*.log |
| pocket_hardware 同上两命令 | analyze 0 issues；test exit 1：`Test directory "test" not found.`，没有可执行测试 | flutter-hardware-*.log |
| pocket_flutter 同上两命令 | analyze 0 issues；116 passed / 0 failed / 0 skipped | flutter-flutter-*.log |
| sdk 同上两命令 | analyze 最终 0 issues；62 passed / 0 failed / 0 skipped | flutter-sdk-analyze-final.log、flutter-sdk-test.log |
| demo 同上两命令 | analyze 0 issues；27 passed / 0 failed / 0 skipped | flutter-demo-*.log |
| `flutter test --no-pub --concurrency=1 --reporter expanded /tmp/pocket-review-worker-tamper_test.dart`（sdk） | 额外 2 passed；截断、嵌套 begin、孤立 end 均拒绝 | worker-tamper-final.log |
| `bun /tmp/pocket-fix-e06720e/compositor-isolation.ts` | PASS，root admitted，普通子应用 compositor 越权拒绝 | compositor-isolation.log |
| `git diff --check` | PASS | 命令输出为空，exit 0 |

主测试矩阵合计 **404 passed / 0 failed，Rust 1 ignored**，不重复累加额外篡改和 focused/ablation 测试。
Flutter 232 项、Worker FFI/Session 零跳过。hardware 的测试命令是一个明确的不可执行项，
不是通过，也没有伪造测试补足数量。

保留失败证据：两套 Bun 最初并行构建上游依赖发生安装链接 EEXIST，串行重跑后通过；
新宿主测试初次 analyze 报多余 import 和未使用变量，清理后复跑 0 issues；
旧逻辑消融测试按预期失败。这些记录没有被最终成功日志覆盖。

本轮独立复审没有执行微信 DevTools/真机或 Flutter 设备集成测试；没有启动浏览器、停止现有服务或读取私钥。
后续用户授权的提交整合及 argon 并行模拟器记录，见 `COMBINED_REVIEW_HANDOFF_e06720e.md`。
原目标不能因后续修复而被标记为已通过合入门禁。
