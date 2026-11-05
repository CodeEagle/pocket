# Video / Duo：Argon High 独立审查及主代理复核

日期：2026-11-04。原始审查结论：**暂不建议合入；需先修复播放协议和生命周期问题。**

下文保留修复前的证据和行号。最新修复验收见文末；不能把原始红测或既有 iOS 日志当作修复后的测试结果。

实际模型：`agy gemini-4-argon-high`，effort `high`；会话 `ae80b5ef-d033-44b1-ba5b-4e8b977641c7`。首轮读取权限未获准，未形成审查；正式审查达到 20 分钟上限，同会话收敛后返回完整报告。下列结论是主代理复核后的版本，不能用 Argon 原稿替代。

基准为 HEAD `c88c2496c95d44d57a73e45f7e676c09368902b4` 上的 **41 个当前工作区文件**，包含未跟踪的 media、Video 和测试代码。快照、SHA256、原始结果、复现脚本及日志保留在 `/tmp/pocket-argon-video-review-20261104/`。评审期间有并行漂移，其新增内容不属于本报告完整审查结论，详见末尾版本边界。评审没有修复正式源码、提交或改动 Git index。

## 已独立复现的问题

### P1：首次离屏挂载的暂停指令被丢弃，首次可见时自动播放

- 位置：`sdk/packages/pocket_flutter/lib/src/pocket_view.dart:2907`、`:4326`、`:3292`；`sdk/native/src/lib.rs:567`；`sdk/packages/pocket_ui/src/media.ts:154`。
- 触发：JS 注册暂停视频，但该视频首帧完全被滚动/转场裁剪，未输出 `PocketVideoOp`；之后首次进入视口。
- 根因：宿主仅根据可见 DrawOp 准入 ID，丢弃尚未准入 ID 的 `video.pause`。JS 已把暂停记为 applied，不重发；首次可见时宿主采用原生硬编码的 `autoplay=true`。JS 与真实播放器状态分裂，重复设置同一暂停状态也可能不再发送命令。
- 主代理临时测试：无视频 DrawOp 的帧先发送 `video.pause(hero)`，随后仅出现可见 VideoOp。实际调用包含 `play:1`；“不得播放”断言失败。
- 建议：合法且有界的注册/播放命令生命周期应独立于可见性；受 JS 管理的视频应默认不自动播放。修改默认值须明确兼容既有原始 surface 调用，不能仅用改默认值掩盖丢失的显式播放命令。
- 验收漏洞：真实 iOS Retry 测试放行 `playing` 作为加载恢复成功，却未断言 `playing={false}` 对应的原生播放器仍暂停。此前报告“测试通过”不能证明这个边界正确；这条验收确实漏检了问题。

### P1：128 上限实际累计整个 PocketView 生命周期，释放旧视频后仍不能加载第 129 个 ID

- 位置：`pocket_view.dart:3076`（`_admitVideoId`）、`:3123`（`_releaseVideoPermanently`）。此项由主代理复核补充，Argon 原稿遗漏。
- 触发：同一个长驻宿主逐个展示并永久释放不同 ID，例如长视频 Feed；同时最多只有一个视频。
- 根因：`_videoKnownIds` 达到 128 后永久拒绝新 ID；永久 release 保留 known ID，未归还容量。当前注释明确写着直到重建整个 View 才恢复。
- 主代理临时测试：依次显示、永久 release 129 个不同 ID，实际 `create` **128/129**，第 129 个没有创建解码器。
- 建议：区分活动注册、在途异步资源和已退休代次；永久注销后回收注册容量，同时保留足以拒绝迟到旧帧的代次保护。不能通过直接删除 tombstone 让旧 DrawOp 自动复活。

### P2：同批 play/pause 未先收敛，仍产生中间平台播放调用

- 位置：`pocket_view.dart:2452`、`:4311`、`:4333`。
- 根因：资源扫描先于事件处理，事件循环又逐条启动播放泵；同批最终状态为暂停，仍先向平台发送 play。新 DrawOp 同批 release 也有先加载再撤销的风险。
- 主代理临时测试：已初始化且暂停的视频，只投递一次 `[video.play, video.pause]`，后续帧不再带事件；实际出现一次 `play:1`，随后 `pause:1`。最终暂停可以收敛，故不采用 Argon 原稿的 P1 分级，按额外原生工作/瞬时播放的 P2 处理。
- 建议：先归并整批最终视频命令，再执行一次资源协调和每 ID 的播放泵；保留异步串行与代次保护。避免新增 ticker 或轮询补偿。

### P2：失败资源缓存不随永久注销清理，同源重建不能重试

- 位置：`pocket_view.dart:600`、`:3123`、`:3265`、`:3324`。
- 触发：同 `(id, asset)` 首次加载失败，之后资源恢复并永久 release/re-register，或换源后切回该曾失败资源。
- 根因：`_failedVideos` 记住失败 key；永久 release 不清除，重建命中缓存直接返回。不同失败 asset 也会累计。
- 主代理临时测试：首次平台 create 抛错，随后恢复平台、release 并重注册同 ID/asset；实际调用仅 `[init]`，没有新的 create。
- 建议：明确重试/永久注销/资源代次边界并清理失败记录，限制失败缓存；不要在每帧资源扫描时反复重试坏文件。

