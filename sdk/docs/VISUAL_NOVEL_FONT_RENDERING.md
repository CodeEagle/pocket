# Visual novel font rendering

Lantern uses the same Noto Serif subset for the compiler's primary regular and
bold faces and for Flutter's existing `PocketView.fontFamilyFallback` option.
The pinned compiler therefore puts the face's actual glyph advances into the
PAK, while Flutter paints with the registered matching font. This keeps JS
layout metrics and final text painting aligned.

## Source and retained behavior

I inspected the retained parent source at
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`,
excluding its `pocket_host/` subtree. That renderer uses Flutter `Text` and its
current theme; it does not share the PocketJS compiler's PAK font metrics. The
adaptation keeps that Flutter text path and uses the existing pinned
compiler's regular/bold face flags so its atlas advances match the font
registered by the host.

In this repository, `demo/js/apps/lantern/scripts/prepare_font.ts` prepares the
Noto Serif CJK subset from story, locale, app, and SDK text. The project declares
the subset as both primary faces in `demo/js/apps/lantern/pocket.json`:

```json
{
  "fonts": {
    "regular": "fonts/lantern.otf",
    "bold": "fonts/lantern.otf"
  }
}
```

`sdk/scripts/build_guest.ts` resolves these paths from the project root and
passes them to the already-pinned `tools/build.ts` as `--font-regular` and
`--font-bold`. `sdk/scripts/prebuilt_tools.mjs` validates the packaged
compiler's upstream revision and ABI. The compiler's
`framework/compiler/bake-font.ts` writes
the chosen face's advances and line metrics into each used regular/bold PAK
slot. The corresponding `fonts.json` remains responsible for glyph fallbacks,
explicit characters, `characterFiles`, and ranges; it no longer repeats the
primary face.

The Flutter painter follows a separate final-paint path. `PocketTextOp` carries
the text and slot number; `sdk/packages/pocket_flutter/lib/src/pocket_view_painter.dart`
maps slots to the fixed `PocketInter`/`PocketMono` family names and paints with
`TextPainter`. The PAK does not register a font with Flutter. `PocketView`'s
existing `fontFamilyFallback` property is therefore passed from
`PocketAppConfig` through `PocketGuest` to the painter, and the Demo registers
the generated font file as `LanternSerif` in `demo/pubspec.yaml`.

The native IME `TextField` and its placeholder receive that same fallback list
from `PocketView`. An empty list is passed as `null`, preserving Flutter's
prior default family resolution for existing consumers.

## Configuration

Hosts can set `fontFamilyFallback` per app in `PocketAppConfig`. It survives
`copyWith`, participates in configuration equality and hash codes, and is
selected from the trusted native policy by `withNativePolicy`. The default is
an empty list, preserving existing consumers. Lantern's native policy selects
`LanternSerif`; Flutter registers
`demo/js/apps/lantern/fonts/lantern.otf` under that family name.

The PAK primary face and Flutter fallback serve separate boundaries. The
primary face controls PAK glyph coverage, advances, and the text width used by
the engine; `fontFamilyFallback` controls Flutter's final glyph painting. Both
must name matching font data when exact wrapping matters. The same regular
font file can serve the compiler's bold slots and the painter's bold request;
this reuses the source subset without generating a second font asset. Mono
slots retain the pinned compiler's existing monospaced face.

`pocket.json` accepts only `fonts.regular` and `fonts.bold`. Each value must be
a nonempty, project-relative `.ttf` or `.otf` file path using forward slashes;
absolute paths, traversal, symlinks, missing files, and unknown fields fail
before the compiler is loaded. The SDK canonicalizes the resolved file inside
the project before forwarding it. Projects without this field keep the pinned
compiler defaults unchanged. There is no separate `BuildGuestOptions` font
override, so `pocket.ts build`, Editor builds, and scaffolded projects share
one declaration and the same `buildGuest` compiler route.

## Rendering boundary and limits

The configured PAK primary face changes Latin and CJK advances wherever the
face provides the glyph. The `fonts.json` fallbacks are consulted only for
missing code points, and each fallback glyph retains its own scaled advance.
The Demo registers its primary face under `LanternSerif` in Flutter's existing
font fallback chain. Unconfigured consumers still use Inter/Inter Bold and
their previous Flutter resolution.

## Validation

Run the focused proof with `cd sdk && bun test scripts/tests/build_guest_fonts.test.ts`.
It runs the real pinned compiler and QuickJS bytecode build twice, reads
regular/bold slot cmap advances from both
PAKs, and applies those measured advances to a deterministic 300 px line-width
probe to confirm the configured face produces a different line count. The
probe is build evidence based on real PAK data, not a substitute for Guest or
platform text layout. The test also checks malformed, missing, and escaping
declarations fail before compiler setup.

`sdk/test/config_value_test.dart` covers default, copy, equality, and hash
behavior. `sdk/test/pocket_config_test.dart` checks the native-policy merge.
`sdk/test/pocket_font_family_fallback_test.dart` checks the real
`PocketGuest` → `PocketView` property handoff without starting a runtime. The
Lantern screenshot on each target remains the final check that Flutter resolves
and paints the registered family as expected.
