# Visual novel & host-native font rendering

## Source-first comparison

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was inspected outside its excluded `pocket_host/` directory. Its generic text
path in `lib/render/pocket_ui_components.dart` resolves a Flutter `TextStyle`
and paints live JS strings with Flutter `Text`; it has no native font-metrics
or shaped-text callback contract. This SDK keeps that platform-font behavior
and adds the metrics and shaping bridge needed by the native layout engine,
without importing the excluded host implementation or adding a compiler.

By default, Pocket Flutter builds (including the Lantern visual novel demo) skip
DCFA bitmap font atlas baking (`fonts: "host"` in `app.bytecode.json` and
`guest-manifest.json`, plus a `ui:fonts.host` intent marker in `app.pak`) and
render all UI text through the host OS vector font stack (`text.layout.native`).
When a project explicitly declares custom primary font files in `pocket.json` or
passes `--bake-fonts` (`bakeFonts: true`), the compiler retains deterministic
PAK font baking (`fonts: "baked"`).

## Default host-native font pipeline

When neither `fonts.regular`/`fonts.bold` nor `--bake-fonts` is specified:

1. `sdk/scripts/build_guest.ts` forwards `--no-bake-fonts` to the pinned
   compiler, omitting `ui:font.*` bitmap atlases from `app.pak`, recording an
   explicit `ui:fonts.host` PAK entry alongside `"fonts": "host"`, and adding
   `"text.layout.native"` to `guest-manifest.json`'s `capabilities.requires`.
   Legacy or minimal test PAKs without `ui:fonts.host` continue to load without
   requiring host font tables.
2. At runtime startup, `PocketHostFontMetrics` (`pocket_host_fonts.dart`) warms
   up line heights, fullwidth CJK reference advances, and printable ASCII
   (`0x20..0x7E`) advances across the 21 active PocketJS font slots (`0..20`)
   via Flutter's `TextPainter`, and installs them into the native host through
   `pocket_set_host_font_metrics`. Studio's browser preview measures the same
   21 × 95 ASCII + CJK table via `<canvas>.measureText` and synchronizes it into
   `pocket_probe` (`create` / `setHostFonts`). This table is only a set of
   per-slot scalar metrics; it does not install a shaped-string callback into
   the Studio probe.
3. Simple unshaped non-ASCII lines (CJK ideographs, kana, precomposed Hangul
   syllables, and CJK punctuation without combining marks, joiners, variation
   selectors, or emoji) reuse cached per-scalar widths via
   `pocket_set_host_glyph_measure_callback`. On Flutter, complex shaped lines
   (combining marks, emoji ZWJ sequences, variation selectors, and complex
   scripts) invoke `pocket_set_host_text_measure_callback`; Flutter measures the
   whole line with the same `TextPainter` style used for painting. The native
   host caches those whole-line widths within both entry-count (`16,384`) and
   UTF-8 key-byte (`4 MiB`, `4 KiB`/line) ceilings. Uncached advances record
   and replay deterministically through `hostTextAdvance` trace scalars.
4. `PocketCanvasPainter` (`pocket_view_painter.dart`) resolves slots directly
   against platform system fonts (proportional default family for slots `0..15`
   and `19..20`; `monospace` followed by `Menlo` / `SF Mono` / `Consolas` /
   `Roboto Mono` / `DejaVu Sans Mono` / `Courier New` fallback for slots `16..18`)
   without referencing undeclared `PocketInter` or `PocketMono`
   families. Tracked (`letterSpacing`) and 2D/projected-3D transformed text
   runs stay on vector `TEXT_RUN` records (`TEXT_RUN_FLAG_TRACKING` and
   `TEXT_RUN_FLAG_AFFINE`).

## Studio preview shaping boundary

The Studio preview currently sends the native probe only the ASCII/CJK metric
table above. Its Canvas renderer measures and paints a complex run as one
browser-shaped string, but the native probe has no synchronous callback to ask
Canvas for that string's width. For those runs, native layout therefore uses
its scalar fallback advances while Canvas paints the browser-shaped run. This
can make Studio wrapping differ from Flutter for combining sequences, emoji
ZWJ/variation-selector sequences, and complex scripts. Flutter's
`pocket_set_host_text_measure_callback` path closes that gap for the Flutter
host; Studio parity for complex shaping remains unverified and is not implied
by the shared ASCII/CJK table.

## Optional custom primary fonts

Lantern and the Demo showcase use host-native system fonts by default without
bundling `.ttf` or `.otf` assets. Consumer projects that want a custom bundled
typeface can declare project-relative font files in `pocket.json`:

```json
{
  "fonts": {
    "regular": "fonts/custom-regular.otf",
    "bold": "fonts/custom-bold.otf"
  }
}
```

`sdk/scripts/build_guest.ts` resolves these paths from the project root and
passes them to `tools/build.ts` as `--font-regular` and `--font-bold`, keeping
`fonts: "baked"` automatically, while `PocketAppConfig.fontFamilyFallback`
forwards matching registered Flutter font families through `PocketGuest` to
native `TEXT_RUN` measurement and `PocketCanvasPainter` / IME `TextField`
rendering. A baked PAK keeps its font metrics and atlas draw path for tracked,
transformed, and 3D text; host-table measurement and the extra
tracked/transformed vector route are selected only by the `ui:fonts.host`
admission marker or a font-less PAK.

When dynamic fonts are loaded at runtime (for example via Flutter's
`FontLoader.load()` or `PaintingBinding.instance.systemFonts`), `PocketView`
listens to `PaintingBinding.instance.systemFonts` (and exposes
`PocketViewController.refreshHostFonts()`) to clear cached host metrics and
`TextPainter` layouts, resynchronize native host font tables, and trigger a
relayout/repaint. If a `PocketRecordingController` trace is actively recording,
mid-recording font refreshes are deferred until `finish()` seals the recording
so `metadata.hostFonts` and replay scalar caches stay consistent.

## Configuration rules

`pocket.json` accepts only `fonts.regular` and `fonts.bold`. Each value must be
a nonempty, project-relative `.ttf` or `.otf` file path using forward slashes;
absolute paths, traversal, symlinks, missing files, and unknown fields fail
before the compiler is loaded. CLI callers can pass `--bake-fonts` or
`--no-bake-fonts` to `pocket.ts build` / `build_guest.ts` when explicit baking
control is needed.

## Validation

- `cd sdk && bun test scripts/tests/build_guest_fonts.test.ts` verifies both
  default font-less (`fonts: "host"`, `ui:fonts.host`, `text.layout.native`)
  and baked (`fonts: "baked"`) PAK outputs plus path-traversal validation.
- `cd sdk/native && cargo test --locked` verifies native `ui:fonts.host` PAK
  admission gating (while keeping legacy empty PAKs loadable), simple-line CJK
  per-scalar fast path vs shaped UTF-8 callback routing, segment-cache byte
  caps, 3D baked preservation vs font-less projection, and replay determinism.
- `cd sdk/packages/pocket_flutter && flutter test` verifies Flutter host font
  synchronization, deferred mid-recording font refreshes, dynamic font cache
  invalidation, and recording/replay parity.
