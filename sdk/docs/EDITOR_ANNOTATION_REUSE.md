# Editor annotation reuse

## Source-first result

The retained parent demo was inspected before changing the SDK editor:

- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/pocket_host/editor/client/editor.js`
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/pocket_host/editor/client/index.html`
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/pocket_host/editor/client/editor.css`

Those files are a read-only reference in this task. They provide the useful
project list, source/config editing, build diagnostics, artifact links and
signed publishing flow, but they do not contain an editor annotation, preview
capture, region coordinate, or Codex-context implementation. The old
non-`pocket_host` demo likewise has no `annotation`/`mark area` editor feature.

The closest proven interaction to reuse is the real screenshot pipeline in:

- `pocket_host/host/integration_test/glass_optics_test.dart:115-190` — capture
  a rendered surface, preserve the pixel dimensions, crop a bounded logical
  rectangle, and re-encode the crop as PNG.
- `pocket_host/host/integration_test/showcase_mobile_test.dart:14-32` — wait for
  the guest to render and retain named captures as test context.
- `web_wasm_preview/index.html:169-180,334-362` — make code-only hot-update
  publishing an explicit test action and show its version/cache outcome.

## Current SDK adaptation

`sdk/editor/client/editor.js` keeps one browser-side annotation state and uses
the real native preview capture protocol from `sdk/editor/client/preview.js`:

1. The user drags over the scaled preview; the selection is converted to the
   selected logical viewport coordinates.
2. The iframe returns a real PNG capture. The editor maps the logical rectangle
   to the capture dimensions and crops it with a browser canvas, mirroring the
   old demo's bounded `_crop` helper.
3. The crop is sent as `annotation.png` together with `{rect, viewport, text?}`
   to Codex. A manually captured full preview remains `preview.png`.
4. Changing the viewport or refreshing the preview invalidates stale screenshot
   context; the selection is never silently reused against a different frame.

This is an adaptation to the SDK's thin browser editor. It does not copy the
old Flutter screenshot test harness into runtime and does not add a second
renderer, layout engine, or host state machine.

The output panel also exposes a separate **Publish test package** action. It
calls `POST /api/projects/:id/publish` with `{ "channel": "test" }`, displays
the returned version/build/channel, and explains the tested path: deploy once
to an iOS Simulator or desktop host, then Demo Host → Updates → Check → Apply.
The UI explicitly says that Android and physical-device update URLs are not
automatically configured by this flow. The existing release action remains
under Advanced and sends the default release request.

## Editor layout

The current editor keeps the reusable interactions in a three-column shell:

- left: project navigation;
- center: the Codex conversation, always visible beside the preview;
- right: live Preview, annotation controls, and the prominent test-package
  publish action.

The project navigation and Codex/Preview boundary each have a keyboard-focusable
vertical separator. Pointer dragging changes the corresponding column width;
ArrowLeft/ArrowRight change it in 20px steps and Home/End jump to the guarded
minimum/maximum. The Preview toolbar's `Source` button opens the source editor
in a dialog. Configuration, device deployment, build logs, artifacts, and the
signed release action are grouped under the collapsed `Build, device, release &
diagnostics` disclosure so they remain available without competing with the
conversation and preview.

## Verification

- `sdk/editor/test/editor_annotation.test.ts` exercises the DOM interaction,
  logical rectangle conversion, real-capture message handoff, and PNG crop
  dimensions with a browser-like harness.
- The service and native preview contracts remain covered by
  `bun test editor/test/*.test.ts`; the preview protocol is asserted by
  `editor/test/preview.test.ts` without changing `preview.js` or `preview.ts`.
- A Playwright Chromium smoke check should use the already-running local editor
  (`http://127.0.0.1:8791/` when the showcase is bound there) and verify that
  `Mark area` produces an `Area … · screenshot` context pill. It must not stop
  the shared 8790/8791 services.
- The three-column shell was verified in Playwright Chromium against the
  running editor: the project and Codex/Preview columns rendered side by side;
  `Source` opened and closed the source dialog; and the Codex/Preview separator
  changed `aria-valuenow` from `390` to `410` with ArrowRight. A separate
  pointer-drag check verified both separators change width (the project
  separator from `248` to `307`, and the Codex separator from `390` to `449`).
