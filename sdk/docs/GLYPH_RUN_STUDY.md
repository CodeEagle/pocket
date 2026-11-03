# GLYPH_RUN 接入研究

研究基线：`bee700e`，2026-11-03。下文保留研究时的缺口与建议；本轮已按该路径实现 native opcode 3 接入，计划和实际验收见 `GLYPH_AND_SCHEDULER_IMPLEMENTATION.md`。研究阶段的验证不代替实现后的测试。

## 结论

可以接入，优先在 Rust 端复用固定上游的 glyph page，把 GLYPH_RUN 投影为现有带 UV/颜色/clip 的纹理绘制操作。继续使用既有 PFB1、资源 revision、Flutter 图片缓存与 Canvas，不在 Dart 建第二套字形布局，也不把 gid 猜回 Unicode 后交给 TextPainter。

“完整支持 GLYPH_RUN”应定义为消费固定上游契约并保持其绘制语义；不等于完整 Unicode shaping、系统字体 fallback、彩色 emoji 或任意旋转文字能力。这些受上游字体覆盖和布局契约限制。

## 协议与现状

来源：`sdk/.cache/pocketjs/contracts/spec/spec.ts` 的 DrawList 格式段（约 1439 行）。opcode=3，记录长度为 `3 + 2*n` 个 u32：

| word | 含义 |
| --- | --- |
| 0 | GLYPH_RUN opcode 3 |
| 1 | 低 8 位 fontSlot；8–15 位保留；高 16 位 glyph 数量 |
| 2 | 上游 ABGR 颜色 |
| 每 glyph 第一个 word | cell 左上角坐标，两个打包的 i16 |
| 每 glyph 第二个 word | 低 16 位 gid；高 16 位保留 |

FONT ATLAS v3 的 cmap 包含 codepoint/gid/advance/xoff，位图按固定 cell 和 raster density 存储。gid 对应指定字体 atlas 内的字形，不能按字符编码解释；位置已经由上游排好。SCISSOR 栈与单元实际尺寸决定可见区域。字形位图来源于已注册 font atlas / PAK，而非 TEXT_RUN 的 UTF-8 字符串。

- 上游 `engine/render/draw-ops/src/lib.rs` 已正确识别其长度并携带 clip。
- 当前宿主 `sdk/native/src/lib.rs` 安装 text measurer，常规文字投影为 TEXT_RUN，Dart 以 TextPainter 排版绘制。
- 但安装 measurer 不代表所有文字都为 TEXT_RUN：`engine/core/src/draw.rs` 的 provider 判断还检查 tracking、transform、3D 状态。tracking 非零、非平移 transform、3D 等可能回到 baked 字形路径；纯 translate 不触发该 provider 切换，轴向非单位缩放又可能生成 TEX_QUAD。
- 宿主 FrameOp 投影没有 opcode 3 分支，会进入 `unsupported PocketJS draw opcode 3` 错误路径；不是静默忽略，也不能靠切换 measurer 就补全。
- 上游旋转 baked 字形的既有降级是字形 cell 保持直立、anchor 随变换移动；接入时不能承诺比固定上游更强的文字变换。

## 可复用实现

固定上游源码由 `sdk/scripts/prepare_upstream.py` 重建，不直接改缓存：

| 来源 | 用途 |
| --- | --- |
| `engine/core/src/lib.rs`: `font_atlas` / `font_atlas_revision` | 获取字体与同数量 atlas 替换的失效信息。 |
| 同文件 `prepare_glyph_page(slot, gid)` | 按需生成共享字形页；返回 handle、contains、UV 描述。资源变化后描述必须重新验证。 |
| `engine/render/glyph-pages/src/layout.rs` | GlyphSource、guarded glyph page、多页布局、UV；透明边界防相邻字符采样串色。 |
| `engine/render/glyph-pages/src/mask.rs` | A8 coverage 合成、缩放与裁剪参考；可作为像素验证基准。 |
| `engine/core/src/draw.rs` glyph page 实现 | 与缩放文字共用覆盖页，白色 RGB 与 coverage alpha 通过逐 quad tint 着色。 |
| `sdk/native/src/lib.rs` TEX_QUAD / synthetic texture / sent_resources | 已有纹理引用、revision 导出与释放。 |
| `pocket_flutter/lib/src/pocket_view_painter.dart` | 已有 UV、tint、clip 与图片绘制。 |

