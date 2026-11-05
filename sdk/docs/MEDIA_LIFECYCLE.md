# PocketJS media lifecycle

This document describes the small playback-policy layer in
`@pocket/ui/media`. It is deliberately not a video renderer, decoder, or
second runtime. A caller owns the retained video/SURFACE_QUAD node and registers
its stable native video id with `createMediaController`.

## Retained-demo provenance

The source comparison used `pocketjs_flutter_demo/native/pocket_runtime_multi.c`
(suspend and route freeze/thaw), `mini_apps/syslib/pocket_syslib_flutter_ui.js`
(`AuxiliarySurface` video fields), and `mini_apps/syslib/pocket_syslib_pages.js`
(HDR/video examples), excluding the old `pocket_host/` directory. Those video
examples use synthetic frame counters rather than a reusable native decoder
lifecycle. Their suspend/resume intent is retained through the current JS
SystemUI lifecycle; the old C/Dart routing state machines are not copied back.
The new scope fills the evidenced gap between those lifecycle facts and the
existing Flutter video event handler, without adding a ticker or polling.

## Why this layer exists

`PocketView` already has the real native path for a registered video:

1. the guest emits a frame event named `video.play` or `video.pause` with an
   `{ id }` payload;
2. Flutter folds the entire frame's video commands into `_videoDesiredPlayback` before resource coordination; and
3. `_applyVideoPlayback` applies that desired state when the retained video is
   present and visible.

The media controller uses the existing `HostBridge.emit` transport, whose
native implementation is `pocket._emit`. It does not invent a `host.request`
capability and it does not poll a decoder.

## Minimal API

```ts
import { createPocketPlatformClient } from "@pocket/ui/platform";

const platform = createPocketPlatformClient();
const media = platform.media!;
const item = media.register("home-video-1", {
  group: "home-feed",
  page: "home",
  playing: false,
});

media.setCurrentPage("home");
item.play();                 // emits video.play when active and uncovered
item.setActive(false);       // emits video.pause, but retains user intent
item.setActive(true);        // emits video.play again if the page is visible
item.pause();                // explicit pause clears intent
item.dispose();              // emits video.release, then forgets the id
```

`createPocketPlatformClient` creates an owned media scope by default and
exposes it as `platform.media`. Pass `media: false` to opt out, pass an
existing `MediaController` to share a scope, or pass
`MediaControllerOptions` to configure an owned scope. A controller can also be
created directly with `createMediaController({ bridge })`.

Registration defaults to `playing: false`; registration is not autoplay. The
controller still emits an initial `video.pause` for a newly registered id,
including an initially culled node. The `Video` helper also explicitly registers
`autoplay:false`; native JSON and binary frame transport preserve that value.
Legacy raw video surfaces without an autoplay field keep their prior `true`
default. The command protocol is still required for explicit play, pause and
release; the explicit helper default does not replace it.
`group` is exclusive: calling `play()` on one entry clears the user intent of
its peers and pauses the old retained player. `page` and `setCurrentPage`
provide a page gate. `setActive(false)` is the caller's visibility/list
membership gate and does not clear intent.

## Lifecycle and coverage

The controller consumes the existing `platform.lifecycle` events. Both
`onWillDisappear` and `frozenInStack` gate playback and issue one pause per
currently applied entry. `onResume` and `onDidAppear` reopen the gate and
restore only the entries whose user intent, page, and active gates still allow
playback. Repeated lifecycle events are idempotent. `onUnload` is treated as a
final playback gate; the owner must still dispose registrations during its
render cleanup.

The SystemUI root remains active while a MiniApp child is opened: the native
foreground path only changes child sessions. Therefore root video cannot rely
on the root scheduler/compositor to pause it. `platform.launchApp()` calls
`media.beginCoverage()` before issuing `platform.apps.open`, and releases that
coverage when the launch result resolves (including a cancelled result). A
`cancel()` RPC acknowledgement alone is not enough to release it. This
pauses root media without freezing or stopping root SystemUI scheduling.
Nested launches are reference-counted. Direct raw host requests for
`platform.apps.open` do not pass through this hook; callers using such a path
must call `beginCoverage()` themselves.

## Disposal and retained surfaces

`MediaRegistration.dispose()` sends one `video.release` and then removes the id
from the controller. `MediaController.dispose()` does the same for every
registration after detaching its host-event listener. Release is the explicit
permanent-cleanup protocol: it clears the retained JS playback intent as well
as the native decoder resource. Both operations are idempotent, and a
same-turn release followed by a new registration is ordered so the new
registration's initial play/pause command cannot be deleted by the old
release. This must run before the corresponding retained video/SURFACE_QUAD
node is removed. A platform client owns and disposes its default/configured
media scope; an explicitly supplied controller remains caller-owned.

