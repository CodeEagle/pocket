# VN T01 富文本路径调查（实现前快照）

本文保留为实现前调查。当前实现与验收见 [Inline rich dialogue](VISUAL_NOVEL_RICH_TEXT.md)；实际 schema 使用正文上的 code-point ranges，后文候选 AST 不代表已采纳的接口。

日期：2026-11-09。本文保留的是 Core 富文本实现前的只读源码调查与设计边界快照。后续已落地的单 Core leaf 基础实现、公开 API、bootstrap patch、消融和当前验收状态见 [INLINE_TEXT_IMPLEMENTATION.md](INLINE_TEXT_IMPLEMENTATION.md)。本文件中的“未实现”结论只描述该调查快照，不代表后续实现状态。

## 结论

- 可复用的是 Pocket 已有的纯文本节点、原生测量/换行路径、JS VN 引擎的 tick/save/localization 机制，以及 Flutter 现有 `TEXT_RUN` 绘制后端。
- 父仓库（不进入 `pocket_host/`）和当前 VN 都只有整句纯字符串。Pinned Core 会把 Text 节点和 Text 后代串成一个字符串，再以父节点的一个 style 测量、换行和绘制；没有 span、ruby、pause marker 或 link range 数据。
- 可以沿现有 Core 文本节点和 DrawList 接入，不需要 JS 自己按字符拼行或另造排版器。要做到同一段文字共享测量、换行、ruby 基线和链接命中，必须给 Core 加上带区间的 inline-run 布局结果；已有 `wrapText` 只返回一个字符串的换行偏移，不能单独完成这件事。
- Flutter 的 `PocketTextOp`/`TextPainter` 是现有文本绘制后端：它接收 Core 给出的行与坐标，不再换行。不要在 VN 里新增 Flutter `RichText` 或让 Flutter 决定行断点、ruby 位置、链接命中和剧情状态。

## Source-first：保留父工程实际行为

已先检查 `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`，检索与引用均排除其 `pocket_host/`。

| 保留路径 | 现有行为 | 可复用范围 |
| --- | --- | --- |
| `lib/render/pocket_ui_components.dart:1234-1281` | `Text`/`View.Text` 取一个 `textListenable` 的整串 `txt`，用一个 `resolvedStyle` 创建 Flutter `Text(txt, style: ...)`。 | 整串显示与单一字重/字号/颜色样式。没有 `TextSpan`/`RichText`。 |
| `mini_apps/syslib/pocket_syslib_flutter_ui.js:101-116,831-840` | `TextStyle` 是组件级整段样式；`wrapTextPage` 接受/传递 `text` 字符串；`text(content, opts)` 最终仍创建一个 Text。 | 整句文本和纯文本分页 API 的形状。 |
| `mini_apps/syslib/pocket_syslib_pages.js:775-779` | 分页示例向 `ui.wrapTextPage` 传 plain `text`。 | 纯文本阅读器示例与输入形式。 |
| `lib/render/pocket_ui_components.dart:2732-2775` | WrapTextPage 显示页号及一段普通 `Text`。 | 页面框架；不包含 span、ruby、链接或停顿。 |
| `docs/03_DUAL_HOST_UI_COMPONENTS_SPEC.md:12,51-55`、`mini_apps/app_ui_showcase/main.js:7,32,37` | 组件规范和 Showcase 的 Text 用法均按一个字符串节点描述。 | 迁移时保留现有普通 Text 的兼容行为。 |

这条父工程路径没有 T01 富文本行为可迁移；不以 `pocket_host/` 里的 Flutter 实现作为来源。

## Pocket 当前可复用的真实文本路径

### 普通文本测量、换行和布局

- `sdk/packages/pocket_ui/src/mobile.tsx:278-323` 的 `wrapTextLines` 在 `global.ui.wrapText` 存在时调用 Core 原生换行 op，再按 UTF-16 break columns 切 JS 字符串；显式空行也保留。无 op 时才退回 JS 估算。VN 若需要 wrap，应走这一个 Core provider，不要把 fallback 当作新富文本排版方案。
- Pinned Core 的 `contracts/spec/spec.ts:251-268`、`contracts/spec/ui-ops.ts:144-146` 和 `engine/core/src/text.rs:221-235,392-415` 定义 `wrapText(str, fontSlot, maxW)`：一个纯字符串、一个 font slot、一个宽度，输出 UTF-16 换行位置。`sdk/docs/TEXT_WRAPPING.md:3-29` 记录了父工程来源、复用决策和 390→320→480 的实际 QJBC/native 纯文本 resize 验证。
- 可复用的回归夹具：`sdk/packages/pocket_ui/test/wrap_text_lines.test.ts:89-135` 检查原生 offset、中文、显式空行和 fallback；`sdk/packages/pocket_ui/test/paragraph_native.test.ts:9-84` 检查真 QJBC/native 的窄宽度/resize/后续控件位置。它们证明的是纯字符串路径，不证明富文本。

