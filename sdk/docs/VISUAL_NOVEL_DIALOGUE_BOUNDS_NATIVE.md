# Visual novel dialogue bounds: native acceptance

## Status

The native bounds matrix now covers the current story's three endings plus the timed timeout route at 329×600 and 1280×900. It fully paints and checks `timeout_01` (90 code points), `truth_04` (87), `train_01` (80), `arrival_05` (76), and `shelter_01` (71). The test also checks named speaker layouts for Mira (`arrival_02`) and Ren (`arrival_03`). Every measured line's Continue label was tapped and the active route advanced; each ending route then completed through the real Guest.

This completes the requested three-ending native matrix. Optional non-ending dialogue branches such as `clock_ren_01` and `roof_mira_01` were traversed only where their path required them, but were not all separately captured for bounds. The evidence is native DrawOp geometry, not Flutter raster-pixel or physical-device input validation.

## Retained source and adaptation

Before adding the acceptance case, the retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was inspected without entering `pocket_host/`.

- `mini_apps/syslib/pocket_syslib_flutter_ui.js:831-836` exposes generic `View.WrapLines` and `View.WrapTextPage` nodes. `mini_apps/syslib/pocket_syslib_pages.js:769-775` uses them in a generic pages showcase.
- `lib/render/pocket_ui_components.dart:2703-2778` maps those nodes to Flutter `Text` widgets. The retained parent has no Lantern story, dialogue player, ordinary say panel, or long-dialogue native regression route to reuse.
- The adapted behavior is the parent demo's JS-authored multiline text rendered through native text widgets. The new test follows the current repository's native route and pointer pattern from `demo/js/tests/novel_native.test.ts`, reusing `demo/js/tests/native_session.ts` and reading `demo/js/apps/lantern/story.json`.
- The adaptation stays in a test because the current player already owns wrapping, panel sizing, clipping, and Continue in JS: `sdk/packages/pocket_ui/src/mobile.tsx:283-326`, `sdk/packages/pocket_vn/src/view.tsx:437-440,480-488,996-1004`. No production or staged Guest code was changed for this acceptance case.

## Route and assertions

`demo/js/tests/novel_dialogue_bounds_native.test.ts` starts the compiled Guest from its title screen. It checks the opening Mira and Ren passages, then `arrival_05`. The timeout route chooses `check_seal`, follows the `signal_window` target, and waits for the authored timer to reach `timeout_01`. A fresh game then follows the existing evidence and dial-code path to `send_truth` and `truth_04`. Two further fresh games take the real `send_train` and `keep_light` options to `train_01` and `shelter_01`. Each ending route completes after its measured line's real Continue tap.

The test reads active story identity from the autosave, but never writes engine state, jumps to a script location, calls engine advancement directly, or substitutes a runtime. The bounds assertions use the Guest's returned `DrawOp` text rectangle and `clip` rectangle. They require multiple rendered lines, the entire text rectangle inside the bounded dialogue content clip, that clip inside the dialogue panel and above the toolbar, a visible speaker label above the body, and Continue above the toolbar. A native pointer tap at the Continue text center must then advance the active line. One JSON array log contains one record per line × viewport; each record includes the full `sourceText`, full wrapped `paintedText`, `sourcePaintedMatch: true`, speaker text and rect, body rect, content clip, Continue rect, and toolbar top.

## Native geometry observed

Rectangles are in native Guest frame coordinates: `x,y,w,h`. `toolbarTop` is the top edge of the player toolbar derived from the active viewport layout.

