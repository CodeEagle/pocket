# Flutter 3.50 工具链升级

日期：2026-11-13。

## 来源和范围

已 fetch `origin/research/flutter-3.50-nativeapi`，评估提交 `500ac4f`；保留其
[研究记录](FLUTTER_3_50_NATIVEAPI_EVALUATION_20261113.md)，其中“未接入”和旧版本描述是研究当时的状态。
本轮实施仅升级 Flutter 工具链，nativeapi provider 不在本次范围内。公共包最低约束保持
Flutter >=3.35.0 / Dart ^3.9.2，PocketJS revision、QuickJS 字节码链和原生 ABI 均保持不变。

用户授权忽略当前机器不存在的 `/Volumes/ORICO/...` 工作路径，直接在
`/Users/lincoln/Develop/GitHub/FPKit/pocket` 工作，并在 Argon Low 额度耗尽后改由 Codex 执行。
保留父工程 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` 不在本机；当前
`/Users/lincoln/Develop` 下也未找到该目录。本轮未新增原生能力或重写迁移实现，复用
`INPUT_REUSE.md` 已记录的来源和当前保留的输入/FFI/绘制回归场景。

当前 main 工作区原有暂存、未暂存和 unmerged index 均保留；没有合并研究分支与本地间的
其他历史提交。变更前工作文件、binary diff 和 index 备份在
`/Users/lincoln/.codex/backups/pocket-flutter-350-20261113-165006`。

## 适配

- 项目 `.fvmrc` 与本机 FVM default 使用 Flutter 3.50.0。
- CI 的 Flutter action 从 `.fvmrc` 读取固定版本，不再跟随浮动 stable。
- 更新实际受影响的 pub lockfiles 和当前工具链文档；历史验收记录保留旧版本。
- 保留现有 Flutter 绘制、生命周期、IME 边界与 JS 业务逻辑。
- 复用研究分支已有的 `sdk/test/pocket_bundled_application_catalog_test.dart` 修正：
  实际 SystemUI 有 policy、recording、diagnostics、runtime、platform-proxy 五个工厂；
  原断言仍为四个。保留对最后一个 provider ID 的明确校验，没有删除或放宽测试。

## 验证

实际工具链：Flutter **3.50.0 stable**，framework
`ab2912035e160d9cad6306df307576da6128ebdb`，engine
`371f77202a73e8dff57a8b3bff75bca55c090aee`，Dart **3.14.0**。
`flutter doctor -v` 无问题；项目 `.fvm/flutter_sdk`、本机 `~/fvm/default`
都指向 `/Users/lincoln/fvm/versions/3.50.0`，VS Code 继续使用 `.fvm/flutter_sdk`。

| 检查 | 本轮结果 |
| --- | --- |
| 3.47.9 同源码基线 | duplex pointer、pointer order、真实 JS move/delete 像素三项通过 |
| pocket_flutter analyze | exit 0，仅 24 条 Material 入口弃用信息 |
| pocket_flutter 全量测试 | 277 项通过，设置真实 native library 和 buildGuest capture fixture，无跳过 |
| pocket_services analyze / test | 无分析问题，89 项测试通过 |
| SDK analyze | exit 0，16 条 info；包括 Material 弃用和已有不必要 import |
| SDK 全量测试 | 200 项通过，10 项因未提供额外 Worker/update/recording/on-demand fixture 而跳过；真实 native library 已设置 |
| Showcase analyze | exit 0，5 条 info；包括 Material 弃用及已有 package dependency/doc 提示 |
| Showcase 全量测试 | 补齐本机构建资源后 54 项全部通过；初次缺少 Lantern QJBC 的失败已解决 |
| Showcase macOS debug build | 官方 Core 安装并重新 pod install 后成功，生成 `demo/build/macos/Build/Products/Debug/pocket_host.app` |
| 四个入口的锁文件 | pocket_flutter、pocket_services、sdk、demo 的 `pub get --offline --enforce-lockfile` 均通过；CI 同步启用锁文件强校验 |

`pocket_view_capture_native_test.dart` 使用原有
`test/fixtures/scene_capture/app.tsx`，经过同一 pinned buildGuest → QuickJS
QJBC/PAK → FFI → PocketView 路径，真实 pointer tap 后输出 PNG 从红色
`#ed2839` 变为绿色 `#25bd62`，并校验边界外宿主像素未混入。
这是 Flutter test 软件渲染验收，不冒称硬件 Impeller、iOS/Android 真机、系统中文候选栏
或输入延迟性能验收。后者本轮未执行。

