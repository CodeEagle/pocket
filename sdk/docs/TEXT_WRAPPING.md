# Container-aware body text

The retained parent exposes `ui.wrapTextPage` in
`mini_apps/syslib/pocket_syslib_flutter_ui.js` and an explicit wrap-text example
in `mini_apps/syslib/pocket_syslib_pages.js`. Pocket already exposes the pinned
native `ui.wrapText` measurement/break service through `wrapTextLines`; reuse it
rather than introducing a second text layout engine or a Flutter app policy.

The native text leaf measures pre-shaped lines; constraining its width does not
by itself reflow a raw Text node. JSX source whitespace also does not create
visual line breaks. Hardware page paragraphs therefore overflowed their cards.

MobileParagraph constrains its wrapper and uses its measured available width to
request line breaks from the existing native service. Re-checking on scheduled
frames supports resize without a permanent continuous-frame request. The
paragraph's native text height participates in the normal layout so following
controls move down with wrapped lines. Text and width changes update the result;
no fixed character-count wrapping is used for these paragraphs.

Default MobileCard layouts explicitly stretch to their parent width, preventing
intrinsic paragraph widths from shrinking their own measuring container. Card
detail text also reuses MobileParagraph. Its default text-xs measurement uses
native font slot 0; custom font classes can supply their matching fontSlot.

Validation (2026-11-05): actual QJBC/native tests resize 390 → 320 → 480 and
include a 160px nested paragraph, checking line breaks, bounds and following
control positions. Paragraph, dialog and Showcase mobile tests: 6 passed,
0 failed. Real Editor 8792 Hardware rendering includes both long descriptions
as wrapped multiline text within card bounds. Architecture and scoped whitespace
checks pass. No Flutter text/layout implementation was added.
