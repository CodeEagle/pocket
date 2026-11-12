# Visual novel & host-native font rendering

By default, Pocket Flutter builds skip DCFA bitmap font atlas baking (`fonts:
"host"` in `app.bytecode.json` and `guest-manifest.json`) and render all UI text
through the host OS vector font stack (`text.layout.native`). When a project
declares custom primary font files in `pocket.json` (such as Lantern's Noto
Serif CJK subset) or passes `--bake-fonts` (`bakeFonts: true`), the compiler
retains deterministic PAK font baking (`fonts: "baked"`).

## Default host-native font pipeline

When neither `fonts.regular`/`fonts.bold` nor `--bake-fonts` is specified:

1. `sdk/scripts/build_guest.ts` forwards `--no-bake-fonts` to the pinned
   compiler, omitting `ui:font.*` bitmap atlases from `app.pak`, recording
   `"fonts": "host"`, and adding `"text.layout.native"` to
   `guest-manifest.json`'s `capabilities.requires`.
2. At runtime startup, `PocketHostFontMetrics` (`pocket_host_fonts.dart`) warms
   up line heights, fullwidth CJK reference advances, and printable ASCII
   (`0x20..0x7E`) advances across the 21 active PocketJS font slots (`0..20`)
   via Flutter's `TextPainter`, and installs them into the native host through
   `pocket_set_host_font_metrics`.
3. Non-ASCII lines (including CJK punctuation, emoji ZWJ sequences, combining
   marks, and complex scripts) are measured lazily on the UI thread via
   `pocket_set_host_text_measure_callback` using the exact same slot `TextStyle`
   used by `PocketCanvasPainter`, cached with bounded generation eviction, and
   recorded/replayed deterministically through `hostTextAdvance` trace scalars.
4. `PocketCanvasPainter` (`pocket_view_painter.dart`) resolves slots directly
   against platform system fonts (proportional default family for slots `0..15`
   and `19..20`; platform monospace fallback chain `Menlo` / `SF Mono` /
   `Roboto Mono` / `DejaVu Sans Mono` / `Consolas` / `monospace` for slots
   `16..18`) without referencing undeclared `PocketInter` or `PocketMono`
   families. Tracked (`letterSpacing`) and 2D/projected-3D transformed text
   runs stay on vector `TEXT_RUN` records (`TEXT_RUN_FLAG_TRACKING` and
   `TEXT_RUN_FLAG_AFFINE`).

## Custom primary fonts (Lantern visual novel)

Lantern uses the same Noto Serif CJK subset for the compiler's primary regular
and bold faces and for Flutter's `PocketView.fontFamilyFallback` option. In
this repository, `demo/js/apps/lantern/scripts/prepare_font.ts` prepares the
subset from story, locale, app, and SDK text, and declares it in
`demo/js/apps/lantern/pocket.json`:

```json
{
  "fonts": {
    "regular": "fonts/lantern.otf",
    "bold": "fonts/lantern.otf"
  }
}
```

`sdk/scripts/build_guest.ts` resolves these paths from the project root and
passes them to `tools/build.ts` as `--font-regular` and `--font-bold`, keeping
`fonts: "baked"` automatically. `PocketView.fontFamilyFallback` is forwarded
from `PocketAppConfig` through `PocketGuest` to both `PocketHostFontMetrics`
measurement and `PocketCanvasPainter` / IME `TextField` rendering, and the Demo
registers `demo/js/apps/lantern/fonts/lantern.otf` as `LanternSerif` in
`demo/pubspec.yaml`.

When dynamic fonts are loaded at runtime (for example via Flutter's
`FontLoader.load()` or `PaintingBinding.instance.systemFonts`), `PocketView`
listens to `PaintingBinding.instance.systemFonts` (and exposes
`PocketViewController.refreshHostFonts()`) to clear cached host metrics and
`TextPainter` layouts, resynchronize native host font tables, and trigger a
relayout/repaint.

## Configuration rules

`pocket.json` accepts only `fonts.regular` and `fonts.bold`. Each value must be
a nonempty, project-relative `.ttf` or `.otf` file path using forward slashes;
absolute paths, traversal, symlinks, missing files, and unknown fields fail
before the compiler is loaded. CLI callers can pass `--bake-fonts` or
`--no-bake-fonts` to `pocket.ts build` / `build_guest.ts` when explicit baking
control is needed.

## Validation

- `cd sdk && bun test scripts/tests/build_guest_fonts.test.ts` verifies both
  default font-less (`fonts: "host"`, `text.layout.native`) and baked
  (`fonts: "baked"`) PAK outputs plus path-traversal validation.
- `cd sdk/native && cargo test` verifies native font-less PAK admission gating,
  shaped UTF-8 callback caching/eviction, 3D baked preservation vs font-less
  projection, and trace replay determinism.
- `cd sdk/packages/pocket_flutter && flutter test` verifies Flutter host font
  synchronization, dynamic font cache invalidation, and recording/replay parity.
