# Core backed inline text foundation

**State, 2026-11-09:** the generic one-leaf Core path now carries styled
ranges, ruby, reveal progress and link rectangles through the pinned PocketJS
compiler and runtime. The VN story/editor schema and its end-to-end acceptance
remain a separate integration; this document covers the reusable text and
native boundaries only.

## Source first and retained behavior

The retained parent checkout was inspected at
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding
`pocket_host/` as required.

- `lib/render/pocket_ui_components.dart:1234-1281` renders `Text` and
  `View.Text` from one `textListenable` string and one resolved `TextStyle`.
- `mini_apps/syslib/pocket_syslib_flutter_ui.js:101-116,831-840` exposes
  component-level `TextStyle`, string `wrapTextPage`, and `text(content)`;
  none stores inline spans or ruby.
- `mini_apps/syslib/pocket_syslib_pages.js:775-779` uses that plain string
  pagination API. The Showcase Text examples and component specification also
  use one string per node.

These sources provide plain-text compatibility behavior, not reusable rich
text behavior. The implementation therefore extends the pinned Core Text leaf
and keeps the existing Flutter `TEXT_RUN`/`GLYPH_RUN` consumer contract.

## Public JS contract

`@pocket/ui` exports `InlineText`, `InlineTextRef`, `InlineTextLayout`,
`InlineTextRun`, and `inlineFontSlot`.

```tsx
const ref: InlineTextRef = { current: null };
<InlineText
  ref={ref}
  source={fullSource}
  runs={runs}
  revealCodepoints={revealed}
  style={{ width: 280, fontSlot: inlineFontSlot("body"), textColor: ink }}
  onLayout={setLayout}
/>
```

Run ranges are half-open Unicode codepoint offsets, `{ start, end }`, with
optional `fontSlot`, DrawList ABGR `color`, `ruby: { text, fontSlot?, color? }`
and `linkId`. The component sorts ranges and rejects overlap; combined style
and link annotations should be expressed as disjoint range segments. Ruby and
links use the same base range. `getLayout()` returns the
Core leaf's `{ width, height, lineCount, links }`; links are grouped by id, and
each `rects` entry is `{ x, y, width, height }` in the leaf's local coordinate
space, with origin at its top-left and no additional padding. Width and full
line/ruby height remain stable as the reveal cursor changes. A ruby annotation
paints only when its complete base range is revealed. A link is returned only
when all ranges carrying that id are revealed.

`getLayout()` is synchronous and first commits the current explicit style via
the framework's regular native-tree property setter before asking Core. Its
first reactive layout query runs after the Text leaf is mounted in the Core
tree; it does not publish an unattached zero box or wait on a frame clock.

## Core and native path

The durable upstream change is `sdk/native/patches/inline-text-core.patch`,
registered in `sdk/scripts/prepare_upstream.py` after the existing native
patches. It targets pinned PocketJS revision
`99924de47c62fa36f526a8791055d91cbbdb3836`.

- `engine/core/src/tree.rs` stores one full source string and validated inline
  ranges on the existing Text leaf.
- `engine/core/src/inline_text.rs` computes one Core layout from the full
  source, width, base font slot and styled ranges. It produces positioned
  fragments and link rectangles. Reveal is not part of its cache key.
- `engine/core/src/layout.rs` reuses that cached full layout for leaf sizing;
  changing reveal does not dirty Taffy or call the measure provider.
- `engine/core/src/draw.rs` emits positioned fragments with existing
  `TEXT_RUN`/`GLYPH_RUN` opcodes. Adjacent compatible characters are grouped
  into one fragment. The DrawList format/version does not change.
- `contracts/spec/ui-ops.ts` defines the set/reveal/layout bridge; generated
  JS/Rust bindings come from the pinned package's `bun run gen` sequence.
- `framework/src/native-tree.ts` and `renderer-solid.ts` expose a small
  `syncStyle` entry that uses the existing `NodeMirror.domAttrs` previous-style
  cache, avoiding duplicate style state.
- `framework/src/inline-fonts.ts` and `tools/inline-text-slots.ts` expose
  compiler-derived font roles. A real `InlineText`/`inlineFontSlot` callsite
  adds body 16 regular, body 16 bold, heading 18 bold and ruby 12 regular
  slots. Plain consumers do not add those slots. No hidden static text is
  rendered to force atlas generation.

RIT1 stores one UTF-8 source-relative run table, with half-open codepoint
ranges. Flags independently record base font/color, link, ruby, ruby font and
ruby color; this preserves explicit white (`0xffffffff`) separately from
inheritance. JS, Core and native consumers all count Unicode scalar values.

The initial layout supports CJK and Latin breaks and keeps non-BMP scalar
boundaries intact. It uses the pinned native measurement provider when active.
Complex-script shaping, ligatures/cluster-aware reveal, bidirectional text,
and language-specific line breaking are outside this initial scope; the
implementation does not claim full Unicode shaping.

## Ablations and validation

- The plain/rich compiler fixture checks that a plain Guest leaves the
  `usedFontSlots` set and inline font metadata unchanged, while a real rich
  callsite requests only the four compiler-derived roles.
- The plain atlas ablation produced the same 905,616-byte PAK and font-slot
  list as the prior plain build, with zero extra atlas bytes and no inline
  role metadata. The focused compiler fixture also verifies the rich callsite
  adds the four roles.