已查保留的 `pocketjs_flutter_demo`（排除 pocket_host），没有可直接迁入的 GLYPH_RUN 实现；`native/pocket_runtime_multi.c` 只有旧 BinaryDrawCmd/FFI buffer 的传输参考，不建议迁回其模拟字体/绘制层。当前 pinned 上游已有直接可复用的 glyph page 接口，应以该接口和当前资源链为主。

现有 glyph page 为 T8 coverage + 1024-byte 白色/alpha palette，`pocket_assets.dart` 已支持 T8；现有 PFB1 image tag 6 可以传 UV、tint 和该资源，无需另加 glyph tag。

上游 baked 文字按 Unicode scalar 查 cmap，无完整 kerning/ligature shaping；cmap 缺字回到 gid0 tofu。Web 的 runtime glyph 补字脚本不能自动迁用到 QuickJS；core streaming 需要显式 request/commit，不能将支持 opcode3 等同于任意动态中文或彩色 emoji 已支持。

## 推荐接入步骤

1. 从真实 DrawList 收集 GLYPH_RUN 的 slot/gid 需求，用上游接口准备页。需处理 Ui 可变借用、页资源变更及同帧混合 TEXT_RUN/TEX_QUAD，避免保留已失效 descriptor。
2. 根据 atlas 的逻辑 cell 大小、glyph 坐标、page UV、ABGR 转色及当前 clip，生成现有 image/texture 操作。无需再做字距、换行或 shaping。
3. 将页纹理加入现有通用资源引用集合，覆盖主/辅助 surface；按 revision 发送、失去引用后释放。现有 FrameDrawCache 已包含全局 raster_revision；字体加载与 stream commit 会递增它，generic handle 集合也随 cache 保留。应验证并复用此失效机制，不重复增加字体缓存状态。
4. 复用现有 PFB1 image 编码和 Dart 解码/图片缓存；先不新增 glyph opcode 或公开开关，避免同时维护两套 atlas 与 renderer。
5. 先保留 TEXT_RUN 与系统 TextField 默认路径。普通文字不会因为增加兼容能力被强制改成烘焙字体；混合 provider 应在一个帧中正确工作。
6. 若大量字形使逐 glyph DrawOp 开销成为实测瓶颈，再比较按 page 批量 Canvas.drawAtlas 与紧凑 glyph op。未测前不增加第二套二进制契约。

## 必须覆盖的验收

- 非零 tracking、transform、普通 TEXT_RUN 混排，以及真实 QJBC/PAK 触发 opcode 3。
- 同字体多个 gid、跨 page、A→B→A 页切换、多 font slot、主/辅助输出。
- 非零坐标、部分裁剪、嵌套 scissor、透明度与 ABGR tint、整数 raster density 和缩放/纹理路径交叉。
- 同数量 atlas 替换、纹理释放/重用、Guest reload / OTA 切换、静态 unchanged；旧解码 Future 不得覆盖新页。
- 缺 slot、非法 gid、截断记录、资源上限与失效 handle 的明确行为，应对齐上游规则。
- coverage 像素与参考合成的对照，及 Flutter 实际截图；只检查 op 数量不足以证明字形正确。
- 真实机 profile/release 比较冷启动、滚动、静态重绘、长文本的 CPU/raster/分配/纹理内存。不预先承诺比 TextPainter 快或更省电。

## 本次实际验证

直接运行固定上游 workspace 的 cargo test 失败：cache 缺少 workspace member `tools/build/gba/bake/Cargo.toml`。没有为此修改正式源码或上游缓存。

将未修改的 `engine/spec`、`engine/drivers`、`engine/render/draw-ops`、`engine/render/glyph-pages` 复制到临时最小 workspace，用 `cargo test --offline --manifest-path <temporary>/Cargo.toml` 执行：16 项测试与 1 项 doctest 通过，覆盖 DrawList 解码、driver 契约、glyph coverage 与边界校验。日志 `/tmp/pocket-glyph-isolated-tests.log`。

这些结果仅验证可复用的上游基础；宿主 GLYPH_RUN、真实字体像素、混合 provider、设备性能和功耗尚未完成接入验证。研究阶段未修改 runtime/ABI/默认文字行为，未提交。