Pausing is distinct from native resource destruction. `setActive(false)` keeps
the decoder/controller available for a quick return. DrawOp disappearance is
different: `PocketView` releases only the corresponding native controller when
that id leaves the DrawList, while retaining the last JS playback intent. If
the same DrawOp returns, an explicit pause remains paused and an explicit play
resumes. To evict a distant feed item permanently, dispose its registration;
that emits `video.release` and clears the intent before the draw node is
removed. A registration must not outlive a removed/recreated node: register
the new node again so its initial playback gate is sent before resource loading.
Valid play/pause commands can admit an initially offscreen id independently of
DrawOp visibility. There are at most 128 active command identities; permanently
releasing one returns its capacity, so this is not a lifetime limit on a feed.
An excess simultaneous admission fails closed rather than evicting an active
paused identity. Release leaves a retired marker: an old DrawOp cannot revive
it; a new explicit play/pause registration can. Retired markers still referenced
by the current main/auxiliary DrawList remain pinned, while unreferenced history
is bounded. In-flight loads use monotonically increasing tickets, preventing a
retired load from installing into a later same-id registration.

The host folds a complete frame's video commands before loading or applying
playback, avoiding an intermediate platform play for a same-batch play/pause.
A failed `(id, asset)` is suppressed within its current resource lifetime instead
of retried on every scan. Permanent release clears that id's failure records;
re-registering it can retry the same asset, and failure history is bounded.
Failure keys are structured `(id, asset)` records rather than delimiter-joined
strings, so even ids containing NUL remain independent. Ticket zero is reserved
for a missing generation; asynchronous loads always receive a nonzero ticket. Feed
window size and eviction remain JS application policy, not a second Dart cache
manager. No polling or extra ticker is added.

The SDK now provides a thin `Video` composition helper from `@pocket/ui/video`
(also re-exported by `@pocket/ui`). Its public shape is:

```tsx
<Video
  id="home-video-1"
  asset="assets/intro.mp4"
  media={media}
  group="home-feed"
  page="home"
  active={true}
  playing={false}
  fit="cover"
  class="h-[220] w-full"
  style={{ radius: 12 }}
/>
```

The id is the lifecycle identity for both `MediaController.register` and
`pocket.registerSurface(id, "video", payload)`. The official
`CompositorSurface` remains the only guest surface primitive; no private
`_register` call or JS decoder is involved. A changed asset/fit updates the
existing native handle in place, while the media registration keeps explicit
play/pause intent. Component cleanup disposes that registration before releasing
the retained native surface. `class` controls the outer layout; pass the
canonical `style.radius` when the video texture itself must use rounded
clipping. A CSS-like rounded class alone is not advertised as native video
corner metadata.

`PocketView` publishes real Flutter decoder diagnostics on the same guest event
transport, only when a controller state changes:

```json
{
  "name": "video.state",
  "payload": {
    "id": "home-video-1",
    "asset": "assets/intro.mp4",
    "state": "loading|ready|playing|paused|disposed|error",
    "playing": false,
    "visible": true,
    "active": true,
    "controllers": 1,
    "loading": 0
  }
}
```

The guest may emit one `video.inspect` event to receive `video.snapshot` with
`controllers`, `loading`, and the current `items` list. This is an inspection
boundary, not a polling loop. Decoder failures stay local to the video item and
are reported as `state: "error"`; they do not call the whole Guest's
`onError` callback. Retired diagnostics are bounded, while `controllers` counts
only currently initialized Flutter controllers.

## Verification boundary

The real guest event path is covered by:

```sh
bun test ./packages/pocket_ui/test/media_native.test.ts
```

That test builds a QuickJS guest, drives lifecycle/page/feed/open/result/dispose
facts through `pocket_probe`, and asserts the emitted `video.play`/
`video.pause` frame events. It does not claim hardware or Flutter decoder
playback; decoder/resource behavior remains covered by the native/Flutter fake
platform tests.

```sh
cd sdk
flutter test packages/pocket_flutter/test/pocket_video_lifecycle_test.dart
```

The Flutter execution boundary serializes each controller's platform commands
and re-reads the latest active/visible/desired state after every asynchronous
completion. Cleanup also reconciles a newer event that arrived behind an
already-completed no-op operation. Failed commands are reported rather than
retried in an unbounded microtask loop. Resource epochs and controller identity
prevent a retired player from changing a replacement player. Replacing an
asset under the same video id retains that id's playback intent; changing a
resource must not silently bypass a JS pause or coverage gate.

The fake-platform lifecycle suite also covers temporary DrawOp eviction and
reappearance for both paused and playing intent, permanent `video.release`,
same-turn release/re-register ordering, inactive recovery, and same-id asset
replacement. Position-only controller updates do not publish repeated guest
state events.

The native retained-surface boundary is covered by:

```sh
cargo test --manifest-path sdk/native/Cargo.toml --lib \
  smoke_tests::registered_video_surface_updates_asset_and_fit_without_reusing_cached_op
```

That check uses the real QuickJS/native DrawList path and verifies that an
in-place registration update preserves the handle while changing the emitted
video asset and fit instead of returning an old cached operation.


## Ablation / redundant native work

The regression uses the same initialized paused decoder and one frame containing
`[video.play, video.pause]`. Before batch folding, the fake platform observed
`play:1 -> pause:1`; after folding, there is no intermediate platform `play`.
This removes redundant decoder work without adding a timer, queue policy or
another scheduler. The independent before/after logs are recorded in
`VIDEO_DUO_REVIEW_ARGON_HIGH.md`. These command counts are measured evidence;
no FPS, milliseconds or battery gain is inferred from them. Real decoder
behavior is checked separately by the Showcase integration test.