临时日志、QJBC 和 before/after PNG 位于 `/tmp/pocket-flutter-350-validation/`；
缓存、SDK 二进制和日志不作为源码提交。

## 本机安装与复现

正常安装入口为 `fvm install 3.50.0`、`fvm use 3.50.0 --skip-pub-get`
和 `fvm global 3.50.0`。本机 FVM 首次安装因 Git bare-cache 配置和完整 clone
网络中断失败，因此从官方仓库浅克隆精确 tag 到 FVM version 目录，核对 revision 后
在该 SDK checkout 建立 stable 分支；未修改 SDK 源码或伪造版本。
Dart/engine 下载临时使用 `FLUTTER_STORAGE_BASE_URL=https://storage.flutter-io.cn`，
该环境变量未写入全局配置。旧 3.47.9 SDK 保留可用于对照。

本机 Rust 1.93.0 的剥离步骤使 dylib 的 LINKEDIT 字符串表错位，3.47.9 基线也会
被 macOS 27 dyld 拒绝加载。使用
`RUSTC_WRAPPER= cargo rustc --release --locked --lib -- -C strip=none`
重新生成可加载的同源码验证库；未改公共 Cargo profile 或替换 runtime。
上游问题参考：https://github.com/rust-lang/rust/issues/157750 。

本机已有字体工作区改动使默认 `prepare_upstream.py` 在
`host-native-fonts.patch` 的 `tools/build.ts` hunks 上拒绝重复应用。本轮保留原文件，
该失败记入 `build-guest.log`；capture fixture 通过现有 `POCKET_COMPILER_PATH`
显式使用已安装 revision `99924de47c62fa36f526a8791055d91cbbdb3836` 的真实编译器，
没有加入替代编译器或 mock 路径。命令：

```sh
POCKET_SOURCE_BUILD=1 \
POCKET_COMPILER_PATH="$PWD/sdk/.cache/pocketjs/tools/build.ts" \
npm exec --yes --package=bun@1.4.4 -- bun sdk/scripts/build_guest.ts \
  --project-root=sdk/packages/pocket_flutter/test/fixtures/scene_capture \
  --outdir=/tmp/pocket-flutter-350-validation/scene-capture/assets

cd sdk/packages/pocket_flutter
POCKET_NATIVE_LIBRARY="$PWD/../../native/target/release/libpocket_flutter.dylib" \
POCKET_VIEW_CAPTURE_FIXTURE_DIR=/tmp/pocket-flutter-350-validation/scene-capture \
POCKET_VIEW_CAPTURE_ARTIFACT_DIR=/tmp/pocket-flutter-350-validation/scene-png \
flutter test --no-pub --reporter expanded
```

## 剩余边界

