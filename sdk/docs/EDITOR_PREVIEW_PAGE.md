# Editor preview page

The Editor is a project/build/preview page intended to be opened by Codex's
browser, rather than an embedded agent conversation. Copy preview link yields
the selected project's absolute standalone native-preview URL.

Reuse: the existing editor project APIs, pinned buildGuest pipeline,
preview manager, SSE FrameResult projection, and browser input transport are
retained. The retained parent reference is
`pocketjs_flutter_demo/lib/render/pocket_ui_components.dart` outside
`pocket_host/`: its elapsed-time display pump and real input-driven rendering
remain the contract. No browser layout or scrolling physics are introduced.

Ablation: remove the embedded Codex conversation, model/effort/scope controls,
attachment composer, conversation polling and chat-specific annotation state.
The page must not call Codex authentication/model/turn APIs. Backend transport
APIs remain compatible for existing callers; opening the page does not start
an agent. The standalone preview protocol remains available for automation.
The previous conversation/annotation UI tests were retired because their UI
was deliberately removed; the new browser page acceptance replaces them.

Existing services are preserved. Older running servers retain their original
preview-manager implementation. The updated server reads the iframe script
on every document request, versions Editor JS/CSS URLs by timestamp, and uses
no-store responses. Once the updated server is loaded, refreshing picks up
client changes without retaining a process-lifetime script cache.

The default view auto-loads the local project bound at server startup. It has
no visible top navigation or project sidebar; preview controls, test package
publishing, and collapsed advanced tools remain.

The region-number toggle adds red bounds and S1/S2 labels over visible native
FrameResult drawing regions. It is a projection aid, not a new guest layout or
hit-test tree. Labels refer to the current frame and can change with layout;
use a captured screenshot when referring to a region. Capture includes the
visible overlay, while toggling it off restores the original projection and
does not change pointer routing or guest operations.

The preview height handle changes presentation height only. It fits the complete
logical viewport into the available width/height, and supports dragging plus
ArrowUp/ArrowDown/Home/End. It never sends a different guest viewport simply
because the container became shorter.

Portrait NavigationBar reuses the retained parent's full-width, equal-item
contract. The public SDK narrow container now has `w-full` and no inter-item
gap; the wide rail branch is unchanged. The native fixture verifies label
centers near 65/195.5/325.5 at 390 pixels, rail behavior at 720, and a resize
back to 480 pixels.

Integration evidence (2026-11-04): a fresh service on 8792 built the configured
local Showcase through the pinned pipeline. Playwright loaded its first native
frame with 176 operations, no page errors, no Codex requests, hidden sidebar,
and collapsed advanced tools. Its Home/Gallery/Host text x positions are
48/175/312 at logical width 390. The region button toggled successfully.
The loaded asset URLs contain their file modification timestamps and both
resources use `Cache-Control: no-store`. The old 8790/8791 services were left
running.

Project loading also skips ordinary `.pocket-ui-backup-*` directories created
by the pinned compiler's UI-package preparation, as it already skips generated
build caches. This prevents an interrupted build backup from blocking the
preview's project file list. A symlink bearing that directory name is still
rejected; asset and ordinary source symlink validation remains active.
`input_cache.test.ts` exercises both cases.

Home-route transition check: on the fresh 8792 preview, one Mobile UI click
followed by no further input produced native frame numbers
18/24/27/31/35/36; the incoming title x moved 259.1 -> 115.0 -> 93.0 before
settling. Independent native checks also verified Transitions and Hardware.
The user's reported frozen instance still needs its exact URL correlated;
these checks do not establish which version that browser tab loaded.

Subsequent remediation: asynchronous demand queries now carry a scheduling
generation. An obsolete idle response cannot cancel a timer installed by a
newer active query, and stopping a probe invalidates in-flight queries.

Completed builds publish a unique artifact generation. Both Editor automatic
refresh and PreviewManager runtime identity include that generation, so a
Codex edit followed by rebuilding the same Editor revision does not keep the
old QJBC runtime. During a build, existing SSE clients retain the loaded scene;
new preview subscriptions/input are rejected until copying is complete. Generic
PreviewManager consumers without a generation token use root/child artifact
file size and mtime fingerprints.

### Display density (2026-11-04)

The browser projection uses `window.devicePixelRatio` for the Canvas backing
store. A 390×844 logical frame is rasterized at 780×1688 on a 2× screen and
1170×2532 on a 3× screen. DrawOps, CSS aspect ratio, pointer/wheel input,
annotation coordinates and the ready message remain in logical pixels.
Captures retain the actual backing pixels and report logical dimensions
separately. Screen-density changes repaint the retained frame via a resolution
media query; they do not advance guest time or resize its viewport.

Source-first comparison: retained parent
`lib/render/pocket_ui_components.dart` passes `devicePixelRatio` into
`PocketCanvas2DPainter`; it has no browser projection to reuse. The necessary
adaptation is a Canvas transform in `sdk/editor/client/preview.js`, using the
existing native FrameResult and resource decoder. Browser text is drawn with
system fonts and benefits from the denser target; existing bitmap resources
retain their source resolution. No parallel layout/rendering protocol or extra
native-density state is added.

### Browser first-paint admission and full-screen overlays

Browser streams opt into `?presentation=browser`. Native child first-frame
availability alone no longer completes `system.runtime.awaitFirstFrame` for
those streams: the existing JS launch remains pending while the adapter emits
the prepared surface and an opaque presentation token. After synchronous
resource decoding and Canvas drawing, the client acknowledges that token after
two animation-frame callbacks. Only that real acknowledgement releases the
native capability response and starts the JS-owned entry timeline. Headless
native stream consumers retain the native first-frame boundary; no browser
success is fabricated for them. Destroy/stop discard stale presentation tokens,
and a failed acknowledgement reconnects to replay the prepared frame.

The first prepared frame establishes the display elapsed baseline, excluding
launch/resource IO from animation time while retaining native idle-credit
accounting. Root requests waiting for presentation yield their transport turn;
already-sent child requests are no longer repeatedly pumped as if they were
newly deferred requests. SSE transports only changed resource revisions; new
subscribers still receive the complete resource cache through replayFrame.
This removes repeated atlas transmission/decoding on every animation frame.

Compositor child DrawOps now replace their `hostSurface` at its original paint
position. Root content drawn after a surface remains above that child, and
DOWN on that root paint is routed to the root's existing native hit testing;
subsequent contact edges keep their original target. This supports floating
UIKit controls without hard-coded close-button coordinates or a second button
state machine in the preview adapter.