- The Core regression checks one leaf's mixed style/color, ruby placement,
  hidden ruby and links, wrapped link rectangles, stable full height, and no
  additional Core measurement when reveal advances. A second regression
  distinguishes explicit white ruby from inherited ruby color; codepoint
  slicing covers CJK and a non-BMP scalar.
- The actual QuickJS/native fixture under `demo/js/tests/fixtures/inline-text`
  exercises stable layout, ruby gating, a wrapped link, and a pointer press on
  the second Core-returned rectangle. Its batched-width query also exercises
  `ref.current.getLayout()` in the same reactive batch as a width change.
  The 2026-11-09 release-Probe run passed: full layout stayed `180 x 91` over
  reveal 3/4/all, ruby appeared at its exact base boundary, link geometry
  covered multiple lines, a pointer on the second rectangle invoked the JS
  callback, hidden stale geometry did not swallow the parent press, and the
  immediate batched-width read returned `240`. The frame evidence is in
  `sdk/.pocket-build/rich-text-20261109/inline-native-mounted/frames.json`.

- The inline cache key records optional color presence separately from its
  value, so inherited color is distinct from explicit white. The regression
  keeps the same Core node/layout warm while directly changing internal run
  metadata and confirms the painted fragments change. This isolates the
  internal cache-key invariant; the public setter already invalidates the
  inline layout.
- The pristine bootstrap was replayed twice from the pinned archive. Both
  19-patch passes and final contract checks passed; a third prepare against
  the current upstream cache also passed. Official `bun run gen` emitted no
  additional changes after its exact nine-step sequence. Replay logs,
  test-count evidence and patch hashes are recorded in
  `sdk/.pocket-build/rich-text-20261109/clean-bootstrap-verification.json`.
- Four generated outputs for RIT1 operations 64–66 are part of the durable
  inline patch: `contracts/generated/pocket_spec.h`,
  `engine/spec/src/lib.rs`, `engine/runtime/src/generated_ops.rs`, and
  `engine/guest-quickjs/src/generated_ops.h`. Clean bootstrap also found
  incomplete retained mesh hunks; `image-mesh.patch` now carries the missing
  upstream source sections and is replayed with narrow successor markers.
- The final focused Core test run on the clean replay used the pinned Rust
  1.98.1 toolchain and passed 4/4 tests. Its command output is saved at
  `sdk/.pocket-build/rich-text-20261109/core-focused-tests-final.log`.
- Final-Probe Editor diagnostics used the matching compiler/tool package.
  The idle mini-app launch case passed after removing its stale local
  two-surface override so the canonical 33-child System catalog is used.
  The stacked mini-app case loaded the Showcase, Profile and Lobby and
  completed nested transitions without a QuickJS stack overflow; its final
  legacy `App result:` wait still times out. Protocol logs and captured frame
  snapshots are preserved in
  `sdk/.pocket-build/rich-text-20261109/editor-finalprobe-diagnostic/`.

Focused Core commands:

```sh
cargo test --locked --manifest-path sdk/.cache/pocketjs/engine/core/Cargo.toml \
  inline_text_one_core_layout_paints_runs_ruby_and_revealed_multiline_links --lib
cargo test --locked --manifest-path sdk/.cache/pocketjs/engine/core/Cargo.toml \
  inline_ruby_color_presence_distinguishes_white_from_inherit --lib
cargo test --locked --manifest-path sdk/.cache/pocketjs/engine/core/Cargo.toml \
  inline_text_codepoint_slice_preserves_cjk_and_non_bmp_scalars --lib
```

For an isolated macOS arm64 native build, the Pocket `cargo` launch wrapper in
this environment ignores `CARGO_TARGET_DIR`; use the pinned stock Rust 1.98.1
Cargo and pass `--target-dir` explicitly. The final build used macOS deployment
target 12.0:

```sh
env RUSTC=/Volumes/ORICO/dev-tools/rustup/toolchains/1.98.1-aarch64-apple-darwin/bin/rustc \
MACOSX_DEPLOYMENT_TARGET=12.0 \
CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS='-C link-arg=-mmacosx-version-min=12.0' \
/Volumes/ORICO/dev-tools/rustup/toolchains/1.98.1-aarch64-apple-darwin/bin/cargo build \
  --locked --release --manifest-path sdk/native/Cargo.toml \
  --target-dir sdk/.pocket-build/rich-text-20261109/native-target-pinned-1.98.1 \
  --target aarch64-apple-darwin --lib --bin pocket_probe --bin pocketjs_bytecode
```

`sdk/.pocket-build/rich-text-20261109/native-final-build.json` records the
final archive, Probe, bytecode compiler and package hashes. The final matching
tool package is
`sdk/.pocket-build/rich-inline-native-tools-20261109-final`; the earlier
`rich-inline-native-tools-20261109` package remains an untouched first-build
record. Rebuild tools from durable patches and pinned compiler source rather
than treating either directory as source. The package validation keeps the
existing QJBC ABI.

One rich-text paint hot path remains unmeasured on long paragraphs:
`draw.rs` currently collects a run's full source for each paint, each
fragment's `source_slice` scans from the beginning, and scalar counting walks
the source again. That can scale with source length times fragment count and
can allocate intermediate copies. The current short Showcase lines do not
establish long-paragraph performance; this implementation does not claim to
have removed those copies or optimized that path.