初次 Showcase 验收的两项缺件已在用户要求继续本机编译后补齐。
用户明确接受开发条款后，运行既有 `packages/pocket_live2d/scripts/bootstrap_cubism_core.sh`，
官方 Native R5 ZIP 校验 SHA-256
`7ff3a4bbc19c0a8728965aa522ab77eb11b252916453e68a8a78d3b71188bb12` 通过；
生成 iOS/macOS XCFramework 并注册到现有 plugin，未引入替代 Core。
运行既有 `prepare_textures.ts` 和 `prepare_live2d.ts`，准备 19 张运行纹理、
1 份 SVG 和经过逐文件哈希校验的 Hiyori 模型，再使用原 buildGuest 生成 Lantern。
缺失的 Spine 依赖按 `sdk/bun.lock` 中的 `@esotericsoftware/spine-core@4.3.13` 安装到本机
node_modules，未修改包版本或源 lockfile。
Lantern 实际产物为 QJBC 1,218,814 bytes、PAK 69,631,776 bytes；payload SHA-256
`9081be97f48cc46f72d2e743a94f897b5272b506ab958ea3fb39f9b3351b5338`。
产物暂存到既有 `demo/assets/apps/lantern/` 路径，生成缓存不作为新增源码提交。
Core 安装后重新 `pod install`，解决初次 Pods 中未包含 vendored archive 导致的链接错误。
3.50 提示 macOS 三个本地插件仍经 CocoaPods，而非 SwiftPM；本轮保留原注册路径。
shader 编译还提示 `liquid_glass.frag` 中 sampler 与多 return 在 Windows 可能存在风险，
本轮 macOS test shader 编译成功，Windows 未验证。

Material 旧导入在 3.50 仍可工作，当前保持源码最低版本约束。
独立 Material 包迁移和 nativeapi provider 需要单独的支持矩阵与实际平台验证。


## 汇总复核

按用户指定由 Codex 完成本轮汇总复核，没有取得独立 Argon Medium 审查结果。
检查版本 pin、CI 的 `.fvmrc` 单一来源、四份 pub lockfile 的强校验、原生与编译器
revision、真实 QJBC 输入到 PNG 的证据以及缺件/跳过边界。
变更前备份中的 48 个原有工作文件内容逐一比较一致，原 staged binary diff 和
unmerged entries 也一致；Git index 的 stat-cache 刷新不表示暂存内容改变。
本轮提交只包含工具链配置、依赖锁文件、研究分支已有回归修正和文档变更；原有未提交工作独立保留。

## 本机 Showcase 补验（2026-11-13）

- `flutter test --no-pub --reporter expanded`：54/54，通过；日志 `demo-test-final.log`。
- `flutter build macos --debug --no-pub`：成功；日志 `demo-build-macos-final.log`。
- 现有 `novel_model_showcase_test.dart` 首次实际 macOS drive 在 Hiyori 说明文本断言失败；按现有 macOS 参数重新编译并替换旧 Pocket 静态库后，同一测试与相同 QJBC 在 01:03 内通过，exit 0，`model-showcase` checkpoint 完成。覆盖双页纹理/遮罩、动画顶点变化、后台恢复、退出释放、重新进入，以及主线自动存档不变。
- 本机链接器提示部分既有 archive 的 deployment target 高于宿主声明的 macOS 12；
  本轮只验收当前 macOS 27.2，不声称验证了旧 macOS 系统。

本机 Pocket 静态库补建使用 `MACOSX_DEPLOYMENT_TARGET=12.0` 和 target 专用
`-C link-arg=-mmacosx-version-min=12.0`，保留 Cargo.lock 和同一引擎；strip -S 后
复制到原有 macOS Frameworks 路径。打包库 SHA-256：
`225cfd200cf1b20972b6bb0f49b6bd1c7390e8c4164709170b33fb9f3dd33631`。

- 官方 Core bridge 专项：`run_macos_core_bridge_test.sh` 在 Flutter 3.50 上 3/3 通过，
  覆盖 Mao/Hiyori 真实形变、二进制响应预算和 update/dispose 后快照独立性；日志
  `live2d-core-bridge.log`。

补验最终报告：`demo/build/integration_response_data.json` 的 required/completed
均为 `["model-showcase"]`；报告与四张模型 PNG 已复制到
`/tmp/pocket-flutter-350-validation/model-showcase-evidence/`。实际图像经查看可见完整 Hiyori。