### 框架文本资源不是 styled spans

- `sdk/.cache/pocketjs/framework/src/primitives.ts:37-49,102-127` 的 `<Text>` resource 只有一个准备好的字符串和 font slot，普通 props 也走一个 `text` primitive。
- `framework/src/text.ts:11-14,79-103` 的 `TextPart` 是本地 atlas 或异步 glyph 资源分段；`TextStyle` 只有一组 size/density/bold/fontSlot/width。源码也明确指出它按 scalar cmap 遍历，真正 shaping/caret boundary 要由 shaper 提供。它不是同一段不同样式的 run 模型。
- `framework/src/text-view.ts:5-45` 复用有限数量的子节点绘制本地字形/远端 glyph，但输入仍是一个 `TextLayout` 和一个颜色。将其解释成 RichText 支持会误判。
- `framework/src/text-layout.ts:1-3,23-27,253-280` 是依赖 `io.offload` companion 的实验性异步整串 layout 服务；没有同步 fallback，输入只有 string/slot/width，输出行偏移。Pinned `engine/crates/pocket-text/src/lib.rs:253-310` 的 `text.shape` 也只接收整段 text/family/size/width 和单个 `Attrs::new().family(...)`，按页返回 glyph 几何，不提供 VN inline span/ruby/link 数据，也没有接回主 Text 绘制节点。它不是 T01 可直接复用的同步渲染路径。

### 当前 VN 的说话状态、暂停、历史和存档

- `sdk/packages/pocket_vn/src/types.ts:250-263` 的 `say` 是 `text:string`；`SayState` (`:383-398`) 保存整串 `text`、code-point `revealProgress`、派生的 `visibleText` 等字段；`BacklogEntry` (`:453-460`) 也只存字符串。
- `engine.ts:1196-1200` 用 `Array.from` 按 code point 生成可见前缀；`:1554-1569` 把完整字符串写入 backlog 并把 active state 放进 rollback。V4 (`types.ts:687-729`) 用共享 `textPool:string[]` 压缩 backlog/rollback 字符串。
- `localization.ts:907-917` 用 `catalog.lines[say.id]` 替换整句字符串；`:1161-1185` 对 active/backlog/rollback 做 locale rebase。当前 reveal rebasing 按新旧字符串长度比例保持进度 (`engine.ts:827-862`)。Rich content 不能直接把原语言的 UTF-16/code-point offset 复用到译文。
- `types.ts:287` 有独立 `wait` instruction；它是剧情指令边界，不是对白中的局部停顿。`text-sounds.ts:1-15,76-88` 的 `minIntervalMs` 是逐字短音频节流，不会暂停 reveal。
- `view.tsx:474-479,1104-1113` 按全句纯文本决定对白高度，并将可见前缀作为一个 `<Text>`；整块 `FocusTarget` 的 `onPress` 会 `engine.advance()`。内联链接必须拿到准确命中目标并改变这层事件路由，不能继续把链接点击当作整句推进。
- 可复用的 VN 机制是现有 `engine.tick`/skip/pause/save/localization 和现有编辑器事务；`sdk/editor/client/novel.js:804` 仍是整句对白 textarea，`sdk/editor/test/novel_text_browser.test.ts:46-123` 覆盖纯文本编辑、undo/redo、保存重开、导入导出。它可以作为新编辑流程回归的基线。
- `sdk/docs/VISUAL_NOVEL_GOAL_TRACKER.md:89-94` 明确 T01.1 spans、T01.2 ruby、T01.3 局部停顿/链接、T01.4 历史/存档字符边界语义都待实现。此调查不改变状态。

## Pinned Core 的同步 Text 节点与 DrawList 位置

实际读取的是 `sdk/.cache/pocketjs` 中由固定 revision 解出的 Core；它是生成缓存，不是持久源码编辑位置。

