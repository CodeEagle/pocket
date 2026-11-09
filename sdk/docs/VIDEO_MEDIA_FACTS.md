# One-shot video inspection and seek facts

This note extends [`MEDIA_LIFECYCLE.md`](./MEDIA_LIFECYCLE.md) with the JS
request/response boundary for a retained Flutter video. It describes facts
that must come from the already mounted `VideoPlayerController`; it does not
add a decoder, timer loop, renderer, or gameplay state.

## Source-first comparison

The retained parent project was inspected with `pocket_host/` excluded:

- `pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart` exposes
  `hdrVideoPlaying` as a demo boolean.
- `pocketjs_flutter_demo/native/pocket_runtime_multi.c` advances a synthetic
  video frame counter in `pocket_video_step_decode`.
- `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart` paints the
  corresponding synthetic HDR/video surface.
- `pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_flutter_ui.js`
  forwards `videoPlaying` and `videoFps` to `AuxiliarySurface`.

These paths demonstrate the retained demo's suspend/resume and auxiliary
surface intent, but do not expose a real decoder position or a reusable seek
protocol. Their synthetic counter/painter is not reused as playback evidence.
The parent render source is `lib/render/pocket_ui_components.dart`:
`_MobileTouchTrackpadSurface` and `_PocketHdrVideoPainter` draw a synthetic
video surface. No retained `VideoPlayerController`, completion event, or real
loop policy exists there to migrate.
The current implementation instead reuses `@pocket/ui/video`'s retained
`CompositorSurface`, `MediaController`, and the Flutter
`VideoPlayerController` already owned by `PocketView`.

## JS API and limits

`MediaController.inspect(id)` sends one `video.inspect` event and resolves with
one correlated `VideoSnapshot`. It does not start a recurring stream. A ready,
playing, or paused result must contain finite nonnegative `positionMs` and
`durationMs`; an uninitialized result has null values and keeps its native
state/error. `MediaController.seek(id, positionMs)` requires a prior initialized
inspection, an integer millisecond position from zero through that inspected
duration, and returns the real post-seek snapshot. Paused or inactive retained
players are eligible for seek. The native host still validates the requested
range against its current duration.

At most 16 requests may be pending in one controller. Each request uses a
controller-scoped `requestId` and a one-shot deadline. `requestTimeoutMs` is a
positive integer from 1 to 60,000 and defaults to 3,000. The platform client
adapts this millisecond deadline to its existing guest clock scheduler. A
controller created directly must provide `scheduleTimeoutMs`; without the
guest-clock deadline, requests fail with `timeout_unavailable` before any host
event is sent.

Disposing a registration rejects only requests for that video and forgets its
last inspected duration. Disposing the controller rejects all outstanding
requests. Late/duplicate snapshots, legacy snapshots without a request ID, and
snapshots for another video cannot resolve a pending promise. Native errors
remain in `VideoSnapshot.error`; a seek with an error or no initialized values
rejects instead of reporting a successful seek.

Example:

```ts
const media = platform.media!;
const snapshot = await media.inspect("preview-video");
if (snapshot.durationMs !== null) {
  const afterSeek = await media.seek("preview-video", Math.min(1_500, snapshot.durationMs));
  console.log(afterSeek.positionMs, afterSeek.durationMs, afterSeek.error);
}
```

The `Video` helper continues to own only the retained surface composition and
registration lifetime. Its owner passes the same stable id to
`platform.media.inspect/seek`; the component does not maintain a second player
or position mirror.

## Looping and generation-scoped facts

The stable surface id and the mutable playback token serve different purposes.
`VideoProps.token` and `MediaRegistration.setToken()` update the fact
correlation generation without replacing the surface or decoder. `loop` can
be updated on the same registration. The combined
`MediaController.configure(id, { token, loop, playing })` lets a VN adapter
apply the current generation, loop policy, and canonical intent together. The
adapter should provide `playing` when a token changes; configuration alone
does not replay an older intent. `Video` does this in one effect using its
current props.

The existing event lane carries `video.configure` before play/pause and before
the frame resource scan:

```json
{"name":"video.configure","payload":{"id":"stage-video","token":"video-4-8","loop":false}}
{"name":"video.play","payload":{"id":"stage-video","token":"video-4-8"}}
```

An absent configuration keeps the legacy native default of looping. A
configured token is copied to play, pause, release, inspect, seek, state, and
snapshot facts. Correlated inspect/seek replies echo the request token at the
outer response and the current token on each item. JS ignores state and
snapshot facts for another token. Configuration is bounded by the existing
128 admitted video ids and a 128-character token limit; it does not create a
second native id map or player.

`video.state` uses the existing `state` field for
`ready|playing|paused|ended|loading|disposed|error`. State changes include
real `positionMs` and `durationMs`, nullable before native initialization.
Position-only and buffering-only updates remain deduplicated because the
diagnostic equality deliberately excludes position and duration. A ready event
therefore gives VN restore code the real duration and initial position without
polling; the adapter can seek to a saved position through `MediaController`
after that fact arrives.

