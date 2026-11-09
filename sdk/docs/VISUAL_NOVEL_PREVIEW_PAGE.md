# Editor independent preview page

The Editor's preview panel now exposes **在新页面打开试玩 ↗**. It is a real
`target="_blank" rel="noopener"` link to the same project with `view=preview`.
The new page loads the saved story, starts the existing SDK engine and resumes
its existing clock. It has a next-line action, existing restart/pause/step
controls, and a return link. It does not hydrate the editing tab's draft history,
write story files or change the game's normal save. Unsaved edits must first be
saved before they appear in a newly opened independent page.

The fixed 360px-wide portrait preview cap was removed. The embedded preview has
a responsive canvas; the independent page allocates the remaining viewport
height after its controls using flex layout, so wrapped controls do not push
the canvas below the window. Long dialogue and choices scroll within their
bounded panel. The preview uses the existing SDK `createNovelViewportLayout`
and `novelCharacterBounds`, rather than stretching character frames by separate
horizontal and vertical percentages. Backgrounds cover proportionally. The
stage ResizeObserver is disconnected before replacing its subtree; resize
updates geometry without restarting the engine or losing current dialogue.
Redundant width/grid/min-height overrides were removed.

## Source-first adaptation and limits

The retained parent outside `pocket_host/` exposes string text/WrapTextPage and
the old Flutter rendering components (`lib/render/pocket_ui_components.dart`,
`mini_apps/syslib/pocket_syslib_flutter_ui.js`); no VN browser editing or
independent preview was available there to migrate. This change adapts the
current `sdk/editor/client/novel.js` preview and
`sdk/packages/pocket_vn/src/viewport.ts` already used by the game. The browser
Editor retains DOM rendering and the same story rules; this is not a new Core
renderer, a compiled game export, or proof of Live2D/native audio/video parity.
The existing capabilities' limitations still apply.

## Acceptance

`novel_preview_layout_browser.test.ts` opens the link through a real browser
click and verifies its new page, auto-started dialogue, 1440×1000, 800×900 and
390×844 resize bounds, preserved character aspect ratios, visible dialogue and
next controls, choice interaction, ending and unchanged story file. Evidence
is under `sdk/.pocket-build/preview-layout-20261109/` and
`sdk/.pocket-build/rich-text-20261109/preview-layout-final*`.

The actual local service at port 8791 is bound to `demo/js/apps/lantern`.
`actual-lantern.json/png` records a successful current-story load and no browser
script errors. The separate test project does not edit the user's project.
The service was restarted once for the new SDK runtime export; the existing
browser tab was not forcibly reloaded. The full Editor regression remains
separately tracked and is not established passing by this layout test.