1. `sdk/.cache/pocketjs/engine/core/src/tree.rs:77-78,355-368`：每个 text node 仅存 `text:String`；`collect_run` 把本节点及 text 子节点递归拼成一个字符串，子节点 style 没有进入 run。
2. `engine/core/src/layout.rs:42-58,82-102,573-599`：`MeasureCtx` 保存一个 `text`、一个 `slot`、一个 tracking 和一个 line-height；`build` 把整串做成一个 Taffy text leaf，并将该节点的一个 `Resolved` style 传入。增量更新路径 `:761-805` 也按单串、单 slot 更新。
3. `engine/core/src/draw.rs:2918-2972,3090-3144`：一个 Text node 进入一次 `emit_text`。atlas 路径收集 glyph 后输出一个 `GLYPH_RUN`（每个 op 一个 font slot/color，glyph 坐标已确定）；native path 输出一个 `TEXT_RUN`，字段为 slot/alignment/origin/boxW/lineHeight/color/UTF-8 string。`collect_run_of` (`:3147-3158`) 同样只拼字符串。
4. Core 原生 provider 的扩展边界在 `engine/core/src/text.rs:221-235,326-415`：`MeasureFn`/`WrapFn` 都只接收一个字符串和一个 font slot；`layout.rs` 将一次测量结果缓存到单 Text leaf，不能从现有入口传入多个样式段或 ruby。
5. 已有 DrawList 并非没有可用的绘制原语：`contracts/spec/spec.ts:1445-1450,1487-1510` 的 `GLYPH_RUN` 与 `TEXT_RUN` 都能携带单个 slot/color；Core 可在未来为一个段落发出多个带 Core 计算坐标的 op。但当前 producer 每 Text leaf 只发一整串 op；Ruby 需要 Core 计算主文/注音的相对 y 与行盒高度。若要在一个 op 里内嵌 run table 或 glyph/ruby 标记，就需要新的 DrawList layout/version。
6. 当前 Flutter adapter 在 `sdk/native/src/lib.rs:3851-3892` 把一个 `TEXT_RUN` 解成一个 `PocketTextOp`；`sdk/packages/pocket_flutter/lib/src/pocket_model.dart:372-393` 保存一个 text/color/fontSlot；`pocket_view_painter.dart:454-495` 用单个 `TextSpan(text: value, style: textStyle)` 的 `TextPainter` 绘制，并明确采用 Core 提供的行、不再换行。`pocket_text_cache.dart:5-10,36-75,62-66` 只是缓存这个单式 `TextPainter`。

因此同一段落的 styled runs 应该沿一条 Core leaf 传递：JS 给稳定 run ranges/style token，Core 保存这些范围、用同一测量 provider 做合并段落的换行/行盒与基线，输出已定位绘制片段以及同源 link rectangles；Flutter adapter 只接收/绘制这些已布局结果。当前 `wrapText` 的单串 offsets 可以作为字符坐标约定的参考，但不等于多 style run 的行/几何结果。

`hitTest`/`hitTestBounds` (`engine/core/src/draw.rs:797-843`，spec op `contracts/spec/ui-ops.ts:122,141-146`) 返回最上层 node id，不返回文本字符范围或 link id。链接命中矩形必须来自上述 Core inline layout；随后可由 Core 增加文本 range hit API，或由 JS 用 Core 返回的准确矩形创建受控 hit target。现有 VN 全屏 FocusTarget 抢先推进剧情，UI 层需要按命中结果把 link action 交给 JS，并避免同一次按压触发 `advance()`。具体 API 名称尚未确定。

### Patch/bootstrap 与生成契约