For non-looping playback, Flutter reports `ended` only when the installed
`video_player` value is completed at its actual duration. Version 2.10.1 also
sets `isCompleted` when `seekTo(duration)` runs, and its completion event first
sets that flag before asynchronously seeking to the final frame. The adapter
therefore requires both `isCompleted` and the matching current position, and
suppresses that edge while a Pocket seek is in flight. A successful seek to
the endpoint returns a paused snapshot and latches same-token playback
suppression; it is not reported as natural completion. The native playback
boundary also clears the old desired-play state on natural completion and
blocks same-token policy replay after completion/endpoint seek. A new tokened
play or an explicit same-token restart clears the latch. Visibility,
application lifecycle, and resource scans cannot restart it implicitly.

This split keeps one bounded intent entry in JS and small per-id native facts
beside the existing controller. It does not mirror position in a second
service, reconstruct a decoder for pause/seek/token changes, or add a timer.

## Event protocol for the native adapter

Request events use the existing Pocket frame-event lane:

```json
{"name":"video.inspect","payload":{"id":"preview-video","requestId":"vm-1-1"}}
{"name":"video.seek","payload":{"id":"preview-video","requestId":"vm-1-2","positionMs":1500}}
```

The existing `video.snapshot` response keeps its aggregate diagnostics and
`items` array, and adds the incoming `requestId` when responding to one of
these requests:

```json
{
  "name":"video.snapshot",
  "payload":{
    "requestId":"vm-1-1",
    "controllers":1,
    "loading":0,
    "items":[{
      "id":"preview-video",
      "asset":"assets/videos/clip-a.mp4",
      "state":"ready",
      "playing":false,
      "visible":true,
      "active":true,
      "positionMs":125,
      "durationMs":3000,
      "error":null
    }]
  }
}
```

Legacy `video.inspect` events without `id`/`requestId` continue to request the
whole aggregate snapshot for existing diagnostics; they do not resolve a JS
promise. A requested response must echo `requestId` and include the requested
video item. Position/duration come only from the actual initialized
`VideoPlayerController.value.position` and `.duration` converted to integer
milliseconds. They are null before initialization and after disposal. A failed
seek should return the current item plus a non-empty error string. A successful
seek is reported only after awaiting `seekTo(Duration(milliseconds: ...))`,
checking that the same controller/resource epoch is still current, and reading
the controller value again. A missing/retired controller, missing duration,
out-of-range position, or native seek exception must not produce a successful
seek result.

The adapter can use the existing PocketView video event/snapshot path and the
existing `VideoPlayerController`; it does not need a second listener, timer,
player, or Dart-side position store. `createPocketPlatformClient` forwards the
response event through its existing HostBridge listener to the owned
MediaController. A standalone controller subscribes once to its configured
bridge; when `subscribeLifecycle: false`, its owner forwards host events through
`handleHostEvent`.

## Validation status

The JS controller tests validate event payloads, request ID association, stale
and unrelated response rejection, initialized snapshot validation, seek range
validation, post-seek response facts, request quota/deadline/release behavior,
generation filtering, loop configuration ordering, seek-to-end suppression,
explicit restart, and the platform client's single-listener forwarding path.
The retained native package tests additionally cover mutable loop/token updates,
real `VideoPlayerValue` completion and exact end facts, endpoint seek without
false completion, lifecycle/cull no-restart, and generation-based explicit
replay. Run:

```sh
bun test sdk/packages/pocket_ui/test/media.test.ts
```

The Flutter `pocket_video_lifecycle_test.dart` exercises the native PocketView
adapter with a fake `VideoPlayerPlatform`: legacy aggregate inspection remains
available without polling, request snapshots echo `id`/`requestId` and read
position/duration from the initialized controller, seeks validate current
duration and return only after the controller seek completes, errors remain
request-local, and release/re-registration invalidates a late seek response.
Run it with:

```sh
cd sdk/packages/pocket_flutter
flutter test test/pocket_video_lifecycle_test.dart
```

On 2026-11-07 the JS media/video test pair passed 17 tests and the Flutter
`pocket_video_lifecycle_test.dart` passed 35 tests. These package tests use the
fake installed `VideoPlayerPlatform`; they validate the adapter behavior but
do not substitute for a platform decoder run.

These widget tests do not exercise the platform video plugins on physical
devices or emulators.

The separate `demo/integration_test/video_media_facts_test.dart` passed on the
actual macOS Flutter host on 2026-11-07 (one test, five seconds;
`/tmp/pocket-video-media-facts-macos.log`). Video Lab's real JS buttons call
`platform.media.inspect` and `seek`; their correlated responses cross the
existing native bridge. The installed decoder reported a 3000 ms bundled MP4,
the paused seek returned approximately 1000 ms, playback advanced from there,
and a later paused JS snapshot exactly matched the decoder's 1596 ms position.
The test observes the installed `VideoPlayerController` without changing its
state. System QJBC SHA-256:
`57060c146a26f05130172f57de48b46edf6be8d6c308459d48cbfcacc914f019`.
This proves the macOS media boundary; it does not prove VN video rendering,
Editor video authoring, Android/iOS, Windows or physical devices.
