# 视觉小说高分辨率静态纹理

## 范围与复用来源

本改动只放宽 PAK 静态 `ui:img.*` 项的尺寸边界：宽和高分别要求为 2 的幂，最大 2048。通用纹理仍限制为 512，覆盖原始 `uploadTexture`、字体图集、Sprite 图集和 TILESET 单 tile。PAK 头、IMG 字段宽度、纹理句柄、UV 格式和 Flutter 解码协议均未改变。

保留的父工程 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`（检索时排除 `pocket_host/`）没有可复用的高分辨率 PAK IMG 上传实现或 Live2D 静态纹理管线。`lib/render/pocket_ui_components.dart` 有 `RepaintBoundary` 与 GPU 缓存的展示说明，但不是 PAK 资产解码/上传代码。本仓库现有 pinned 实现因此保留，只在其静态 IMG 路径加专用上限。

可复现来源是 `sdk/native/patches/image-high-resolution-pak.patch`，由 `sdk/scripts/prepare_upstream.py` 对固定 revision `99924de47c62fa36f526a8791055d91cbbdb3836` 应用。`.cache/pocketjs` 只用于 bootstrap 和测试，不是交付源文件。

## 尺寸边界与下游行为

- 合同定义保留 `TEX_MAX_DIM = 512`，另定义 `IMG_MAX_DIM = 2048`；Rust 规格常量由 `contracts/spec/gen-rust.ts` 生成。
- `framework/compiler/pak.ts::encodeImageEntry` 对静态 IMG 检查 2 的幂和 2048 上限。宽、高继续编码为 PAK IMG 头的 `u16`；2048 可直接表示。
- Core 的 `upload_texture_flags` 仍使用 512 上限；只有 `upload_img_entry` 调用同一解码/分配逻辑时传入 IMG 上限。Sprite 和 TILESET 没有随之放宽。
- Core 的 `Texture` / `TexView` 将宽高保留为 `u32`，纹理读取和 `texture_at` 不含 512 截断。PMS1 顶点 UV 是 0..1 归一化值，`TEX_TRI` 继续携带纹理句柄和顶点 ABGR 调制色；尺寸不进入 mesh 格式。
- Native `FrameResource` 使用 `u32` 宽高并从 `TexView` 复制像素。Flutter `PocketAssets._decodeEntry` 从 IMG `u16` 读取尺寸并分配 RGBA 像素，没有额外的 512 上限。
- Core 的 `load_assets` 在临时 `Ui` 中解析和上传全部资源，全部成功后才提交到当前 Core。坏图像返回错误，不会留下半安装的资源组。单项上传在尺寸、payload、RLE 解码验证完成前不调用 `tex_alloc`；验证测试检查失败后纹理槽数不变，RLE 临时缓冲随失败路径释放。

2048×2048 的 RGBA8 纹理本身占 16 MiB。Core 上传、Native `FrameResource` 复制、PAK/Dart RGBA 解码和宿主图像纹理可能同时持有副本。Native binary frame 上限为 64 MiB；该值限制一帧编码后的总资源，不代表每个 2048 图片都能与任意数量的其它大资源一起传输。目标设备应按完整 PAK 与峰值内存验收，不能仅按单张尺寸推断内存安全。

## Host 与编译器兼容

当前 PAK 格式版本仍为 1，QJBC `runtimeAbi` 仍描述 QuickJS 字节码 ABI，不包含最大静态 IMG 尺寸。预编译工具清单对编译器文件做 SHA-256 完整性校验，但 Host 不会拿该工具清单与自身的 IMG 能力协商。因此，新编译器生成 1024/2048 IMG 后，必须搭配包含本补丁的 Native Core；旧 Core 的 512 检查会在资产安装时明确拒绝该 PAK，不会自动缩图或静默回退。发布时需把 compiler/Guest 与对应 Host 成套升级。

本轮没有构建生产工具、QJBC/PAK 或平台 Host，也没有验证 Web、Windows、Android、iOS 或 macOS 最终包。`prepare_live2d.ts` 的原尺寸图片变更及 staging 事实不等于新 PAK 已生成；必须用新工具链重新构建 Guest 和各目标平台 Host 后，才能报告实际运行支持。

## 可独立运行的源码验证

从 SDK 根目录准备 pinned upstream source：

```sh
python3 sdk/scripts/prepare_upstream.py
```

然后在 `sdk/.cache/pocketjs` 执行定向测试（固定 Bun 路径适用于本仓库环境）：

```sh
/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test tests/image-pak.test.ts
/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun tests/contract.ts
/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test --test-name-pattern='engine/spec/src/lib.rs' tests/generated-contracts.test.ts
cargo test -p pocketjs-core static_img_entries_use_the_larger_limit_without_widening_general_textures
```

当前定向结果：编译器 IMG 边界 1/1、契约测试全绿、生成 Rust spec 单项 1/1、Core 大图上传/失败清理/mesh UV 与颜色调制 1/1。完整 `generated-contracts.test.ts` 另有 2 个与本补丁无关的 pinned upstream generated guest-web descriptor 和 3DS header 差异（11 项通过、2 项失败）；本补丁对应的 `engine/spec/src/lib.rs` 生成一致性单项通过。

后续正式接入顺序：先重跑 `prepare_upstream.py`；在目标 Rust 平台构建 Native Core/Host 并打包对应预编译工具；用新 compiler 重建 Guest PAK/QJBC；最后对每个平台分别运行实际图片解码、绘制、内存与错误回退验收。Web 工具链及各移动/桌面 Host 需要分别重建，不能由单个平台构建结果推断。


## Lantern 集成结果

主代理已按正式 `build_native.sh macos` 路径重建静态 archive，构建匹配的本地 compiler/probe 工具包并重建普通 Demo 的 Lantern PAK/QJBC。最终 guest 指纹见 [Live2D 当前 checkpoint](VISUAL_NOVEL_LIVE2D.md#current-high-resolution-checkpoint-2026-11-07)。实际 macOS Debug FFI 验收通过（50 秒，`/tmp/pocket-highres-model-macos-y70.log`）：两张纹理实际解码尺寸都是 2048²，真实 Core 动作/遮罩、暂停恢复、模型释放和隔离后的主线磁盘存档不变。全身/近景截图已检查，窗口为329×600、DPR1，不能推导其他尺寸/平台已过。

PAK从27,006,192增至58,463,472字节，增加31,457,280字节；native/GPU/Flutter驻留和冷启动成本仍待测。原先显式加载工作区外部dylib的整机测试被macOS沙盒拒绝，随后正式应用内静态链接的两次测试通过；不更改沙盒策略绕过加载边界。iOS/Android/Windows/Web高清Host重建和实测未完成；本地工具包附带的旧Web WASM不能据此视为支持2048。