- 固定源码 revision 是 `sdk/scripts/prepare_upstream.py:19-24`（revision `99924de47c62fa36f526a8791055d91cbbdb3836` 与 archive SHA）；`sdk/.cache/pocketjs` 是按 marker 验证/解包后的缓存。`prepare_upstream.py:26-48` 中 `PATCHES` 没有 Text/rich-text patch。
- 持久 Core 改动要放在 `sdk/native/patches/<topic>.patch`，并把 patch/label 加到 `prepare_upstream.py:29-48`。`:343-387` 校验 patch 可正向应用、可反向验证或已存在；`:399-406` 在 cache revision 不符时重新解包，再逐 patch 应用并核验最终契约。不要只手改 `.cache`。
- 最少 Core 文件边界：`engine/core/src/tree.rs`（runs/ranges 存储）、`layout.rs` 与 `text.rs`（样式相关测量、wrap、line/ruby/link 几何）、`draw.rs`（多段绘制）、`engine/render/draw-ops/src/lib.rs`（若 op 格式变化则校验新长度/版本）。实际命中 API 还要在 Core 的 UI op/bindings 增加单一 JS 可调用入口。
- 若新增 Core op/prop：在 `contracts/spec/ui-ops.ts` 或 `contracts/spec/spec.ts` 定义唯一契约；`spec.ts:1-18` 说明 Rust spec 从此生成，`sdk/.cache/pocketjs/package.json:291` 的 `gen` 顺序生成 `engine/spec/src/lib.rs`、`contracts/generated/pocket_spec.h`、driver contract、UI bindings 和 guest Web bindings。更新后需与 Rust Core、native `sdk/native/src/lib.rs` 的 DrawList 解码、Dart `PocketTextOp`/`pocket_view_painter.dart` adapter 一致。
- 若只用多个现有 `TEXT_RUN`/`GLYPH_RUN` 表达 Core 已定位的单样式片段，DrawList parser 已支持重复的已知 op，格式可能不变；但必须保持每片段的坐标、font slot、颜色、clipping 自包含，并证明 Core 测量与后端 paint 的折行/advance 一致。若增字段或新 opcode，更新 `contracts/spec/spec.ts:1423-1534`，递增 `DRAW_LIST_VERSION`（当前 3），同步 `engine/spec/src/lib.rs`、C 头、Rust `draw-ops`/software raster、`sdk/native`、Flutter decoder/renderer 和各后端读者；闭合 DrawList 不允许旧 reader 静默跳过未知 op (`engine/render/draw-ops/src/lib.rs:1-7,44-75`)。

## 尚未采纳的 JS schema 草案

以下仅供 T01 后续评审，不是已决定的 public API，也不表示可直接落地：

```ts
type SayPart =
  | { kind: "text"; id: string; text: string; style?: string;
      ruby?: { text: string; style?: string }; link?: string }
  | { kind: "pause"; id: string; durationMs: number };
```

设计约束建议：

- 一个 `say` 只保留一个规范内容来源：旧 `text` 通过兼容归一化成为单一 text part，或新版只用 `content`；不要同时维护权威 `text` 和权威 `content` 两份可变副本。现有 `SayState.text/visibleText` 可以先作为派生兼容视图。
- run/style/link/pause 使用稳定 ID。style token 先映射至已经注册的 font slot、颜色和有限语义样式；当前协议没有通用 font size/italic/text-decoration 样式字典。Ruby 的字号、纵向占位与基线必须由 Core 计算，不能在 JS 手工估字宽。
- pause 是零宽剧情事件，由 JS engine 的既有 tick 消耗并持久化剩余时长；不要用 Dart timer 或把 `text-sounds.minIntervalMs` 当作停顿。link 字段只命名 JS action/target key；导航/变量/剧情策略仍由 JS 执行。
- 本地化按稳定 part ID 翻译正文和 ruby 文本；对每个语言版本重新计算字数、折行和 link ranges。引擎 reveal 当前按 code point，Core layout API 使用 UTF-16；需要一条经过测试的映射边界，不能把源语言 offsets 搬到译文。
- 存档应记录段 ID + 段内 reveal cursor + pause 剩余时间（若中断于 pause），历史/回滚也应保留同一内容语义；决定版本升级/旧字符串迁移后，继续利用现有共享池压缩，而不要在 active/backlog/rollback 重复保存多套等价 span 和派生字符串。

## 最小完整闭环建议

1. 先定并验证 JS story/editor/localization/save schema 与旧纯文本兼容规则；为 V4 历史/rollback 和 active line 明确 reveal、pause、link 可用时点的语义。
2. 按上述 patch/bootstrap 改 pinned Core：同一文本 leaf 持有 run metadata，统一做 styled measurement/wrap/line geometry；ruby 共享这套几何，link range 输出精确矩形/命中事实。JS 仍管理 story、tick、action 和编辑策略。
3. 在 `demo/js/` 的实际 Guest 增加一条混合中英文本，覆盖跨样式换行、注音、局部停顿和链接。验证真实尺寸/字体槽下的行边界与 ruby 不碰撞；按真实触控或输入事件点 link，断言执行 JS action 且不触发整句 advance。
4. 验证 Editor 编辑/撤销/保存重开/导入导出、active line 中途 save-load、rollback/backlog、locale rebase、手动/auto/skip/暂停恢复和语音完成等待。沿用现有纯文本 resize 与文本编辑测试做回归基线，但新增的 QJBC/native 和真实输入断言才算 T01 闭环。

当前结论是“已有纯文本和宿主绘制底座可复用；T01 需要 Core 同源 inline layout 与 JS 状态/编辑/存档扩展”。本调查没有实现或验收 T01。
