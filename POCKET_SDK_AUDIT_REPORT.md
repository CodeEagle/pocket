# Pocket SDK 独立代码与运行取证审核报告

- **审核对象**：`/Volumes/ORICO/Development/Github/pocket`（含 `sdk/`、`demo/`、`demo/js/`）
- **审核时间**：2026-11-02
- **审核方法**：源码逐行追踪 + 剥离缓存的干净环境重建测试 + 临时消费工程接入验证 + 针对性缺陷复现单测与安全探测（未修改任何正式源码，未停止现有服务，未读取或输出任何私钥/凭据）。

---

## 一、总体判断

### 1. 当前适合什么用途
- **适合内部架构验证与 macOS / iOS Simulator 原型展示**：
  - 核心渲染链路真实：Flutter 宿主（[`demo/lib/main.dart`](file:///Volumes/ORICO/Development/Github/pocket/demo/lib/main.dart#L1-L26) 仅 26 行）确实是薄宿主；Showcase 的路由、状态、组件组合、动画与主题均在 JS 侧（[`demo/js/app.tsx`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/app.tsx#L1-L828)、[`demo/js/state.ts`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/state.ts#L1-L654)）运行，经固定版本 QuickJS（`rquickjs 0.9.0` / QuickJS `2025-04-26`，bytecode version `26`）编译为真实 `.qjbc` 字节码，并通过 Rust FFI 生成二进制 DrawList（`PJDL` v1）交由 Flutter [`PocketCanvasPainter`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L1318-L1487) 绘制。
  - CLI、Editor 与构建脚本确实复用了同一套 [`buildGuest`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_guest.ts#L316-L461) 编译管线，未发现各自维护独立打包逻辑的情况。

### 2. 距离“可复用 / 可发布公共 SDK”还缺哪些必要条件
1. **跨平台构建与集成闭环缺失（阻断级）**：
   - [`sdk/packages/pocket_flutter/android/build.gradle`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/android/build.gradle#L1-L19) 是未完成桩文件（缺少 `com.android.library` 插件与 `android {}` 块，且无 JNI 产物），任何接入方执行 `flutter build apk` 均直接抛 `NullPointerException`；[`sdk/pocket.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L307-L328) 也不支持 `--platform=android`。
   - 干净环境下执行 `build_native.sh macos` 在当前 Xcode 27.2 工具链上因全局导出 `MACOSX_DEPLOYMENT_TARGET=12.0` 污染宿主 proc-macro（`libserde_derive.dylib` LINKEDIT 偏移未对齐）而编译失败；本机此前能跑通仅因 `ios-sim` 构建先行生成了 `minos 11.0` 的 `libserde_derive`。
   - 文档（[`README.md`](file:///Volumes/ORICO/Development/Github/pocket/README.md#L14)、[`sdk/README.md`](file:///Volumes/ORICO/Development/Github/pocket/sdk/README.md#L12-L13)）记载的 `--sdk-root <dir>` 空格参数会被 [`pocket.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L69-L93) 直接拒绝。
2. **宿主生命周期与硬件合规耦合缺陷（阻断级）**：
   - [`PocketGuest`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_app.dart#L31-L34) 使用 `ValueKey(config)`，但 [`PocketAppConfig`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_config.dart#L38-L73) 未实现 `==`/`hashCode`；外部父组件一旦 `setState` 重建并传入非 `const` 配置，整个 QuickJS 运行时与页面状态会被立即销毁重建。
   - [`sdk/pubspec.yaml`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pubspec.yaml#L15-L16) 强依赖并全量导出 `pocket_hardware`，即便 `enableHardware: false` 也会在 iOS 二进制中静态链接 `AVFoundation`、`CoreBluetooth`、`CoreLocation`、`CoreMotion`、`Photos`、`LocalAuthentication`，触发 App Store 静态扫描拒审（ITMS-90683）。
3. **热更新状态机与版本演进缺陷（阻断级）**：
   - 缺少单调递增 `build` 防降级检查、缺少随 App Store 升级覆盖旧 OTA 缓存的机制、且自动回退后 `previous` 指针指向坏包导致再次调用 `rollback()` 会重新激活坏包。
4. **空闲高频空转与性能统计失真（高优级）**：
   - [`PocketView`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L571-L576) 的 `Ticker` 在页面完全静止时仍以 60/120Hz 永久空转，且 Rust 侧 [`build_frame`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L1361-L1475) 每帧无条件执行 `relayout_outputs` 并深拷贝整棵节点树与 DrawList 数组，造成持续发热耗电，同时使 [`PocketPerformanceWindow`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_performance.dart#L24-L64) 将大量 `unchanged` 空转帧统计为 60 FPS。
5. **本地 Editor 服务安全边界缺失（高优级）**：
   - [`sdk/editor/server.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L125-L136) 无 Origin/CSRF/Host 校验且忽略 `Content-Type`，任意网页可通过浏览器发起跨站请求创建/覆盖工程、污染 `POCKET_UPDATE_URL` 或触发构建，且多处接口未校验符号链接越界。

---

## 二、确认缺陷（按严重性排序）

### 【P0 / Critical】

#### 1. Android 插件为半成品桩代码，`pocket init` 生成的工程在 Android 下无法构建
- **文件与行号**：
  - [`sdk/packages/pocket_flutter/android/build.gradle`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/android/build.gradle#L1-L19)
  - [`sdk/packages/pocket_flutter/pubspec.yaml`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/pubspec.yaml#L20-L24)
  - [`sdk/pocket.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L307-L328)、[`sdk/pocket.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L516-L523)
  - [`sdk/scripts/build_native.sh`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_native.sh#L11-L40)
- **具体触发条件**：在通过 `bun sdk/pocket.ts init` 初始化的任意 Flutter 工程中执行 `flutter build apk`，或执行 `bun sdk/pocket.ts build --platform=android`。
- **根因与实际影响**：
  1. `pocket_flutter/pubspec.yaml` 声明了 `android: ffiPlugin: true`，但 `android/build.gradle` 仅写了 19 行 `group`/`version`/`buildscript`，**未应用 `com.android.library` 插件，也未声明 `android { namespace ... compileSdk ... }` 块**，导致 Gradle 在配置 `:pocket_flutter` 时直接抛出 `java.lang.NullPointerException`。
  2. `pocket_flutter/android/src/main/jniLibs` 目录不存在，且 `build_native.sh` / `pocket.ts` 仅支持 `macos | ios | ios-sim`，未实现 Android NDK 交叉编译链。
- **复现步骤与验证证据**：
  - 在 `/tmp/pocket-audit-sdk` 初始化临时工程并执行 `flutter build apk --debug`，实测报错：
    ```text
    FAILURE: Build failed with an exception.
    * What went wrong:
    A problem occurred configuring project ':pocket_flutter'.
    > java.lang.NullPointerException (no error message)
    ```
  - 执行 `bun sdk/pocket.ts build my-app --platform=android` 报错：`pocket: unsupported platform: android`。
- **最小修复建议**：
  - 若暂不支持 Android，应从 [`sdk/packages/pocket_flutter/pubspec.yaml`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/pubspec.yaml#L22-L23) 与 [`sdk/packages/pocket_hardware/pubspec.yaml`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_hardware/pubspec.yaml#L18-L20) 移除 `android` 平台声明并在文档中明确标注仅支持 iOS/macOS；若需支持 Android，则补齐 `android/build.gradle` 的 `com.android.library` 配置及 `cargo-ndk` 的 `jniLibs` 编译脚本。

---

#### 2. 干净环境下 `build_native.sh macos` 因 `MACOSX_DEPLOYMENT_TARGET=12.0` 污染宿主 proc-macro 而构建失败
- **文件与行号**：
  - [`sdk/scripts/build_native.sh`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_native.sh#L16-L19)
  - [`sdk/pocket.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L318-L320)
- **具体触发条件**：在没有 `native/target` 缓存的干净环境中执行 `./scripts/build_native.sh macos` 或 `bun sdk/pocket.ts build <dir> --platform=macos`（macOS / Xcode 27.2 `ld`）。
- **根因与实际影响**：
  - `build_native.sh` 第 17 行执行了全局 `export MACOSX_DEPLOYMENT_TARGET=12.0`。当 Cargo 从零编译宿主 proc-macro（`serde_derive`）时，`ld` 将 `minos 12.0` 与新 SDK（`27.2`）组合生成了未按 8 字节对齐的 `__LINKEDIT` 字符串池（`fileOffset=0x00240FC4`），导致 `rustc` 在 `dlopen(libserde_derive-*.dylib)` 时直接崩溃。
  - **为什么本机已有缓存时能跑通**：开发者本机先执行过 `ios-sim` 分支（未设置 `MACOSX_DEPLOYMENT_TARGET`，宿主 `libserde_derive-*.dylib` 以 `minos 11.0` 编译并留在 `native/target/release/deps/`），后续跑 `macos` 时复用了该缓存。
- **复现步骤与验证证据**：
  - 在清除 `native/target` 的临时副本中执行 `MACOSX_DEPLOYMENT_TARGET=12.0 cargo build --locked --release --manifest-path native/Cargo.toml --target aarch64-apple-darwin`，实测报错：
    ```text
    error: .../libserde_derive-c4b741ffcf03759b.dylib: mach-o file, but is an incompatible architecture (have 'arm64', need 'arm64e' or 'arm64'): mis-aligned LINKEDIT string pool, fileOffset=0x00240FC4
    ```
  - 去掉全局 `MACOSX_DEPLOYMENT_TARGET=12.0`（或仅通过 `CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS="-C link-arg=-mmacosx-version-min=12.0"` 作用于目标库）后，干净构建在 11.1 秒内成功通过。
- **最小修复建议**：
  - 在 [`sdk/scripts/build_native.sh`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_native.sh#L17) 中不要全局 `export MACOSX_DEPLOYMENT_TARGET=12.0`，改为仅对 target 设置 `CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS` / `CARGO_TARGET_X86_64_APPLE_DARWIN_RUSTFLAGS`，或在 `Cargo.toml` 中开启 `resolver = "2"` 以隔离 host proc-macro 与 target 的环境变量。

---

#### 3. `PocketGuest` 以 `ValueKey(config)` 作为 Session Key，但 `PocketAppConfig` 未实现值相等，父组件重建即销毁整个 JS 运行时
- **文件与行号**：
  - [`sdk/lib/src/pocket_app.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_app.dart#L31-L34)、[`sdk/lib/src/pocket_app.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_app.dart#L92-L100)
  - [`sdk/lib/src/pocket_config.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_config.dart#L9-L73)
- **具体触发条件**：消费方将 [`PocketGuest`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_app.dart#L22-L35) 嵌入自定义 Flutter 页面，并在 `build()` 中传入非 `const` 的 `PocketAppConfig(...)`（例如包含 `capabilities: {'hardware.sensors'}`、`plugins: [...]` 或带运行期参数的 `PocketUpdateConfig`），随后父组件发生任意 `setState`、主题切换或路由动画。
- **根因与实际影响**：
  - `PocketGuest.build` 返回 `_PocketGuestSession(key: ValueKey<PocketAppConfig>(config), config: config)`。
  - `PocketAppConfig` 和 `PocketUpdateConfig` 均未重写 `operator ==` 与 `hashCode`（默认引用相等 `identical`）。因此每次父 Widget `build` 构造的新 `PocketAppConfig` 实例都会使 `ValueKey` 失配，Flutter 销毁旧 `_PocketGuestSessionState`（调用 `session.dispose()` 销毁 QuickJS VM）并重新初始化新 Session，导致 JS 状态彻底丢失。
- **复现步骤与验证证据**：
  - 编写最小 Widget 测试连续两次 `pumpWidget` 传入字段完全相同的非 `const` `PocketAppConfig(appId: 'dev.example.app')`，验证前后两次 `_PocketGuestSession` 的 `State` 实例：`expect(identical(firstState, secondState), isTrue)` **失败**（`Actual: <false>`）。
- **最小修复建议**：
  - 移除 [`sdk/lib/src/pocket_app.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_app.dart#L32) 上的 `key: ValueKey<PocketAppConfig>(config)`，改为在 [`_PocketGuestSessionState.didUpdateWidget`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_app.dart#L92-L100) 中按字段值（使用 `setEquals`/`listEquals` 比较集合字段）判断是否真的需要重建 `PocketSession`。

---

#### 4. 热更新缺少版本防降级校验、App Store 覆盖校验，且自动回退后 `previous` 指针残留坏包导致 `rollback()` 重新激活坏包
- **文件与行号**：
  - 无防降级校验：[`sdk/packages/pocket_services/lib/src/pocket_update.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_services/lib/src/pocket_update.dart#L210-L325)、[`sdk/packages/pocket_services/lib/src/pocket_package.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_services/lib/src/pocket_package.dart#L984-L1035)
  - 旧 OTA 覆盖新安装包：[`sdk/lib/src/pocket_session.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_session.dart#L114-L163)
  - 坏包残留于 `previous` 指针：[`sdk/lib/src/pocket_session.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_session.dart#L263-L268)、[`sdk/lib/src/pocket_session.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_session.dart#L452-L460)、[`sdk/packages/pocket_services/lib/src/pocket_package.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_services/lib/src/pocket_package.dart#L738-L754)
- **具体触发条件**：
  1. **重放/降级**：更新源（或 CDN 缓存回退/中间人重放历史合法签名包）返回比当前 `build` 更低的旧版已签名 manifest。
  2. **商店大版本升级后仍跑旧 OTA**：应用曾热更新至 `1.0.1+2`，随后用户从 App Store 升级宿主至 `1.1.0+10`（`runtimeAbi` 未变，内置 `assets/app.qjbc` 已更新）。
  3. **自动回退后再手动回滚**：`v1` 正常 -> 升级至 `v2` 并通过 1 秒健康期（此时 `active=v2, previous=v1`）-> 用户交互触发 `v2` 运行时异常，`PocketView.onError` 自动回退挂载 `v1` -> 1 秒后 `commitHealthy(v1)` 执行 -> 随后调用 `rollback()`。
- **根因与实际影响**：
  1. `PocketUpdateCoordinator.prepare` 只检查签名、哈希、`appId` 与 `runtimeAbi`，**完全未比较 `manifest.payload.build` 与当前激活版本的 `build`**，旧包会直接覆盖新包。
  2. `PocketSession.initialize` 在启动时无条件优先加载 `updates.lastGood()`（第 114 行），且内置 `assets/app.bytecode.json` 甚至不包含 `build` 号，只要 `runtimeAbi` 相同，App Store 新版内置的 JS 永远不会生效。
  3. `commitHealthy(versionId)`（[`pocket_package.dart:747-749`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_services/lib/src/pocket_package.dart#L747-L749)）在 `currentActive != version.versionId` 时无条件执行 `await _writePointer(_previousFile, currentActive)`。当从已晋升的 `v2` 因崩溃回退到 `v1` 时，`currentActive` 是坏包 `v2`，1 秒后 `commitHealthy(v1)` 会把 `previous` 改写为坏包 `v2`！此后一旦调用 `rollback()`，就会把坏包 `v2` 重新设为 `active` 和 `lastGood`。
- **复现步骤与验证证据**：
  - 在独立测试副本中构造 3 组单元复现测试（R1、R6、R8）并执行 `flutter test`：
    - **R1（降级攻击）**：先发布并 `commitHealthy` `1.0.2+2`，再喂入旧版合法签名包 `1.0.1+1`，实测 `lastGood.version` 被降级为 `'1.0.1'`（`build == 1`）。
    - **R6（回退污染 `previous`）**：`v1` -> `v2`（`commitHealthy`）-> 模拟 `v2` 运行时报错触发 `fallbackFor(v2)` 回到 `v1` 并 `commitHealthy(v1)` -> 调用 `store.rollback()`，实测返回值竟为 `'1.0.2+2--...'`（已确认损坏的 `v2`）。
    - **R8（旧 OTA 覆盖新版内置包）**：缓存旧 OTA 后更新宿主内置资源，实测启动后仍加载旧 OTA 字节码。
- **最小修复建议**：
  1. 在 `PocketUpdateCoordinator.prepare` 中默认要求 `manifest.payload.build > currentBuild`（除非显式传入 `allowDowngrade: true`）。
  2. 在 `app.bytecode.json`（或内置 `guest-manifest.json`）中记录内置包的 `build` 与 `payloadSha256`；宿主升级导致内置 `build` 高于缓存 `lastGood.build` 时，自动清理或跳过旧 OTA 激活指针。
  3. 在 [`PocketSession._handleRuntimeError`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_session.dart#L263-L268) 触发回退时，先调用 `store.markBroken(failedVersionId)` 或直接清除 `previous` 中的故障版本，禁止 `commitHealthy(fallback)` 将故障版本写入 `_previousFile`。

---

#### 5. 本地 Editor 服务无 Origin/CSRF/Host 校验且存在多处符号链接越界读写与构建期代码执行链
- **文件与行号**：
  - 忽略 `Content-Type` 且无 Origin/CSRF 校验：[`sdk/editor/server.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L125-L136)、[`sdk/editor/server.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L676-L809)
  - `Host` 头污染写入 `host.json`：[`sdk/editor/server.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L520)、[`sdk/editor/server.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L796)
  - 符号链接越界读写：[`sdk/editor/server.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L466)、[`sdk/editor/server.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L696-L749)、[`sdk/editor/server.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L770-L786)
  - `Bun.build` 打包任意用户/攻击者代码：[`sdk/scripts/build_guest.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_guest.ts#L345-L353)
- **具体触发条件**：开发者本机运行着 Editor 服务（尤其当前 `~/Library/LaunchAgents/dev.pocket.editor.plist` 以 `KeepAlive=true` 常驻监听 `127.0.0.1:43110`），同时在浏览器访问任意第三方恶意网页，或打开包含符号链接的工程目录。
- **根因与实际影响**：
  1. **跨站请求伪造（CSRF）**：`readBody()` 直接对 `req.text()` 调用 `JSON.parse()`，完全不检查 `Content-Type: application/json` 或 `Origin` 头。浏览器中的任意外部站点可通过 `<form enctype="text/plain">` 或 `fetch("http://127.0.0.1:43110/api/projects", { mode: "no-cors", body: JSON.stringify(...) })` 直接在开发者磁盘创建项目、通过 `multipart/form-data` 上传任意文件到 `assets/`、触发 `/build` 与 `/publish`。
  2. **Host 头投毒与 DNS Rebinding RCE**：`/api/projects/:id/publish` 使用未校验的 `url.origin`（来自 HTTP `Host` 头）拼接 `POCKET_UPDATE_URL` 并持久化写入 `host.json`。若配合 DNS Rebinding（将外部域名重绑定至 `127.0.0.1`），网页可读出响应并调用 `PUT /api/projects/:id/source` 写入含 Bun Macro（`import ... with { type: "macro" }`）的 `app.tsx`，再调用 `POST /build` 在 `Bun.build` 阶段直接以当前用户权限在宿主机执行任意命令。
  3. **符号链接逃逸**：`GET/PUT /api/projects/:id/source`、`GET/PUT /manifest`、`POST /assets` 以及 `buildProject` 中的 `copyFileSync(projectManifest, ...)` 均只做了 `path.join`，未检查 `lstatSync(...).isSymbolicLink()` 或 `realpathSync` 边界。若工程内的 `app.tsx`、`manifest.json` 或 `assets/sub` 是符号链接，可直接读取或覆写工作区外的宿主机任意文件。
- **复现步骤与验证证据**：
  - 在隔离端口启动的测试实例上使用 `curl` 实测验证：
    1. 发送 `Origin: https://evil.example` + `Content-Type: text/plain` 的 `POST /api/projects`，返回 `HTTP 201` 并成功落盘项目。
    2. 发送 `Host: attacker.example` 的 `POST /api/projects/csrf-app/publish`，生成的 `host.json` 中 `POCKET_UPDATE_URL` 被篡改为 `"http://attacker.example/updates/csrf-app/latest.json"`。
    3. 将测试工程内 `manifest.json` 软链至工程外的秘密 JSON 文件并触发构建，外部文件内容被完整复制进构建产物 `guest-manifest.json`；对软链 `app.tsx` 调用 `PUT /source`，成功覆写工程外目标文件。
    4. 验证 `Bun.build` 编译含 `with { type: "macro" }` 的 `app.tsx` 时，宏函数在打包阶段即在宿主机进程内执行。
- **最小修复建议**：
  1. 在 [`sdk/editor/server.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L628) 入口强制校验 `Host` 头必须为 `127.0.0.1:<port>` 或 `localhost:<port>`，且所有非 `GET/HEAD` 请求必须校验 `Origin` 匹配本地地址并要求 `Content-Type: application/json`（或带自定义 Header 如 `X-Pocket-CSRF: 1` 以触发 CORS 预检）。
  2. 将 [`safeProjectFile`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L85-L93) 升级为逐级检查 `lstatSync` 拒绝任何符号链接（或校验父目录与目标文件的 `realpathSync` 必须位于 `projectDir` 内），并统一应用于 `source`、`manifest`、`assets` 读写及 `buildProject`。

---

### 【P1 / High】

#### 6. CLI 文档中的 `--sdk-root <dir>` 空格语法与 `pocket.ts` 参数解析器不兼容
- **文件与行号**：
  - [`README.md`](file:///Volumes/ORICO/Development/Github/pocket/README.md#L14)
  - [`sdk/README.md`](file:///Volumes/ORICO/Development/Github/pocket/sdk/README.md#L12-L13)
  - [`sdk/docs/SDK_INTEGRATION.md`](file:///Volumes/ORICO/Development/Github/pocket/sdk/docs/SDK_INTEGRATION.md#L12)
  - [`sdk/pocket.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L69-L76)、[`sdk/pocket.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L91-L93)
- **具体触发条件**：按文档示例执行 `bun pocket.ts init /tmp/my_pocket_app --sdk-root "$PWD"`。
- **根因与实际影响**：[`takeFlag`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L69-L76) 只匹配 `${prefix}=`（如 `--sdk-root=/path`），未处理空格分隔的下一个参数；剩余的 `--sdk-root` 在 [`ensureNoArgs`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L91-L93) 中直接抛错退出。
- **复现步骤与验证证据**：
  - 实测执行 `bun sdk/pocket.ts init /tmp/pocket-audit-sdk/my-app --sdk-root /tmp/pocket-audit-sdk/sdk`：
    ```text
    pocket: unknown option --sdk-root
    ```
    改用 `--sdk-root=/tmp/pocket-audit-sdk/sdk` 后才成功。
- **最小修复建议**：在 [`takeFlag`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L69-L76) 中同时支持 `--flag=value` 与 `--flag value`（消费 `args[index]` 与 `args[index + 1]`）。

---

#### 7. `pocket.ts` 的 `prepareNative` 在共享 SDK 目录内写入产物，且缓存戳忽略源码变更、`ios` 与 `ios-sim` 共用同一静态库路径
- **文件与行号**：
  - [`sdk/pocket.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L309-L328)
  - [`sdk/scripts/build_native.sh`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_native.sh#L23-L35)
- **具体触发条件**：
  1. 修改 `sdk/native/src/*.rs` 后执行 `bun sdk/pocket.ts build <app> --platform=macos`。
  2. 先后构建 `--platform=ios`（真机）与 `--platform=ios-sim`（模拟器），或两个消费工程并发执行 `pocket.ts build`。
- **根因与实际影响**：
  1. `prepareNative` 仅检查 `stamp?.platform === platform && existsSync(archive)`（[`pocket.ts:316`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L316)），**完全不检查 `sdk/native/src` 的文件时间戳或内容哈希**。而 [`build_guest.ts:289`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_guest.ts#L289) 的 `newestMtimeMs` 会重新编译 `pocketjs_bytecode`，导致编译器（新 ABI）与宿主静态库 `libpocket_flutter.a`（旧 ABI）不一致。
  2. `build_native.sh` 中 `ios` 与 `ios-sim` 均将输出写入同一个路径 `packages/pocket_flutter/ios/Frameworks/libpocket_flutter.a`，切换真机与模拟器构建会互相覆盖，且向 SDK 源码树直接写入构建产物违反了只读依赖原则。
- **复现步骤与验证证据**：
  - 在 `/tmp/pocket-audit-sdk/sdk` 中 `touch native/src/lib.rs` 后运行 `bun sdk/pocket.ts build my-app --platform=macos`，实测 `pocketjs_bytecode` 被重新编译，但 `packages/pocket_flutter/macos/Frameworks/libpocket_flutter.a` 的 mtime 保持不变，未触发重编。
- **最小修复建议**：
  1. 在 [`prepareNative`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L315-L317) 中加入 `newestMtimeMs(path.join(sdkRoot, "native")) > statSync(archive).mtimeMs` 判断。
  2. 将 `ios`（arm64 真机）与 `ios-sim`（模拟器）打包为 `.xcframework`，避免共用单一 `.a` 文件。

---

#### 8. `pocket_sdk` 强依赖并全量导出 `pocket_hardware`，未启用硬件的应用也会静态链接全部 iOS 敏感权限框架
- **文件与行号**：
  - [`sdk/pubspec.yaml`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pubspec.yaml#L15-L16)
  - [`sdk/lib/pocket_sdk.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/pocket_sdk.dart#L4-L6)
  - [`sdk/packages/pocket_hardware/ios/pocket_hardware.podspec`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_hardware/ios/pocket_hardware.podspec#L17-L24)
- **具体触发条件**：使用默认参数（不带 `--hardware`）执行 `bun sdk/pocket.ts init my-app` 并构建 iOS 应用。
- **根因与实际影响**：
  - 即使 `PocketAppConfig.enableHardware` 为 `false` 且 `Info.plist` 未声明任何 `NS*UsageDescription`，由于 `pocket_sdk` 的 `pubspec.yaml` 直接依赖 `pocket_hardware`，CocoaPods 仍会将 `pocket_hardware.framework` 编译进最终 `Runner.app`。
  - 该二进制直接链接并引用了 `AVFoundation`、`CoreBluetooth`、`CoreLocation`、`CoreMotion`、`LocalAuthentication`、`Photos` API，提审 App Store 时会因缺少对应的 `Info.plist` 隐私描述直接被苹果静态扫描拒审（ITMS-90683）。
- **复现步骤与验证证据**：
  - 对未开启 `--hardware` 的 `/tmp/pocket-audit-sdk/my-app` 执行 `flutter build ios --simulator --debug`，检查 `Info.plist` 确认无任何 `UsageDescription`（计数为 `0`），再对构建产物执行 `otool -L`：
    ```text
    .../Runner.app/Frameworks/pocket_hardware.framework/pocket_hardware:
      /System/Library/Frameworks/AVFoundation.framework/AVFoundation
      /System/Library/Frameworks/CoreBluetooth.framework/CoreBluetooth
      /System/Library/Frameworks/CoreLocation.framework/CoreLocation
      /System/Library/Frameworks/CoreMotion.framework/CoreMotion
      /System/Library/Frameworks/LocalAuthentication.framework/LocalAuthentication
      /System/Library/Frameworks/Photos.framework/Photos
    ```
- **最小修复建议**：
  - 将 `pocket_hardware` 从 `pocket_sdk` 的必选依赖中拆出（或改为由开启 `--hardware` 的工程显式依赖并注册 `HardwarePlugin()`），不要在核心包中无条件链接全部敏感系统框架。

---

#### 9. `PocketView` 在静止画面下仍以 60/120Hz 永久空转，且 Rust 每帧深拷贝整棵节点树与 DrawList、虚增 FPS 统计
- **文件与行号**：
  - 永久运行 Ticker：[`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L571-L576)、[`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L810-L848)
  - 每帧重排与深拷贝：[`sdk/native/src/lib.rs`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L1361-L1475)、[`sdk/native/src/lib.rs`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L1562-L1630)
  - 性能指标将空转帧计入 FPS：[`sdk/packages/pocket_flutter/lib/src/pocket_performance.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_performance.dart#L24-L64)
- **具体触发条件**：应用处于任意无动画、无交互的静止页面。
- **根因与实际影响**：
  1. `PocketView` 在挂载后即调用 `_ticker?.start()`，只要宿主可见就永不停止。
  2. 每次 vsync 回调 `_onTick` 都会跨 FFI 调用 `pocket_frame_delta_at` -> Rust `build_frame`：
     - 调用 `guest.tick(now_ms)` 进入 QuickJS 执行 JS 帧回调（如 [`ui.tsx:673`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_ui/src/ui.tsx#L673) 的 `onFrame(sendRectUpdate)`）；
     - 无条件对所有节点执行 `relayout_outputs(&mut self.layout, &self.nodes)`（[`lib.rs:1416`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L1416)）；
     - 无条件执行 `let words = self.draw.words.clone();` 与 `let nodes = self.nodes.clone();`（[`lib.rs:1417-1418`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L1417-L1418)），然后与上一帧逐一比对，发现相同时分配并返回字符串 `'{"unchanged":true}'`。
  3. 在 Dart 侧，即使 `deltaJson == null`（即画面完全未重绘、未触发 Flutter `setState`），`_recordFrameMetrics` 仍被调用并向 [`PocketPerformanceWindow.recordFrame`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_performance.dart#L24) 记录一帧。因此界面上展示的 `60 FPS` 实际上大多是未发生任何渲染的空闲 Ticker 脉冲；一旦发生真实重绘耗时耦合，真实渲染帧率会被大量空闲帧稀释掩盖。
- **复现步骤与验证证据**：
  - 代码追踪 [`pocket_view.dart:816-829`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L816-L829)：当 `deltaJson == null` 时，`opCount` 取旧值 `_ops.length`，调用 `_recordFrameMetrics(...)` 后直接 `return;`，紧接着下一帧 vsync 继续重复。
- **最小修复建议**：
  1. 在 Rust 侧维护脏标记（dirty flag）与活跃定时器/动画队列计数；当既无输入/异步回调、也无活跃动画/定时器时，跳过 `relayout_outputs` 和 `words.clone()`/`nodes.clone()`，并通知宿主暂停 `_ticker`，待有输入事件、定时器到期或异步消息时再唤醒 `_ticker`。
  2. 在 `PocketPerformanceMetrics` 中区分 `vsyncFps` 与实际提交渲染的 `renderedFps`（或 `unchangedFrameCount`），避免把空转帧直接包装为绘制帧率。

---

#### 10. `HardwarePlugin` 将 8 项权限捆绑为全有或全无校验，且 iOS 原生层将 `sensors`、`network`、`biometrics` 权限硬编码为 `granted: true`
- **文件与行号**：
  - 粗粒度捆绑校验：[`sdk/packages/pocket_hardware/lib/src/hardware_plugin.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_hardware/lib/src/hardware_plugin.dart#L287-L335)、[`sdk/packages/pocket_services/lib/src/pocket_plugin.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_services/lib/src/pocket_plugin.dart#L495-L505)
  - 假权限状态返回：[`sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift#L256-L296)
- **具体触发条件**：
  1. 第三方接入工程仅需使用传感器（`hardware.sensors`）或网络（`hardware.network`），在 `manifest.json` 中只声明了这两项权限。
  2. JS 调用 `hardware.permissionStatus("hardware.sensors")` 或 `hardware.requestPermission("hardware.biometrics")`。
- **根因与实际影响**：
  1. `HardwarePlugin` 在单个插件描述符的 `permissions` 集合中声明了全部 8 个硬件权限（相机、相册、蓝牙、传感器、生物识别、定位、麦克风、网络）。而 [`PocketPluginRegistry.invoke`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_services/lib/src/pocket_plugin.dart#L495-L505) 在调用插件的**任何**方法前，都会校验 `plugin.descriptor.permissions.difference(grantedPermissions)` 是否为空！这意味着哪怕只调一个 `getWeather` 或读取陀螺仪，Guest 也必须在 `manifest.json` 与 `PocketAppConfig` 中同时声明并授予相机、麦克风、蓝牙、定位、相册等全部 8 项权限，否则直接抛 `PocketPluginException('permission_denied')`（[`hardware_plugin_test.dart:199-216`](file:///Volumes/ORICO/Development/Github/pocket/demo/test/hardware_plugin_test.dart#L199-L216) 甚至将此不合理行为固化成了测试断言）。
  2. 在 `PocketHardwareManager.swift` 中：
     - `permissionStatus(for: "hardware.sensors")` 直接硬编码返回 `granted: true`（未查询 `CMAltimeter.authorizationStatus()`）；
     - `requestPermission` 对 `hardware.biometrics`、`hardware.sensors`、`hardware.network` 不调用任何系统 API，直接返回 `permissionPayload(..., status: "granted", granted: true)`。
- **复现步骤与验证证据**：
  - 核查 [`PocketHardwareManager.swift:256-295`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift#L256-L295) 与 [`pocket_plugin.dart:495-505`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_services/lib/src/pocket_plugin.dart#L495-L505)，逻辑确认无误。
- **最小修复建议**：
  1. 将权限校验下沉到 `PocketPluginMethod` 级别（每个 method 声明各自所需的 permission，而非整个 `HardwarePlugin` 共享 8 个必选权限）。
  2. 在 `PocketHardwareManager.swift` 中使用 `CMAltimeter.authorizationStatus()` 反映真实运动传感器权限；对 `biometrics` 的 `requestPermission` 调用 `LAContext.evaluatePolicy` 或明确返回不支持预授权，而非假装已授权。

---

### 【P2 / Medium】

#### 11. 模拟器运行 `system_keyboard_lifecycle_test.dart` 失败：空闲时不触发 Flutter 重绘导致 `keyboardAnchorFrames` 仅采样到 1 帧
- **文件与行号**：
  - [`demo/integration_test/system_keyboard_lifecycle_test.dart`](file:///Volumes/ORICO/Development/Github/pocket/demo/integration_test/system_keyboard_lifecycle_test.dart#L11-L71)、[`demo/integration_test/system_keyboard_lifecycle_test.dart`](file:///Volumes/ORICO/Development/Github/pocket/demo/integration_test/system_keyboard_lifecycle_test.dart#L97-L115)
  - [`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L816-L830)
- **具体触发条件**：在已启动的 iPhone Duo 模拟器（`4D366210-290E-46DB-8BC6-3C5233700409`）上执行 `flutter test integration_test/system_keyboard_lifecycle_test.dart` 或 `flutter drive --driver=test_driver/integration_test.dart --target=integration_test/system_keyboard_lifecycle_test.dart`。
- **根因与实际影响**：
  - 测试在 `LiveTestWidgetsFlutterBindingFramePolicy.fullyLive` 下通过 `binding.addPersistentFrameCallback` 收集 `tester.view.viewInsets.bottom > 0` 期间的 `keyboardAnchorFrames`，并在第 111 行断言 `expect(keyboardAnchorFrames.length, greaterThan(5))`。
  - 当模拟器软键盘弹出在单步内完成 `viewInsets.bottom` 更新后，后续 60 次 `tester.pump(50ms)` 期间由于 JS 画面不再变化，`PocketView._onTick` 收到 `deltaJson == null` 直接返回，**不触发 `setState()`**，因此 Flutter 不会调度新的渲染帧，`addPersistentFrameCallback` 仅执行了 1 次，导致测试稳定失败。
- **复现步骤与验证证据**：
  - 在目标模拟器上实测执行 `flutter test` 与 `flutter drive`，两者均在第 111 行失败：
    ```text
    Expected: a value greater than <5>
      Actual: <1>
    Capture JS layout during the real keyboard resize
    ```
- **最小修复建议**：
  - 在 [`system_keyboard_lifecycle_test.dart:97-106`](file:///Volumes/ORICO/Development/Github/pocket/demo/integration_test/system_keyboard_lifecycle_test.dart#L97-L106) 的循环中直接读取 `_guestTextRects(layoutAnchors)`（或在 `tester.binding.scheduleForcedFrame()` 下采样），不要依赖静止画面下的 `addPersistentFrameCallback` 触发次数。

---

#### 12. 中文拼音 composing 期间仅更新输入框位置（rect-only `textInput.update`）会丢失 `TextAffinity.upstream` 并触发多余的平台 `setEditingState`，且缺乏版本序号保护导致延迟回显覆盖新输入
- **文件与行号**：
  - 丢失 `affinity` / `isDirectional`：[`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L1852-L1895)、[`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L2047-L2055)
  - 缺少修订号（revision）防乱序覆盖：[`sdk/packages/pocket_ui/src/ui.tsx`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_ui/src/ui.tsx#L528-L542)、[`sdk/packages/pocket_ui/src/ui.tsx`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_ui/src/ui.tsx#L663-L668)
- **具体触发条件**：
  1. 用户使用 iOS 系统输入法输入中文或移动光标使 `selection.affinity == TextAffinity.upstream`，此时键盘高度变化或页面滚动触发 JS 发送只含 `{ id, rect }` 的 `textInput.update`。
  2. 用户快速连续输入（如输入 `"ab"` 后紧接 `"abc"`），而 JS 对前一帧 `"ab"` 的 `textInput.update` 回显晚到。
- **根因与实际影响**：
  1. `_PocketTextInputState.fromJson` 在处理不含选区参数的 rect-only 更新时，使用 `TextSelection(baseOffset: ..., extentOffset: ...)` 重新构造了选区，丢弃了 `fallback.selection.affinity` 与 `isDirectional`（重置为默认 `downstream`）。在 `_syncTextController` 中，`controller.value != nextValue` 因此返回 `true`（因为 `TextSelection.==` 比较 `affinity`），导致 Flutter 向原生系统输入法额外发送一次 `TextInput.setEditingState`，在真机键盘动画/滚动期间可能打断中文输入法候选词状态。
  2. `textInput.edit` 与 `textInput.update` 之间没有单调递增的 `revision` 序号；当 JS 端 `createEffect` 回显旧文本时，`_syncTextController` 会直接用旧文本覆盖用户刚刚输入的新字符并清空 `composing` 区间。
- **复现步骤与验证证据**：
  - 编写针对性 Widget 测试（`zz_audit_ime_test.dart`）拦截 `SystemChannels.textInput` 调用实测验证：
    - 当 `controller.value` 处于 composing + `TextAffinity.upstream` 时发送 rect-only `textInput.update({'id': 'field-1', 'rect': ...})`，实测触发了 `TextInput.setEditingState`（调用次数 `1`），且 `affinity` 被篡改为 `TextAffinity.downstream`。
    - 当控制器已输入 `"abc"`（composing `0..3`）时收到迟到的 `"ab"` 回显，控制器文本被回退为 `"ab"` 且 `composing` 变为 `TextRange.empty`。
- **最小修复建议**：
  1. 在 [`pocket_view.dart:1879-1882`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L1879-L1882) 构造 `TextSelection` 时，若 `params['selectionBase'] == null && params['selectionExtent'] == null && fallback != null && selectionBase == fallback.selection.baseOffset && selectionExtent == fallback.selection.extentOffset`，直接保留 `fallback.selection`。
  2. 为 `textInput.edit` 增加递增 `revision` 字段；JS 的 `InputField` 仅在业务侧主动修改值（非原生输入回显）或携带匹配的 `revision` 时才下发 `text + selection`。

---

#### 13. `PocketPackageStore` 并发 `prepare()` 存在文件竞态崩溃、`pruneInactiveVersions` 从未被调用、且每次 `status()` 都在 UI Isolate 全量重算所有历史版本的 SHA-256
- **文件与行号**：
  - 并发 `prepare` 竞态：[`sdk/packages/pocket_services/lib/src/pocket_package.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_services/lib/src/pocket_package.dart#L626-L718)、[`sdk/packages/pocket_services/lib/src/pocket_package.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_services/lib/src/pocket_package.dart#L864-L882)
  - `pruneInactiveVersions` 死代码：[`sdk/packages/pocket_services/lib/src/pocket_package.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_services/lib/src/pocket_package.dart#L829-L853)
  - `listVersions` 重复全量哈希：[`sdk/packages/pocket_services/lib/src/pocket_package.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_services/lib/src/pocket_package.dart#L778-L826)、[`sdk/lib/src/pocket_session.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_session.dart#L163)、[`sdk/lib/src/pocket_session.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_session.dart#L274)、[`sdk/lib/src/pocket_session.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_session.dart#L306)
- **具体触发条件**：
  1. 用户快速连点检查更新，或自动检查更新与手动检查更新并发调用 `updates.checkAndApply()` / `store.prepare()`。
  2. 历经多次热更新后调用 `session.status()`。
- **根因与实际影响**：
  1. `PocketPackageStore.prepare` 无互斥锁；两个并发调用对同一 `versions/<versionId>` 执行 `if (await versionDir.exists()) await versionDir.delete(recursive: true)`，且 `_writeAtomic` 在 `rename` 前先 `delete` 目标文件，导致并发写入共享 `blobs/` 与 `versions/` 时抛 `FileSystemException: Cannot delete file ... PathNotFoundException`。
  2. `pruneInactiveVersions()` 在整个仓库中没有任何调用方，历史版本与资源永不清理。
  3. 每次调用 `PocketSession.status()` 都会调用 `store.listVersions()`，而 `listVersions()` 对 `versions/` 下的**每一个历史版本**都调用 `_loadVersion(id)`，在主 Isolate 同步读取所有 `.qjbc`、`.pak` 和散装资源文件并重新计算 SHA-256。随着历史版本累积，耗时呈线性增长并阻塞 UI 线程。
- **复现步骤与验证证据**：
  - 在复现测试 R3 中执行 `Future.wait([store.prepare(pkg), store.prepare(pkg)])`，20 轮中有 20 轮抛出 `PathNotFoundException`。
  - 全仓搜索 `pruneInactiveVersions`，除定义处与单元测试外，在 `sdk/` 与 `demo/` 中的生产调用数为 `0`。
- **最小修复建议**：
  1. 在 `PocketPackageStore` 内增加异步互斥锁（serializing queue）串行化 `prepare`/`activate`/`commitHealthy`/`rollback`，并在 `_writeAtomic` 中直接调用 `temp.rename(target.path)`（POSIX 原子覆盖，无需先 `delete`）且在临时文件名中加入随机序号避免同微秒碰撞。
  2. `listVersions()` 仅读取并解析 `manifest.json` 元数据，仅在 `_loadVersion` 被 `activate` / `active()` / `lastGood()` 调用时才对目标版本执行磁盘文件 SHA-256 校验；在 `commitHealthy` 成功后自动调用 `pruneInactiveVersions(keep: 2)`。

---

#### 14. 字节码编译将临时目录绝对路径嵌入 `.qjbc` 常量池，导致构建产物非确定性且泄露构建机路径
- **文件与行号**：
  - [`sdk/pocket.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L456-L458)
  - [`sdk/editor/server.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L421)
  - [`sdk/scripts/build_guest.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_guest.ts#L397-L398)
  - [`sdk/native/src/bin/pocketjs_bytecode.rs`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/bin/pocketjs_bytecode.rs#L109)、[`sdk/native/src/bin/pocketjs_bytecode.rs`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/bin/pocketjs_bytecode.rs#L144)
- **具体触发条件**：使用 `bun sdk/pocket.ts build` 或 Editor 构建任意项目两次。
- **根因与实际影响**：
  - `pocket.ts` 和 `editor/server.ts` 每次构建都会通过 `mkdtempSync(path.join(tmpdir(), "pocket-cli-build-"))` 创建带随机后缀的临时目录，`build_guest.ts` 将 `--input <workDir>/app.js` 传给 `pocketjs_bytecode`，而 `pocketjs_bytecode.rs` 直接将该绝对路径作为 QuickJS 模块名（`CString::new(input_label)`）传给 `JS_Eval`。
  - 即使开启了 `JS_WRITE_OBJ_STRIP_DEBUG`，QuickJS 仍会在字节码 Atom 表中保留模块文件名。这导致：
    1. 同一份源码每次构建出的 `app.qjbc` 字节与 `payloadSha256` 均不相同（破坏可重现构建与内容寻址缓存）；
    2. 发布的 `.qjbc` 二进制中明文包含构建机的 `/var/folders/...` 或 `/tmp/...` 路径。
- **复现步骤与验证证据**：
  - 对同一工程指定两个不同 `--work-dir` 构建并比对产物：两份 `app.js` 的 SHA-256 完全一致（`2fd9eb61...`），但两份 `app.qjbc` 的 SHA-256 不同（`8c3d79ee...` vs `3d7b3859...`），二进制 diff 恰好是嵌入的临时目录路径字符串。
- **最小修复建议**：
  - 在 [`sdk/native/src/bin/pocketjs_bytecode.rs`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/bin/pocketjs_bytecode.rs#L144) 中将传给 `compile_bytecode` 的 `input_label` 固定为逻辑名 `"app.js"`（或增加 `--module-name app.js` 参数），仅用 `--input` 读取磁盘文件。

---

#### 15. `PocketHardwareManager.swift` 存在定位回调永久锁死、相机镜头切换绕过生命周期状态、以及 BLE 连接未在 `disposeSession` 断开的资源泄漏
- **文件与行号**：
  - 定位 `hardware_busy` 永久锁死：[`sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift#L928-L947)、[`sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift#L1217-L1232)
  - `switchCameraLens` 状态失步与纹理泄漏：[`sdk/packages/pocket_hardware/lib/src/hardware_plugin.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_hardware/lib/src/hardware_plugin.dart#L451-L456)、[`sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift#L563-L576)
  - `stopCameraPreview` 丢弃挂起的拍照回调：[`sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift#L559)
  - `disposeSession` 未断开已连接 BLE 外设：[`sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift#L127-L149)
  - Demo 停止相机预览后状态仍为 `"ready"`：[`demo/js/state.ts`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/state.ts#L288-L315)
- **具体触发条件**：
  1. 定位权限处于 `.notDetermined` 时调用 `getCurrentLocation`，用户超过 30 秒未点系统弹窗（或系统未回调 `locationManagerDidChangeAuthorization`）。
  2. 停止相机预览后调用 `switchCameraLens`，或在 `startCameraPreview` 挂起期间并发调用 `switchCameraLens`。
  3. 已连接 BLE 外设后宿主热重载或销毁 `PocketSession`。
- **根因与实际影响**：
  1. `getCurrentLocation` 在 `status == .notDetermined` 分支只保存了 `pendingLocationResult = result` 并调用 `requestWhenInUseAuthorization()`，**未启动 `locationWorkItem` 超时定时器**。一旦 Dart 侧 30 秒超时先触发，Swift 侧 `pendingLocationResult` 永远不为 `nil`，后续所有 `getCurrentLocation` 调用均直接返回 `hardware_busy` 错误。
  2. `HardwarePlugin.switchCameraLens` 直接调原生 `switchCameraLens`，而原生层内部调用了 `startCameraPreview` 重新注册纹理，但 Dart 侧既未检查 `_stopped`、也未更新 `_textureId` 或递增 `_previewEpoch`。
  3. `stopCameraPreview` 直接将 `pendingPhotoResult = nil` 而不调用回调，导致正在等待拍照结果的 Future 卡死至超时；`disposeSession` 只取消了 `pendingConnections`，未对已建立连接的 BLE `discoveredPeripherals` 调用 `centralManager.cancelPeripheralConnection`。
  4. Demo 的 [`state.ts:292`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/state.ts#L292) 在收到 `cameraStop` 的 `{ stopped: true }` 后，因 `payload.stopped === true` 将 `cameraPreview.phase` 设为 `"ready"` 而非 `"idle"`，导致停止预览后 UI 仍显示 `"Preview on"` 按钮禁用且残留最后一帧纹理。
- **复现步骤与验证证据**：
  - 静态追踪上述文件与行号确认；且在 [`demo/js/state.ts:288-315`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/state.ts#L288-L315) 中可见 `cameraStop` 走入 `if (action.operation === "cameraStop")` 块后返回 `{ phase: "ready", ... }`。
- **最小修复建议**：
  1. 在 `getCurrentLocation` 的 `.notDetermined` 分支同样调度超时 `DispatchWorkItem`。
  2. 在 `HardwarePlugin.switchCameraLens` 中复用 `startCameraPreview` 的 `_previewEpoch` 与 `_textureId` 更新逻辑；在 `stopCameraPreview` 中若 `pendingPhotoResult != nil` 先回调 `FlutterError(code: "cancelled", ...)`；在 `disposeSession` 中遍历已连接外设调用 `cancelPeripheralConnection`。
  3. 将 [`demo/js/state.ts:292`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/state.ts#L292) 中 `cameraStop` 成功的 `phase` 改为 `"idle"` 并清除 `surfaceId`。

---

#### 16. `PocketView` 与 `PocketPackageManifest` 仍保留 JS 源码回退执行通道，且 `pocket_sdk.dart` 暴露了 ~108 个内部实现类型
- **文件与行号**：
  - 源码执行回退：[`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L115)、[`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L544-L552)、[`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L616-L629)、[`sdk/packages/pocket_flutter/lib/src/pocket_package.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_package.dart#L10)、[`sdk/packages/pocket_services/lib/src/pocket_package.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_services/lib/src/pocket_package.dart#L195)
  - 公共 API 桶文件泄露内部细节：[`sdk/lib/pocket_sdk.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/pocket_sdk.dart#L1-L12)
- **具体触发条件**：
  1. 直接使用 `PocketView(script: ...)` 或构造未设置 `requireBytecode: true` 的 `PocketPackageLoader` / `PocketPackageManifest`（默认 `entryFormat = 'javascript'`）。
  2. 消费方 `import 'package:pocket_sdk/pocket_sdk.dart';`。
- **根因与实际影响**：
  1. 虽然 `PocketSession` 传了 `requireBytecode: true`，但 `PocketView`、`FfiPocketRuntime` 与 `PocketPackageManifest` 仍保留完整的 `pocket_eval` / `pocket_load` / `pocket_load_files` 源码执行分支，且 `PocketPackageManifest` 默认 `entryFormat` 仍为 `'javascript'`，与设计目标“运行时只加载预编译字节码”不完全一致。
  2. `pocket_sdk.dart` 使用无 `show` 过滤的 `export 'package:pocket_flutter/pocket_flutter.dart'` 等语句，将 `PocketCanvasPainter`、`PocketTextLayoutCache`、`FfiPocketRuntime`、`PocketPakImage` 等约 108 个底层内部类和绘制指令结构全部暴露在顶层公共命名空间中。
- **最小修复建议**：
  1. 在 [`sdk/lib/pocket_sdk.dart`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/pocket_sdk.dart#L4-L6) 中使用 `export ... show ...` 仅导出宿主接入所需的公共类型（如 `PocketApp`、`PocketGuest`、`PocketAppConfig`、`PocketUpdateConfig`、`PocketSession`、`PocketPlugin` 等），将底层调试类型放入 `package:pocket_sdk/testing.dart` 或 `internal.dart`。
  2. 将 `PocketView.requireBytecode` 与 `PocketPackageManifest.entryFormat` 的默认值收敛为仅允许 `'bytecode'`。

---

#### 17. `demo/js` 测试文件未注册 `test()` 导致 `bun test` 实际执行 0 个测试，且 `check_architecture.py` 漏检 `demo/lib/` 下的新增 Dart 文件
- **文件与行号**：
  - `bun test` 0 用例：[`demo/js/tests/guest_state.test.ts`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/tests/guest_state.test.ts#L1-L245)、[`demo/js/tests/mobile_ui.test.ts`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/tests/mobile_ui.test.ts#L1-L249)
  - 源码字符串 grep 伪测试：[`demo/js/tests/guest_state.test.ts`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/tests/guest_state.test.ts#L198-L243)、[`demo/js/tests/mobile_ui.test.ts`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/tests/mobile_ui.test.ts#L186-L248)
  - 架构检查脚本只读 `main.dart`：[`sdk/scripts/check_architecture.py`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/check_architecture.py#L72-L83)
  - 脚手架空壳测试：[`sdk/pocket.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L361-L369)
- **具体触发条件**：
  1. 在 `demo/js` 目录运行标准的 `bun test`。
  2. 在 `demo/lib/` 下新增业务页面文件（如 `demo/lib/extra_page.dart` 包含 `Navigator.push`、`StatefulWidget`）后运行 `python3 sdk/scripts/check_architecture.py`。
- **根因与实际影响**：
  1. `guest_state.test.ts` 与 `mobile_ui.test.ts` 仅在模块顶层写了 `assert(...)`，未使用 `bun:test` 的 `test()`/`describe()` 注册用例，导致 `bun test` 报告 `0 pass, 0 fail, Ran 0 tests across 2 files`。同时这两个文件末尾有约 100 行通过 `readFileSync` 对源码做字符串包含检查（例如强制要求保留 2 行的空壳文件 `demo/js/components.tsx`）。
  2. `check_architecture.py` 第 72 行硬编码只读取 `demo/lib/main.dart` 单文件并匹配 4 个正则词，对 `demo/lib/` 下的任何其他 `.dart` 文件完全失察。
  3. `pocket.ts init` 生成的 `test/widget_test.dart` 仅断言 `expect(tester, isNotNull)`，完全未挂载 `PocketApp`。
- **复现步骤与验证证据**：
  - 在 `demo/js` 执行 `bun test`，输出：`0 pass / 0 fail / Ran 0 tests across 2 files`。
  - 在 `/tmp/pocket-audit-arch/archcheck/demo/lib/extra_page.dart` 中写入 `StatefulWidget` 与 `Navigator.push`，运行 `check_architecture.py`，实测仍输出 `OK: Pocket architecture boundary holds`（退出码 `0`）。
- **最小修复建议**：
  1. 用 `import { test, expect } from "bun:test"` 包装 `guest_state.test.ts` 与 `mobile_ui.test.ts` 中的测试逻辑，删除 `readFileSync` 源码字符串断言。
  2. 在 [`sdk/scripts/check_architecture.py`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/check_architecture.py#L72-L83) 中遍历 `demo/lib/**/*.dart` 全部文件并限制总文件数与总行数。

---

### 【P3 / Low】

#### 18. `prepare_upstream.py` 多文件补丁幂等检查仅读取首个目标文件，且仓库 `sdk/.cache/pocketjs` 存在未声明文件漂移
- **文件与行号**：[`sdk/scripts/prepare_upstream.py`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/prepare_upstream.py#L106-L119)
- **具体触发条件**：上游补丁已部分应用或上下文偏移导致 `git apply --reverse --check` 失败并回退到文本检查分支时。
- **根因与实际影响**：当 `git apply --check` 与 `--reverse --check` 均失败时，第 108 行只提取补丁中的**第一个** `+++ b/` 文件路径（例如 `rgba-tileset.patch` 的第一个文件是 `Cargo.lock`），却把整个补丁中后续 `src/*.rs` 的所有 `+` 新增行拿去跟 `Cargo.lock` 比对，必然误判失败。此外，对比干净拉取的 `pocketjs` 与仓库现有的 `sdk/.cache/pocketjs`，发现现有缓存多出了未在脚本中声明的 `assets/fonts/NotoSansCJKsc-Regular.otf`（16.4MB）、`.poc-revision`、`AGENTS.md`、`crates/pocketjs-core/src/lib.rs.orig`，且缺失了上游原有的 `tools/build/`。
- **最小修复建议**：按每个 `+++ b/` 文件块分别校验其对应的 `+` 行；将 `sdk/.cache/` 彻底纳入 `.gitignore` 并清理残留文件。

#### 19. `@pocket/ui` 中 `GlassSurface` 忽略 `registerSurface` 返回值、Demo 路由转场硬编码 `+ 16ms`、压测计时仅测量 Reducer 数组构造
- **文件与行号**：
  - `GlassSurface`：[`sdk/packages/pocket_ui/src/mobile.tsx`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_ui/src/mobile.tsx#L419-L431)
  - 转场固定步长与压测计时：[`demo/js/app.tsx`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/app.tsx#L403)、[`demo/js/app.tsx`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/app.tsx#L459-L464)
- **具体触发条件**：宿主未注册对应原生 surface、在 120Hz 屏幕下切换路由、或在 Showcase 点击运行 Stress Benchmark。
- **根因与实际影响**：
  1. `GlassSurface` 调用 `host.registerSurface(surfaceId, ...)` 后未检查布尔返回值即无条件 `setRegistered(true)`。
  2. `app.tsx:403` 在 `onFrame` 中硬编码 `const next = transition.elapsedMs + 16;`，在 120Hz ProMotion 设备上转场速度会翻倍（耗时减半）。
  3. `app.tsx:459-464` 的 `runStress` 仅对 `dispatch({ type: "runStress" })`（在 JS 中生成数组）前后调用 `nowMs()`，并未包含后续 Layout 与 DrawList 生成耗时。
- **最小修复建议**：`GlassSurface` 使用 `setRegistered(host.registerSurface(...) !== false)`；转场动画改为基于真实帧时间戳差值计算；压测在下一帧 `onFrame` 布局完成后再记录耗时。

#### 20. 文档与脚本引用已不存在的历史路径，`bytecode.rs` 与 `build_guest.ts` 硬编码版本号
- **文件与行号**：
  - 过期文档：[`sdk/docs/VALIDATION.md`](file:///Volumes/ORICO/Development/Github/pocket/sdk/docs/VALIDATION.md#L9)、[`sdk/docs/VALIDATION.md`](file:///Volumes/ORICO/Development/Github/pocket/sdk/docs/VALIDATION.md#L113-L116)、[`sdk/docs/FRAMEWORK_GUIDE.md`](file:///Volumes/ORICO/Development/Github/pocket/sdk/docs/FRAMEWORK_GUIDE.md#L79-L83)、[`sdk/docs/UI_REUSE.md`](file:///Volumes/ORICO/Development/Github/pocket/sdk/docs/UI_REUSE.md#L40)
  - 硬编码常量：[`sdk/native/src/bytecode.rs`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/bytecode.rs#L11)（`QUICKJS_BYTECODE_VERSION: u8 = 26`）、[`sdk/scripts/build_guest.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_guest.ts#L402)（`"--binding-generation", "12"`）
- **根因与实际影响**：`VALIDATION.md` 要求执行的 `./scripts/test_guest.sh`、`packages/pocket_sdk`、`host/test` 均不存在；`QUICKJS_BYTECODE_VERSION` 未从 `rquickjs` 绑定读取而是手写 `26`。
- **最小修复建议**：同步更新 `sdk/docs/*.md` 中的目录结构与测试命令；将 binding generation 与 bytecode version 收敛为单一常量源。

---

## 三、“待验证风险”与“可选改进”

### 1. 待验证风险（受限于当前只读/无真机环境，需在真机或特定环境进一步验证）
1. **iOS / Android 物理真机性能与 120Hz ProMotion 表现**：
   - 本次审核仅在 macOS 与 iOS Simulator 上运行，未连接物理 iPhone/Android 真机。鉴于已确认 [`PocketView`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L810-L848) 存在永久 vsync 空转及 Rust 每帧克隆节点树/DrawList 的问题，在移动真机长时运行下的 CPU 占用、温升降频及 120Hz 下的帧时间抖动需通过真机 Profile 模式实测，不能由模拟器 60 FPS 推导真机达标。
2. **iOS 真机原生硬件链路（相机采集、BLE 外设断连、气压计/磁力计、真实中文九宫格/全键盘高频盲打）**：
   - 模拟器无真实摄像头、蓝牙外设及传感器硬件，[`PocketHardwareManager.swift`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift) 在模拟器下走 fallback 分支。真机相机切后台恢复、权限弹窗打断与真实中文输入法高频连续联想词上屏需在真机验证。
3. **热更新包在 >1 秒后触发 Native 崩溃（SIGSEGV / QuickJS abort）的恢复能力**：
   - 当前 [`PocketSession`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_session.dart#L452-L460) 仅靠挂载后 1 秒 Timer 即调用 `commitHealthy` 将 trial 包晋升为 `lastGood`。若坏包在启动 1.5 秒或用户点击某按钮时触发 Native C/Rust 崩溃（进程直接退出，无法走 Dart `onError`），下次冷启动仍会无限加载该 `lastGood` 包。需验证是否引入启动崩溃计数器（连续 N 次异常退出自动回滚）。

### 2. 可选改进（非功能缺陷，属工程质量与可维护性提升）
1. **热更新签名公钥支持多 Key 轮换（Key Ring）与自定义字段签名覆盖**：
   - [`PocketUpdateConfig`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_config.dart#L10-L20) 目前仅支持单个 `keyId` + `publicKey`，建议改为 `Map<String, String> trustedKeys` 以支持密钥平滑轮换；同时在 [`PocketManifestPayload.canonicalPayload`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_services/lib/src/pocket_package.dart#L298-L320) 中保留或拒绝未知顶层字段，避免签名绕过扩展元数据（复现测试 R9 已证实向已签名 `latest.json` 注入额外顶层字段不会改变 `contentHash`）。
2. **`PocketApp` 默认 `Scaffold` 键盘策略可配置**：
   - [`PocketApp`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_app.dart#L18) 使用默认 `Scaffold(resizeToAvoidBottomInset: true)`，导致键盘弹出动画每一帧都改变 `PocketView` 的 `LayoutBuilder` 约束并触发两次 `display.viewport` 通知（[`pocket_view.dart:445`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L445) 与 [`pocket_view.dart:490`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L490)），建议合并同一帧内的 viewport 通知。
3. **校验 `_readPointerId` 中的 `".."` 路径段**：
   - [`PocketPackageStore._readPointerId`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_services/lib/src/pocket_package.dart#L859) 仅过滤了 `/` 与 `\`，未过滤 `".."`（复现测试 R10 已验证写入 `".."` 会将版本目录解析到父目录），建议复用 `_requireSafeToken`。

---

## 四、已执行测试、结果及未覆盖范围

### 1. 已执行测试与验证汇总

| 类别 | 执行命令 / 测试目标 | 结果 | 说明与证据 |
| :--- | :--- | :--- | :--- |
| **SDK 静态分析** | `flutter analyze`（`sdk/`） | **PASS** (0 issues) | 静态类型分析通过 |
| **SDK 集成测试** | `flutter test test/session_integration_test.dart`（`sdk/` 隔离副本） | **PASS** (3/3) | 验证 `PocketSession` 与 `PocketGuest` 基础挂载 |
| **Flutter 宿主单测** | `flutter test`（`sdk/packages/pocket_flutter`） | **PASS** (26/26) | 覆盖 DrawList 解析、Canvas 绘制、TextInput 基础交互 |
| **服务与热更新单测** | `flutter test`（`sdk/packages/pocket_services`） | **PASS** (14/14) | 覆盖 `PocketPackageStore`、`PocketUpdateCoordinator`、`PocketPluginRegistry` |
| **更新打包脚本单测** | `bun test scripts/tests/package_update.test.ts`（`sdk/`） | **PASS** (10/10, 92 assertions) | 覆盖 Ed25519 签名、manifest 生成与篡改检测 |
| **Editor 服务单测** | `bun test editor/test/editor_server.test.ts`（`sdk/`） | **PASS** (3/3, 57 assertions) | 覆盖基础 CRUD、构建与发布流程 |
| **Demo 宿主单测** | `flutter test`（`demo/test/`） | **PASS** (13/13) | 覆盖 `hardware_plugin_test`、`performance_history_test`、`widget_test` |
| **JS 原生桥探针** | `bun tests/native_guest_probe.ts --required`（`demo/js/`） | **PASS** | 验证真实 `libpocket_flutter.dylib` 下 100/500 节点压测与布局一致性 |
| **JS 状态与组件测试** | `bun tests/guest_state.test.ts` & `bun tests/mobile_ui.test.ts` | **PASS**（直接执行）<br>**WARN**（`bun test` 0 用例） | 直接 `bun <file>` 可跑通，但因未调用 `test()`，`bun test` 报告 `Ran 0 tests` |
| **架构边界检查脚本** | `python3 sdk/scripts/check_architecture.py` | **PASS**（但存在漏检） | 对现有仓库返回 0，但消融实验证实不检查 `demo/lib/` 下的新增 `.dart` 文件 |
| **临时工程全链路验证** | `bun sdk/pocket.ts init` -> `build` -> `flutter build ios --simulator --debug` | **PASS** | 在剥离缓存的 `/tmp/pocket-audit-sdk` 中成功生成 `.qjbc`/`.pak` 并构建出 iOS Simulator `Runner.app` |
| **临时工程 Android 构建** | `flutter build apk --debug`（于 `pocket init` 生成工程） | **FAIL** | `:pocket_flutter` 的 `android/build.gradle` 抛 `NullPointerException` |
| **干净环境上游与 Rust 重建** | 删除 `.cache`、`node_modules`、`target`、`Frameworks/*.a` 后执行 `prepare_upstream.py` + `build_native.sh` | **FAIL**（带 `MACOSX_DEPLOYMENT_TARGET=12.0`）<br>**PASS**（移除后 11.1s 成功） | 证实本机此前能编过 `macos` 依赖了 `ios-sim` 先生成的 `libserde_derive.dylib` 缓存 |
| **损坏字节码防御探测** | 构造 8 种畸形 `.qjbc`（`bad_magic`、`flip_body`、`forged_digest`、`forged_trunc`、`oversize_len`、`short`、`truncated`、`wrong_abi`）喂入 `pocket_probe` | **PASS** (8/8 均安全拦截) | 魔数、版本、ABI、头部长度、SHA-256 摘要及 QuickJS reader 校验均能拒绝且未触发 crash |
| **自定义热更新缺陷复现** | 编写并运行 `audit_repro_test.dart`（R1–R12 共 12 项） | **12/12 执行完成** | 实锤复现：旧版降级攻击成功（R1）、并发 `prepare` 抛 `PathNotFoundException`（R3）、自动回退污染 `previous` 导致 `rollback` 恢复坏包（R6）、旧 OTA 覆盖新版内置包（R8）、额外字段不入哈希（R9）、`..` 指针越界（R10） |
| **自定义 IME 缺陷复现** | 编写并运行 `zz_audit_ime_test.dart`（4 项） | **4/4 执行完成** | 实锤复现：composing 期间 rect-only `textInput.update` 丢失 `TextAffinity.upstream` 并触发多余 `setEditingState`；延迟回显覆盖新输入 |
| **自定义 `PocketGuest` 重建复现** | 编写并运行 `key_test.dart` | **CONFIRMED FAIL** | 实锤复现：父组件重绘传入相同字段的非 `const` `PocketAppConfig` 时，`PocketGuest` 销毁重建 Session |
| **自定义 Editor 安全探测** | 对隔离 Editor 实例发起跨站 `text/plain` POST、Host 投毒、符号链接逃逸与 Bun macro 测试 | **CONFIRMED VULNERABLE** | 实锤复现：CSRF 创建工程/上传/构建/发布、Host 头篡改 `POCKET_UPDATE_URL`、软链越界读写宿主机文件 |
| **iOS Simulator 键盘集成测试** | 在 iPhone Duo (`4D366210-290E-46DB-8BC6-3C5233700409`) 执行 `system_keyboard_lifecycle_test.dart` | **FAIL** (`Actual: <1>, Expected: > 5`) | 无论 `flutter test` 还是 `flutter drive` 均在第 111 行失败 |

### 2. 未覆盖范围与阻碍说明
1. **iOS / Android 物理真机测试**：当前环境无物理真机连接，且未配置 Apple Developer 真机签名证书，未覆盖真机摄像头/蓝牙/传感器硬件调用与真机 GPU/CPU 功耗表现。
2. **Android 运行时测试**：受阻于 `:pocket_flutter` Android Gradle 插件未完成及缺少 Android JNI `.so` 编译链，无法在 Android 模拟器/真机运行。

---

## 五、最优先的 5 项修复与可消融删除的冗余

### 1. 最优先的 5 项修复（Top 5 Priorities）

1. **修复热更新状态机安全闭环（防降级 + 商店升级覆盖 + 修复 `previous` 坏包指针 + 串行锁）**
   - 在 [`PocketUpdateCoordinator.prepare`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_services/lib/src/pocket_update.dart#L210-L325) 中强制校验 `manifest.payload.build > currentBuild`；在 [`PocketSession.initialize`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_session.dart#L114-L163) 中对比内置包与缓存 OTA 包的 `build` 号；在 [`PocketSession._handleRuntimeError`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_session.dart#L263-L268) 回退时清理故障版本，防止 `commitHealthy(fallback)` 将坏包写入 `previous`；为 `PocketPackageStore` 增加异步互斥锁。
2. **收敛本地 Editor 服务安全边界（CSRF / Host 校验 + 禁用符号链接越界）**
   - 在 [`sdk/editor/server.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/editor/server.ts#L628) 校验 `Host` 与 `Origin` 必须为本机地址、写操作强制要求 `Content-Type: application/json`，并在 `source`、`manifest`、`assets` 与 `buildProject` 全路径启用 `lstatSync` / `realpathSync` 边界检查，拒绝符号链接逃逸。
3. **修复 `PocketGuest` 重建生命周期与 `pocket_sdk` 硬件框架强耦合**
   - 移除 [`PocketGuest`](file:///Volumes/ORICO/Development/Github/pocket/sdk/lib/src/pocket_app.dart#L32) 的 `ValueKey(config)`（或为 `PocketAppConfig` / `PocketUpdateConfig` 实现完整值相等），防止父组件重绘销毁 JS VM；将 `pocket_hardware` 从 `pocket_sdk` 核心包解耦为按需接入，将权限校验从插件级下沉到方法级。
4. **消除 `PocketView` 静止画面 60/120Hz 空转与 Rust 每帧全量克隆**
   - 在 [`sdk/native/src/lib.rs`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/lib.rs#L1361-L1475) 与 [`PocketView`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_view.dart#L810-L848) 引入脏标记与按需唤醒机制，静止帧跳过 `relayout_outputs` 与 `words`/`nodes` 克隆并暂停 Ticker；修正 [`PocketPerformanceWindow`](file:///Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_flutter/lib/src/pocket_performance.dart#L24-L64) 避免将 `unchanged` 空帧计入渲染 FPS。
5. **修复跨平台构建链与确定性字节码输出**
   - 修复 [`sdk/scripts/build_native.sh`](file:///Volumes/ORICO/Development/Github/pocket/sdk/scripts/build_native.sh#L17) 中全局 `MACOSX_DEPLOYMENT_TARGET=12.0` 导致的干净环境编译失败；在 [`pocket.ts`](file:///Volumes/ORICO/Development/Github/pocket/sdk/pocket.ts#L69-L76) 支持 `--sdk-root <dir>` 空格参数与 native 源码 mtime 校验；在 [`pocketjs_bytecode.rs`](file:///Volumes/ORICO/Development/Github/pocket/sdk/native/src/bin/pocketjs_bytecode.rs#L144) 使用固定逻辑模块名 `"app.js"` 替代临时目录绝对路径；补齐或移除未完成的 Android 插件声明。

---

### 2. 可通过消融验证删除的冗余（Ablation Candidates）

| 序号 | 建议删除的目标文件 / 目录 | 为什么是冗余 | 如何比较（消融验证步骤） | 证明可删的判定标准 |
| :--- | :--- | :--- | :--- | :--- |
| **1** | [`demo/js/ui/index.tsx`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/ui/index.tsx#L1-L6) (6 行)<br>[`demo/js/ui/mobile.tsx`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/ui/mobile.tsx#L1-L2) (2 行)<br>[`demo/js/legacy.ts`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/legacy.ts#L1-L2) (2 行)<br>[`demo/js/components.tsx`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/components.tsx#L1-L2) (2 行) | 均为旧目录迁移遗留的纯 `export * from "@pocket/ui..."` 转发垫片；全仓无任何运行时代码引用它们（仅 [`guest_state.test.ts:207`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/tests/guest_state.test.ts#L207) 用 `readFileSync` 硬编码检查了 `components.tsx` 的字符串）。 | 1. 移除 `guest_state.test.ts:207` 对 `components.tsx` 的文件读取断言并删除上述 4 个文件；<br>2. 执行 `bun sdk/pocket.ts build demo/js --flutter-dir=demo`；<br>3. 运行 `bun demo/js/tests/native_guest_probe.ts --required` 与 `flutter test`（`demo/`）。 | 生成的 `demo/assets/app.js` 与删除前字节完全一致（SHA-256 相同），且所有测试 100% 通过。 |
| **2** | [`sdk/migrations/pocket_flutter_poc-source-20261102.tar.gz`](file:///Volumes/ORICO/Development/Github/pocket/sdk/migrations/pocket_flutter_poc-source-20261102.tar.gz) (60 MB)<br>及 `sdk/migrations/*.json` (~3,900 行) | 旧 PoC 仓库的全量历史源码压缩包与迁移快照清单，存放在公共 `sdk/` 目录下导致 SDK 体积膨胀 60MB，且无任何构建或运行时代码引用。 | 1. 将 `sdk/migrations/` 移出工作区；<br>2. 执行 `prepare_upstream.py`、`pocket.ts init`、`pocket.ts build` 及全部 Dart/Bun 测试。 | 所有构建与测试结果与移除前完全一致，SDK 目录体积减少 60MB。 |
| **3** | `sdk/.pocket-build/`（含 407KB `app.js` 与 `editor-workspace/`）及 `sdk/.cache/pocketjs/assets/fonts/NotoSansCJKsc-Regular.otf`（16.4 MB） | 本地运行遗留的临时构建产物与未被任何上游补丁或脚本引用的 16.4MB 字体文件。 | 1. 删除 `sdk/.pocket-build/` 与该 `.otf` 文件；<br>2. 运行 `python3 sdk/scripts/prepare_upstream.py` 与 `bun sdk/pocket.ts build demo/js --flutter-dir=demo`。 | `prepare_upstream.py` 校验通过，构建出的 `.qjbc` 与 `.pak` 内容完全不受影响。 |
| **4** | [`demo/assets/guest-manifest.json`](file:///Volumes/ORICO/Development/Github/pocket/demo/assets/guest-manifest.json#L1-L44) 等 `demo/assets/` 下的构建产物与 [`demo/js/manifest.json`](file:///Volumes/ORICO/Development/Github/pocket/demo/js/manifest.json#L1-L44) 的源码重复跟踪 | `demo/assets/guest-manifest.json`、`app.qjbc`、`app.pak`、`app.bytecode.json` 均由 `build_guest.ts` 从 `demo/js/` 自动生成并覆盖，两个 manifest SHA-256 完全相同（`36009b65...`）。 | 1. 删除 `demo/assets/{app.qjbc,app.pak,app.bytecode.json,guest-manifest.json}`；<br>2. 执行 `bun sdk/pocket.ts build demo/js --flutter-dir=demo`（修复临时路径模块名后）。 | 4 个产物文件全部由单源 `demo/js/` 自动完整重建，`flutter test`（`demo/`）全部通过。 |
