# Mobile dialogs

The retained parent `mini_apps/syslib/pocket_syslib_pages.js` demonstrates
modal/portal composition and focus isolation. Pocket retains the pinned official
JS Modal and existing MobileButton interaction path; Flutter remains a rendering
and input host. No native business-dialog state machine is introduced.

The shared MobileDialog uses an iOS-inspired compact alert hierarchy: centered
title/message, a bounded mobile panel, and explicit single or paired actions.
Reference: https://developer.apple.com/design/human-interface-guidelines/alerts
This is a JS-rendered component, not a claim to present UIKit's native alert or
native material blur.

Component details expose one Close action. They no longer pass Close as both
confirm and cancel. The photo-delete flow uses the same dialog action contract,
with a destructive Delete action and a separate Cancel action, instead of
embedding another button beside the dialog's default dismissal action.

A real Showcase preview exposed a transition restart bug: a whole-store getter
invalidated every frame even though its derived transition key was unchanged.
The transition effect reset opacity to 0.35 on each invalidation. Comparing the
resolved key before restarting removes that redundant work and allows the whole
panel (including its background) to settle at full opacity.

Validation (2026-11-05):

- `POCKET_NATIVE_PROBE=.../target/debug/pocket_probe bun test sdk/packages/pocket_ui/test/mobile_dialog_native.test.ts`: passes actual pinned QJBC execution and pointer input at 390px and 320px, single-action dismissal, cancel/confirm callbacks, centered layout, action widths, destructive presentation and full opacity after 20 frames. A whole-store value updates every frame to guard the unchanged-key restart regression.
- `bun test demo/js/tests/mobile_ui.test.ts`: 4 passed.
- Real Editor 8792 builds successfully. Native pointer input opens UI / For with exactly one Close; after 500ms the title color alpha is 255, the panel is fully opaque, and Close dismisses it. Screenshot: `/tmp/pocket-mobile-dialog.png`.
- Scoped `git diff --check` passes. No Flutter implementation was added or changed for the dialog.
