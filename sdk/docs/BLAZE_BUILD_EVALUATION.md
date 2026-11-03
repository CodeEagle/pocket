# Blaze 对 Pocket Rust 构建的适用性

2026-11-03，只读评估。对象为 [indexable-inc/blaze](https://github.com/indexable-inc/blaze)，源码固定在 `dae0fad151a71e077fcb4568e53190f59337c5e3`。没有安装 Blaze、切换工具链、启动 daemon，也没有 Pocket 的 Blaze 构建实测。

结论：当前不能替代 Pocket 的正式原生库构建；可以作为 Apple Silicon 上 Rust 单测/增量开发的隔离实验候选。它加速编辑后的编译与链接，不能据此推断 App FPS、输入延迟或设备功耗改善。产品能力仍由 JS 实现，不为接入构建工具增加 Dart 逻辑。

## 与当前 SDK 的对应关系

Pocket 的 `native/Cargo.toml` 同时声明 `cdylib`、`staticlib`、`rlib`。`scripts/build_native.sh` 用 Cargo 为 macOS/iOS 生成 `.a`，为 Android 生成 `.so`；`native/build.rs` 和 `rquickjs-sys` 还涉及 C 编译、QuickJS headers、clang/SDK 和移动端 bindgen。不能只看 Rust 文件能够编译就认为 Flutter 产物可用。

| 路径 | Blaze v2 当前证据 | 判断 |
| --- | --- | --- |
| macOS/iOS `.a` 打包 | 文档拒绝 staticlib/dylib；源码在含 cdylib 的混合声明下先选择 Shared，但不会补出所需 `.a` | 不能替换现有正式库构建 |
| iOS、iOS Simulator、Android | linker target 列表没有 `aarch64-apple-ios`、`aarch64-apple-ios-sim`、`aarch64-linux-android` | 当前不接入移动交叉构建 |
| Apple Silicon 本机 Rust unit tests | test mode 优先归类为 executable；macOS arm64 在支持列表内 | 值得隔离验证，尚未证明 Pocket 能构建 |
| 本机 cdylib/探针 | Shared 输出有实现，仍需验证 C 依赖、符号和 FFI | 候选实验，不等于静态打包可用 |
| JS 页面日常迭代 | `scripts/build_guest.ts` 通过 Bun 与既有 `pocketjs_bytecode` 生成 QJBC；只改 TS 时没有 Rust 函数需要重编译 | Blaze 不直接加速 JSX 打包、QuickJS 字节码编译或 JS 热更新，需单独测其构建启动开销 |
| build.rs / C / bindgen | build scripts 在 sandbox 中运行；只读机器目录，允许写 OUT_DIR，调用环境被传入 | 必须实际验证 clang、registry、SDK 与链接指令，不凭通用支持作保证 |
| 工具链 | Blaze 使用自己的 dated nightly，忽略项目的 rustup/toolchain 选择 | Cargo Rust 1.93.1 验证继续保留 |
| Release/LTO | 有 release LLVM backend；linker 不做跨模块 LTO | 不以它替换最终性能构建 |
| 资源成本 | 常驻 daemon 用内存保存编译状态，不自动退出；官方注明更高内存/磁盘占用 | 实验需要记录峰值内存、缓存体积并清理自己的 daemon |

## 一手证据

- [crate-type 实际分支](https://github.com/indexable-inc/blaze/blob/dae0fad151a71e077fcb4568e53190f59337c5e3/crates/blaze-cargo/src/serve/unit/codegen.rs#L52-L72)：test/bin、cdylib、staticlib/dylib 的判定顺序。
- [target parser](https://github.com/indexable-inc/blaze/blob/dae0fad151a71e077fcb4568e53190f59337c5e3/crates/blaze-link/src/target.rs#L375-L408)：当前链接目标集合。
- [Cargo 兼容说明](https://github.com/indexable-inc/blaze/blob/dae0fad151a71e077fcb4568e53190f59337c5e3/docs/cargo.md)：工具链、构建脚本 sandbox、命令和不支持的产物；v2 不把失败构建自动交回 Cargo。
- [linker 说明](https://github.com/indexable-inc/blaze/blob/dae0fad151a71e077fcb4568e53190f59337c5e3/docs/linker.md)：链接与 LTO 边界。
- [官方 benchmarks](https://github.com/indexable-inc/blaze/blob/dae0fad151a71e077fcb4568e53190f59337c5e3/docs/benchmarks.md)：页面明示全部数字属于 v1，v2 于 2026-10-30 替换 v1 后尚无已发布测量。不能把宣传的最高倍数用于 Pocket 或当前 v2。

## 最小消融实验

正式源码和默认构建脚本保持原状。使用临时副本、独立 Blaze home/cache，固定 Blaze commit、相同源码与功能测试。上游准备是已有外部前置步骤，不能让 trial 漏掉它。

1. 先尝试原样 host `blaze test --lib`，验证 C/QuickJS/proc macro 兼容；若失败，记录具体错误，不为了跑通而删掉真正的 Worker/IO 或更换引擎。
2. 若需单独诊断产物类型，仅在临时最小工程分别验证 cdylib、rlib、static C 依赖；它们的通过不能代替 Pocket 通过。
3. 比较 Cargo 与 Blaze 的冷构建、无修改、单函数编辑、函数签名编辑、C 源码编辑；每组重复取中位数，同时记录峰值 RSS、磁盘、daemon 常驻成本。区分首次加载和 warm edit。
4. 对实际生成的 host 库运行同一组 QuickJS/QJBC、duplex、Worker HTTP、录制离线回放与 FFI 测试，检查导出符号。Cargo 的 check/test 保持独立基线。
5. 只有兼容和 warm edit 收益成立，才加显式可选的开发命令；不修改默认 Cargo/CI，不新增运行时依赖或 polling。iOS/Android 等待官方对应目标与产物支持。

当前只有源码兼容性结论，没有加速倍数或省电百分比结论。