## 源码可确认、尚未做完整运行复现的问题

- **P2，失败注册后的 cleanup 仍可能抛错**：`video.tsx:101` 无条件、未捕获地调用 `releaseSurface(id)`。注册与 host-owned application surface 同名时，注册异常被 fallback 捕获，卸载却会走 `lib.rs:1258` 的 host-owned 拒绝分支。应跟踪本组件实际取得的注册所有权，安全清理；仅检查最后一次更新的 `registered()` 值也未必等于资源所有权。
- **P2，默认探针可能陈旧**：`media_native.test.ts:11`、`duo_close_native.test.ts:20` 优先选择存在的 release 探针，没有验证其构建新鲜度。本次使用显式 debug 路径，因此不影响本次实际测试选择；默认测试入口仍可能验证旧引擎。应要求可验证的构建来源/新鲜度，不能只按存在与否选择。
- **待验证，组互斥与受控 props**：`video.tsx:95` 的同一 effect 同时处理 `active` 和 `playing`，可能在只改 active 时重新施加旧的 playing prop，覆盖组内已清除的 intent。需要真实 Video 组件的精确回归。非 active 条目调用 play 是否应切换组选择也需要先明确 API 语义，不能仅凭作者偏好定为缺陷。

## 测试与证据

Argon 报告实际执行：Flutter 视频单测 **17/17**，SDK media/platform/system/Duo 测试 **28/28**，Demo 视频测试 **4/4**，架构检查通过。它也读取了既有 iOS 成功日志；这些通过结果没有覆盖上述新复现。

主代理在 `/tmp` 复制已有 fake-platform 测试支架，新增独立复现；未向正式测试目录写入文件：

```sh
cd /Volumes/ORICO/Development/Github/pocket/sdk
flutter test /tmp/pocket-argon-video-review-20261104/regression_test.dart \
  --no-pub --reporter expanded --plain-name 'review:'
```

实际分两次运行：前三项 **3 个预期红测**（`root-reproduction.log`），容量项 **1 个预期红测**（`root-capacity.log`）。这些失败用于证实缺陷，不是修复后验收。前三项日志分别记录误 `play:1`、单批额外 `play:1 -> pause:1`、恢复后无 create；容量日志记录 `128 / 129`。

原始脚本、日志与 Argon 原稿位于上述 `/tmp` 目录。新测试没有证明真实设备功耗或卡顿，也没有代替 Android 原生解码、Duo 真实展开/折叠中间帧触控验收。

## 未采纳或修正的 Argon 描述

1. **“media.ts 会 trim ID 导致两端 ID 不同”不成立**：`nonEmpty()` 只校验原字符串长度，注册保存的仍是原 ID；没有 trim。剔除此子结论。
2. **“known IDs 与 epochs 通过 FIFO 回收”不成立**：当前 `_admitVideoId` 明确不淘汰旧 ID；由此出现第 129 个 ID 的实际失败，不能把它描述为仅限制同时活跃数量。
3. **“DrawOp 完全消失仍保留解码器”不成立**：完全消失会释放解码器并保留 intent；保留但不可见的 op 才走暂停分支。
4. 原稿把 `retryPlaying` 描述成“用于掩盖问题”属于无证据的动机推断，不采纳；仅确认当前测试断言不足。
5. 原稿对漂移文件新增内容的具体描述和个别日志/行号不准确，不当作已验证事实；本报告仍以 41 文件快照及主代理列出的实际源码和复现为准。
6. 原稿部分 guest 重建命令不符合本项目入口；修复后的重建应使用 `cd demo/js && bun run build:system`。

## 修复验收建议

保持 JS 拥有播放策略；宿主只处理资源与安全的命令传输。优先修复 P1 的离屏初始命令和累计容量问题，再处理批次收敛、同源重试与安全清理。将上述临时复现变成正式回归，并补真实解码器的离屏首挂/暂停、长 Feed、同源重试测试。默认探针来源应明确。Duo 展开态和动态姿态仍须真实 Flutter Pointer 验收。

## 交付时的版本边界

Argon 审查中期只有 `responsive.ts`、`ui.tsx` 漂移；主代理复现和报告整理完成后，另一次并行整合使 HEAD 变成 `39df545`，最终已有 12 个快照文件变化：`demo/js/app.tsx`、`sdk/native/src/lib.rs`、`pocket_view.dart`、`pocket_ui/package.json`、`platform.ts`、`display.ts`、`responsive.ts`、`mobile.tsx`、`ui.tsx`、`system.ts`、`host.ts`、`responsive_occlusion.test.ts`。

主代理检查了 `pocket_view.dart` 相对快照的差异：此次新增的是队列使用 `PocketBinaryCodec` 的编码/解码，本文指出的视频准入、事件处理、失败缓存逻辑没有被该差异修复。但**不把本报告当作新二进制通道或最终合并版本的完整审查**；四个临时红测对应其执行当时的实现。正式修复后应在固定提交上重新验证。全仓 `git diff --check` 另发现并行 `sdk/editor/wechat.ts:497` 文件尾空行；本轮未修改该文件。


