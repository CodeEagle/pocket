# Windows 预编译工具包与验收边界

Windows 的产品使用路径是 Node.js 22.22.2+（建议 Node.js 24 LTS）、npm 和 CI 生成的
`@pocket/tools-win32-x64@0.1.1`。产品开发者不需要 Rust、Cargo、Python、
`patch`、Visual Studio 或 C++ 编译器。Rust/MSVC 和 C/C++ 只属于发布者在
Windows CI 上生成平台包的步骤。

## 发布者构建

发布工作流位于 [`.github/workflows/toolchain.yml`](../../.github/workflows/toolchain.yml)。
Windows 2022 runner 使用 MSVC、Windows SDK 和 Rust 1.98.1，下载已经生成的
通用 Web engine，然后准备固定版本的 PocketJS 源码并构建两个发布二进制：

```powershell
cd sdk
npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund
python scripts/prepare_upstream.py
bun install --frozen --cwd .cache/pocketjs

# Noble 的 install 脚本只执行 node-gyp-build；发布者必须明确编译 N-API addon
# node-gyp configure + the generated Visual Studio solution are required;
# passing /p: properties through `node-gyp build` turns them into /t switches.
node node_modules/node-gyp/bin/node-gyp.js configure `
  --directory node_modules/@abandonware/noble
msbuild node_modules/@abandonware/noble/build/binding.sln `
  /p:Configuration=Release /p:Platform=x64 `
  /p:WindowsTargetPlatformVersion=10.0.26100.0

cargo build --locked --release --manifest-path native/Cargo.toml `
  --bin pocket_probe --bin pocketjs_bytecode
bun scripts/package_toolchain.ts `
  --out=.pocket-build/toolchain-package --force
cd .pocket-build/toolchain-package
npm pack --ignore-scripts
```

产物是 `pocket-tools-win32-x64-0.1.1.tgz`。打包器会把
`@abandonware/noble` 的 `build/Release/binding.node` 复制到
`noble/prebuilds/win32-x64/node.napi.node`，并在 `manifest.json` 中记录哈希。
SDK 启动时通过 `@ABANDONWARE/NOBLE_PREBUILD` 让 `node-gyp-build` 读取这个
文件；用户安装时不会重新编译。Windows Noble 使用包内的 WinRT binding，
其 gyp 配置位于 `node_modules/@abandonware/noble/lib/win/binding.gyp`；CI 当前
显式使用 Windows SDK 10.0.26100.0。

`@abandonware/bluetooth-hci-socket` 使用 node-pre-gyp 的包内加载路径，当前
没有可由 Pocket 平台包覆盖的外部 prebuild 入口，因此 manifest 会明确写入
`hci.included: false`。Windows Noble 走 WinRT，不依赖该 Linux HCI addon。

## C11 原子支持

固定上游的 worker C 源码使用 `<stdatomic.h>` 和 C11 原子操作。发布侧的
`sdk/native/build.rs` 在 MSVC target 上传递 `/std:c11` 与
`/experimental:c11atomics`，与 pinned `rquickjs-sys` 的 Windows 编译参数保持
一致。没有这两个参数时，worker 或 QuickJS C 编译会在 MSVC 的
`stdatomic.h` 阶段失败。

Rust native 代码对 Windows 排除了 `clock_gettime` 声明，并使用通用时钟回退；
不需要额外的 POSIX shim。其余 QuickJS C ABI、bytecode 编译器和 probe 都由
同一 pinned revision 生成，不能替换为系统 `qjsc` 或 source-eval fallback。

## 用户安装与检查

拿到 SDK 导出包后，Windows 用户只运行：

```powershell
npm run setup
npm run doctor
npm run build:guest -- --project-root C:\work\app --outdir C:\work\app\dist
npm run editor
```

`setup` 会按 `win32/x64` 解析平台包，校验 SDK revision、QuickJS ABI、文件大小
和 SHA-256，并使用 npm 管理的 Bun。平台包缺失或校验失败时会直接报错，不会
偷偷调用本机 Rust 或 C++。

## 必须完成的 Windows 验收

CI 生成包后，先在一个没有源码缓存和 `native/target` 的干净 Windows 目录中
执行 `npm run setup` 与 `npm run doctor`。然后检查：

1. `manifest.json` 的 `platform` 为 `win32`、`arch` 为 `x64`，Noble 为
   `included: true`，且 `node-gyp-build.resolve` 指向平台包内的
   `noble/prebuilds/win32-x64/node.napi.node`；消费者目录没有
   `@abandonware/noble/build/Release/binding.node`。
2. App 和 Game 模板分别生成真实 `app.qjbc`、`app.pak`，Native Preview 的
   主题、计分、暂停/继续由输入驱动产生帧变化。
3. Noble 在 Windows 上报告 `poweredOn`，扫描、连接、GATT read/write 和
   notify stream 均返回真实数据；notify 必须能被 `@pocket/tftc` 解析成字段级
   `change`，不能用写入成功回调补造状态。
4. 退出 Preview 后连接、通知流和 helper 进程都释放，重复启动仍固定使用
   8791 端口。

GitHub 的 Windows runner 没有 DK-META2 等待验收的硬件，云端只能验证
WinRT addon 加载、模拟 IO 和 Preview 路由；不能把 CI 绿灯写成 Windows
BLE 实机通过。真实 DK-META2 连接、notify、battery 和断连仍需在带 BLE
适配器的 Windows 机器上运行上述步骤并保存日志。当前工作区已完成
macOS Noble 实机验收，Windows 平台包构建和 Windows 硬件验收仍以 CI/实机
结果为准。

## 来源与保留边界

实现前检查了保留父工程
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`（排除旧的
`pocket_host/`），以及 BLE 参考工程
`/Volumes/ORICO/Development/TryJoy.c/TryJoyMono/App/repos/dokidoki` 的
Noble 依赖和 transport 约定。Pocket 侧保留的关键路径是：

