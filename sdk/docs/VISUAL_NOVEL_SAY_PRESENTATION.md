# Visual Novel Say Presentation

## Retained source and reuse

The retained parent project has no VN say-state or VN story-authoring renderer outside the excluded `pocket_host/` tree. Its generic text primitives in `lib/render/pocket_ui_components.dart` provide the retained layout patterns: `Text`/`View.Text` is bound to the current JS value, `View.WrapLines` wraps a paragraph, and `View.WrapTextPage` places a long paragraph in a bounded page. The generic `Portal`/`Modal` rendering also shows how the parent composes same-screen overlays. T02 adapts those text and bounded-page patterns to the SDK's existing story line; it does not copy a second VN renderer, clock, or route state.

The SDK already had one say renderer in `sdk/packages/pocket_vn/src/view.tsx`: a `FocusTarget`, `ScrollablePage`, `SkinBackground`, speaker badge, optional voice replay, and the existing reveal/continue hint. The three modes keep those same controls and the one `SayState`; only the paragraph's bounded frame changes.

## Story field and validation

An optional `presentation` field is now part of a `say` instruction:

| Value | Player layout |
| --- | --- |
| Omitted or `dialogue` | Existing bottom dialogue panel |
| `fullscreen` | Large paragraph panel below the game header, using the available stage height |
| `floating` | Smaller upper-left paragraph card over the stage, with a bounded responsive size |

The shared `novelSayPresentationInstructionIssue` validator restricts the field to these three values in the engine and Editor. Explicit `dialogue` is accepted but the Editor removes it when selected, keeping old story JSON compact. Floating uses a fixed responsive preset; it is not freely positioned or draggable.

## Runtime and saves

The engine resolves the active say instruction from its stable `{label,index}` location and adds `presentation` to the public snapshot only for `fullscreen` or `floating`. Legacy and explicit dialogue snapshots keep their previous shape. The engine's internal active say and rollback checkpoints do not store this derived field; `save()` stays on the existing V4 codec. Loading or rolling back to a say location derives the same mode from the current story instruction. Backlog remains a transcript and does not gain presentation metadata.

All layouts use the existing reveal clock, text speed, auto/skip rules, voice state, focus target, and `engine.advance()`. Their paragraph remains inside `ScrollablePage`; long words pass through the existing `wrapTextLines` measurement/wrapping path. This implementation changes the line's visual presentation only.

## Editor and interchange

The say form exposes a `对白呈现` selector for 普通对白, 全屏段落, and 浮动文字. Changes go through the existing instruction-history field path, so undo/redo, story save/reopen, CSV JSON payloads, Markdown JSON blocks, and author metadata stay in the same canonical instruction object. The say factory still omits `presentation`, preserving the legacy default for new lines.

## Validation evidence

Source tests on pinned Bun 1.4.4:

- `bun test packages/pocket_vn/test` — 157 passed, 0 failed, 1,350 assertions. Includes save/load/rollback projection, invalid mode rejection, and CSV/Markdown round trip.
- `bun test editor/test/novel.test.ts` — 16 passed, 0 failed; all three valid modes and an invalid mode are checked by the Editor validator.
- `bun test editor/test/novel_say_presentation_browser.test.ts` — 1 passed, 0 failed, 46 assertions. A temporary project is edited with Chromium; mode changes are undone/redone, saved, reopened, then built through the pinned Editor Guest path and driven by real NativeSession pointer input. No canonical Demo story or asset is written.

The final isolated Guest used the retained high-resolution tool package `sdk/.pocket-build/highres-native-tools-20261107`. Story SHA-256: `df723934aeaae1733a113c4dd97056998554bd38d366561b56f6bb312ecd8864`; QJBC: `0d2234b4737a223cd775210736f648635cc6a79ea9a19176dc3814a7229a8580`; PAK: `8f546b0f6275ce08fde406a076d3c160ea843b73295626a1583a2dbd4e746f0b`; PAK size: 1,986,688 bytes. Full run log: `/tmp/pocket-t02-say-presentation-final.log`.

At 360×640, actual Guest text draw bounds were dialogue `(36,452,288,20)`, fullscreen `(36,132,288,100)`, and floating `(40,158,226,140)`. The fullscreen frame painted long English text, an unbroken English word, and Chinese text within the viewport; the floating paragraph wrapped to multiple visible lines and stayed within the viewport. All three layouts painted the same registered `art/ui/harbor-frame.png` skin frame. This evidence checks those three text regions, not every string in a larger game UI or every device geometry.

The Editor form offers only the three built-in layouts. It has no author-controlled floating coordinates, no custom paragraph theme, and no separate fullscreen navigation mode.

## Current native-only Editor toolchain rerun

The same authoring/browser test now accepts `POCKET_TOOLS_PACKAGE` while keeping
its existing fallback. With Bun 1.4.4, explicit
`retina-native-tools-20261108` and managed Playwright Chromium, the full Editor
workflow passed again: 1 test / 46 assertions, including undo/redo, save/reopen,
pinned Editor buildGuest and actual NativeSession pointer execution. The
independent temporary-project Guest is QJBC `542ed756530728e03b741caf6f04a87ba80a66d33f70977902dadaca7755abd1`,
PAK `8f546b0f6275ce08fde406a076d3c160ea843b73295626a1583a2dbd4e746f0b`.
It is not the Showcase's 9c01 Guest. Log:
`sdk/.pocket-build/novel-say-presentation-retina-20261108-final.log`.
Browser, native session, temporary Editor server and workspace were cleaned up.
The ordinary Demo does not run an Editor backend.

The Showcase's final four-layout Flutter acceptance is recorded in
[LANTERN_LETTER_SHOWCASE_FLUTTER.md](LANTERN_LETTER_SHOWCASE_FLUTTER.md).