## 本轮修复与重新验证（2026-11-04）

生产策略仍在 JS：`Video` 显式注册 `autoplay:false`；active 与 playing
分别响应变化，卸载仅释放本组件成功取得的 surface，清理异常局部捕获。
Rust 的 JSON/PFB1 均传递真实 autoplay 值，缺省的旧调用仍保持 true。
Dart 仅收敛帧命令、管理资源和有界身份，不新增路由、可见性政策、轮询或 ticker。

- 离屏初始命令：合法 play/pause 可以在首个 DrawOp 前准入。
- 累计 128 上限：永久注销归还活动容量；保留仍在当前 DrawList 内的注销标记，防止旧节点复活；在途加载使用全局单调 ticket 防止同 ID 代次重用。
- 同批中间播放：完整批次的视频命令在资源协调前收敛；非视频事件、输入和首帧 ready 顺序保留原边界。
- 同源失败重试：永久注销清除该 ID 的失败历史；换源重新加载，失败缓存有界，不按帧重试。
- 注册清理和组互斥：增加真实 Solid effect/cleanup 回归；inactive 条目显式 play 代表选择该组条目、暂停 peers，但等到 active 后才播放。
- 陈旧探针：默认选择经过输入时间戳检查的新探针，旧 release 不再仅凭存在而优先使用。该检查是时间戳启发式，不是内容摘要证明；显式 `POCKET_NATIVE_PROBE` 属于调用者选择的覆盖。

主代理重新运行原 `/tmp` 独立复现命令，**4/4 由红转绿**，日志
`/tmp/pocket-video-remediation-independent.log`：无误 play、同批无中间 play、
同源重新 create、第 129 项创建成功（129/129）。正式回归另覆盖了释放压力下
仍保留旧 DrawOp 注销标记，不能仅靠这四项声称所有边界都闭环。

主代理额外运行：视频 Flutter 正式回归 **27/27**（`/tmp/pocket-video-remediation-video-widget.log`）；非视频 Flutter 输入/首帧/idle/viewport/compositor 回归
**52/52**；SDK media/Video/真实 bytecode probe/Duo close/探针选择 **15/15**；
Demo Video 页面与原生测试 **4/4**；架构边界检查通过。日志分别为
`/tmp/pocket-video-remediation-widget.log`、终端 Bun 输出、
`/tmp/pocket-video-remediation-demo-js.log`。JS/native 子代理另报告 Rust 全套
**88 项通过**，与主代理亲自运行的结果区分。


真实 iPhone 18 Pro / iOS 27.2 模拟器重新验收：**+1 All tests passed**，日志
`/tmp/pocket-video-remediation-ios-integration-rerun.log`。真实 MP4 的推进、暂停、
换源、注销重建、失败重试保持暂停、离屏首次可见保持暂停、滚出释放/返回恢复，以及
两次真实 MiniApp 覆盖/返回均通过。第一次加强版运行因测试 reveal 助手只会向上滑、
无法返回顶部而失败，已补真实向下手势；保留失败日志，没有放宽播放器断言。

本报告列出的已确认视频缺陷已修复并通过以上范围的回归。当前共享工作区还包含其他
并行改动；本结论不等于对整个工作区或硬件插件拆分的合入背书。Android 真实解码、
真机功耗/高刷新率、动态 Duo 姿态仍未由本轮视频测试证明。


收尾独立复核另补两项资源身份边界：失败缓存的字符串分隔键允许 NUL ID
发生碰撞；全局 ticket 若从 0 开始会与缺失 epoch 的 `?? 0` 比较冲突。
现已分别改为结构化 `(id, asset)` key 与从 1 开始的非零 ticket；补充覆盖
首个异步 initialize 在注销历史淘汰后才返回的回归。它们属于本轮修复的
防退化验证，不由上面的真实播放器常规路径测试替代。


最终收尾验收：视频正式回归扩充为 **30/30**，主代理执行日志
`/tmp/pocket-video-remediation-final-video-widget.log`。新增 NUL ID 失败资源
隔离、清理不误删 sibling，以及首个 pending initialize 在注销历史淘汰后的
迟到返回。主代理随后加强最后一项：在重新注册前断言旧加载没有发出
`ready`/`playing`，防止“瞬时装回再销毁”的假阳性；单项重跑通过，日志
`/tmp/pocket-video-remediation-stale-final.log`。Flutter package 静态分析无问题，
日志 `/tmp/pocket-video-remediation-final-analyze.log`。

普通 Showcase 已重新构建并安装启动到 Duo（bundle `com.example.pocketHost`），
折叠态首页截图 `/tmp/pocket-video-remediation-duo-folded.png`；本轮没有进行
Duo 的动态展开/折叠手势验收。普通包构建日志
`/tmp/pocket-video-remediation-final-build.log`；其 kernel 生成时间晚于最终
生产代码修改，后续仅加强测试断言。代码和文档保留在工作区，未提交。