- `sdk/native/Cargo.toml`：固定 Rust/QuickJS native 依赖；
- `sdk/native/build.rs`：worker C 适配、MSVC C11 原子编译参数；
- `sdk/editor/native/noble-bluetooth.mjs`：Preview JSONL 到 Noble 的薄映射；
- `sdk/scripts/package_toolchain.ts`：平台二进制、ABI、Noble prebuild 和哈希
  清单；
- `sdk/scripts/prebuilt_tools.mjs`：平台包选择、完整性校验和 Noble scoped
  prebuild 环境变量；
- `.github/workflows/toolchain.yml`：Windows 2022 发布矩阵。

业务协议、TFTC notify 解析和状态编排仍在 JS；Flutter 后续接回
`flutter_blue_plus` 时只需遵守同一 transport contract，不应在 Dart 再建一套
TFTC 状态机。

## Bootstrap 与 Windows CI 当前状态

Pinned archive 的内容没有变化；失败根因是 GNU `patch` 对旧 unified-diff
hunk 的上下文计数和边界比 macOS 的 `patch` 更严格。六个受影响 patch 已按
实际 before/after 文件用标准三行上下文重新生成，语义保持 byte-for-byte
一致。`/tmp/pocket-check-hybrid.log` 记录了 GNU patch 的首次应用、第二次
幂等验证，以及最终 source 与预期结果相同；bootstrap 脚本没有加入 fuzzy 或
fallback 分支。

Windows 编译已在 CI 运行 `e6f337e`（run `42201916294`）完成：Noble WinRT
binding、Rust 两个 exe、static CRT 和 `dumpbin /dependents` 检查均通过。
Noble 使用 `node-gyp configure` 后直接调用 `MSBuild` 生成的 solution，并显式
传递 `/p:Configuration=Release /p:Platform=x64`
`/p:WindowsTargetPlatformVersion=10.0.26100.0`；不能把这些 `/p:` 参数交给
`node-gyp build`，因为它会转换为错误的 `/t` 参数。CI 使用 Rust 1.98.1。

随后提交 `fcc6e1f`（run `42203495372`）补充了 consumer 日志和验收前的包上传，
当前仍在运行；此前发现 optional platform dependency 在 consumer 安装中被省略，
因此在该 run 完成前不宣称 Windows npm consumer/Preview 已通过。GitHub runner
没有 DK-META2，不能替代 Windows BLE 实机的连接、notify、battery 和断连验收。