| Line | Speaker | Source code points (total) / painted code points (non-whitespace) | Wrapped lines | Speaker rect | Text rect | Content clip | Continue rect | Toolbar top |
| --- | --- | ---: | ---: | --- | --- | --- | --- | ---: |
| `arrival_02` | Mira | 47 / 47 | 3 | 68,367,37,20 | 36,412,257,60 | 36,412,257,104 | 243,511,58,15 | 552 |
| `arrival_03` | Ren | 66 / 66 | 5 | 68,357,31,20 | 36,402,257,100 | 36,402,257,114 | 243,511,58,15 | 552 |
| `arrival_05` | 雾港纪事 | 76 / 70 | 5 | 68,357,64,20 | 36,402,257,100 | 36,402,257,114 | 243,511,58,15 | 552 |
| `timeout_01` | 雾港纪事 | 90 / 90 | 6 | 68,335,64,20 | 36,380,257,120 | 36,380,257,136 | 243,511,58,15 | 552 |
| `truth_04` | 雾港纪事 | 87 / 87 | 6 | 68,335,64,20 | 36,380,257,120 | 36,380,257,136 | 243,511,58,15 | 552 |
| `train_01` | 雾港纪事 | 80 / 80 | 5 | 68,357,64,20 | 36,402,257,100 | 36,402,257,114 | 243,511,58,15 | 552 |
| `shelter_01` | 雾港纪事 | 71 / 71 | 5 | 68,357,64,20 | 36,402,257,100 | 36,402,257,114 | 243,511,58,15 | 552 |

At 1280×900 all seven lines wrapped to two lines. Their body rect is `280,712,720,40`, content clip is `280,712,720,104`, Continue rect is `1046,811,58,15`, and toolbar top is `852`. Mira's speaker rect is `216,667,37,20`; Ren's is `216,667,31,20`; the narrator rect is `216,667,64,20`.

The source count includes all code points and authored spaces. The painted count removes whitespace and inserted line breaks, matching the test's whitespace-compacted comparison; `arrival_05` therefore records 76 total source code points and 70 painted non-whitespace code points. All seven values were checked against `story.json` and the native JSON records. The full source and wrapped painted strings matched after removing only whitespace. JSON reported `sourcePaintedMatch: true` for all 14 line × viewport observations. In each row the body rect is within its actual content clip, and the Continue rect ends before the toolbar top.

## Validation record

Final captured run: Bun 1.4.4, one test passed and zero failed in 20.36 seconds. The run booted the isolated locale-checkpoint Guest directly with the specified native probe; it did not build or stage artifacts. Both viewport runs completed all four routes. Full stdout, including all 14 source/painted JSON observations, is captured at `sdk/.pocket-build/lantern-dialogue-bounds-native-20261108.log`.

```text
Guest QJBC: sdk/.pocket-build/lantern-locale-checkpoint-20261108/guest/app.qjbc
SHA-256: 9c01ae0def288419adcf5df0244291d15579b68fd614513dd5adfd32e45dfe39

PAK: sdk/.pocket-build/lantern-locale-checkpoint-20261108/guest/app.pak
SHA-256: 3d775a1fc3e773d17d73d3d45e73618adbd2a2fa52d5d4785e839fc7bcf48876

Metadata: sdk/.pocket-build/lantern-locale-checkpoint-20261108/guest/app.bytecode.json
SHA-256: 23cd53354ba0efe5e6c4a83b5ec6990d293a80f4e9a4075c8d7259824b390781
runtimeAbi: quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021

Story source SHA-256: c737d79cb61b9d1abb83966640f8c5a2d0c8f5df0697285b4c0007a70984cdbb
Test SHA-256: 2c9305e0d3649774837746686aac4c0cd20e271c6efb4dd5487a46f0d88bafeb
Native probe SHA-256: 7bad5a1ee8b077f67184b2f5fb9ed65ce29b1b6988fdd900349d40b4621b3b21
Run log: sdk/.pocket-build/lantern-dialogue-bounds-native-20261108.log
Run log SHA-256: 44e772c2477f7cf241d15b7b5f41277b5adee501ff45588b3b95cf54da15dde2
```

The check validates the pinned QuickJS Guest's input handling and returned text geometry. It does not measure Flutter raster pixels, physical-device safe areas, or OS-level touch mapping.
