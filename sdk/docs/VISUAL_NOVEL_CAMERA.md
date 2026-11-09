# Visual novel stage camera

## Retained source and gap

I checked the retained parent project at
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding
`pocket_host/`. Its `lib/render/pocket_ui_components.dart` has route-level
Flutter transitions and a separate hardware `cameraPreview` primitive. Neither
is an authored visual-novel stage camera: there is no VN instruction, saved
stage pose, or rollback camera progress to reuse. The current JS-owned VN stage
already centralizes scene compositions, scene transition progress, save/load,
rollback checkpoints, and the framework virtual tick; this change extends
those existing records.

## Authoring contract

A `scene` may include `camera: { x, y, scale }`, where `x` and `y` are logical
stage-pixel translations and `scale` is uniform zoom about the stage center.
If omitted, the scene keeps its current camera. A camera without
`cameraMotion` applies immediately. The initial pose is `{ x: 0, y: 0,
scale: 1 }`.

`cameraMotion` applies to a scene's camera target and is optional:

```ts
{
  type: "scene",
  camera: { x: -6, y: -4, scale: 1.04 },
  cameraMotion: {
    durationMs: 2400,
    easing: "easeInOut",
    shake: { amplitude: 18, cycles: 3 },
  },
}
```

Position is limited to ±4096 logical pixels, scale to 0.1–8, and duration to
integer milliseconds from 1 through 30,000. Easing is `linear` by default or
`easeInOut`. Optional shake is a deterministic, fading sinusoid during the
same duration; amplitude is 0–512 logical pixels and cycles is an integer from
1 through 20. A motion without a camera target is invalid. Rotation, filters,
depth of field, and authored keyframe timelines are not part of this contract.
The shared `novelCameraInstructionIssue()` validator is exported for the
Editor, so client and engine checks use the same bounds.

## State, timing, and compatibility

`StageState.camera` stores the target pose and, while moving, its start pose,
elapsed time, duration, easing, and shake parameters. `resolveNovelCameraPose()`
is the pure renderer helper: it interpolates from that canonical record and
derives shake from the same elapsed time. It uses no wall clock or random
source. With reduced motion enabled it returns the target immediately and
suppresses shake.

The existing engine `tick()` advances camera motion and scene fades together;
`attachNovelClock()` wakes for either one and remains idle after both finish.
Pause stops their progress. A new camera motion interrupted by another camera
scene starts from the resolved current pose. Scene transitions retain a frozen
camera pose alongside the previous background and characters, so the outgoing
composition does not accidentally inherit the new scene's view. Camera state
travels with the existing save, compact save codec, and completed-dialogue
rollback checkpoints. Starting a new game restores the default pose.

Saves written before camera support have no `stage.camera` field; load maps
those saves to the default origin pose. Older transition compositions without
a camera remain valid and render with the same default. No native clock,
secondary camera state map, or app-specific camera persistence has been added.

## Validation

The focused core test is run with pinned Bun 1.4.4:

```sh
cd sdk
.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test packages/pocket_vn/test/camera.test.ts
```

It covers shared schema bounds, deterministic easing/shake and reduced motion,
virtual-clock wake/pause, simultaneous scene and camera motion, save-codec
round-trip, rollback, legacy saves, malformed-save atomicity, and a shaken
camera at the authored position limit during a scene transition.


## Native and authoring evidence

The isolated `demo/js/tests/novel_camera_native.test.ts` compiles the real
`NovelView` through pinned `buildGuest` into a temporary QJBC/PAK, then drives
it with `NativeSession`. One test / 23 assertions passed: background UV crop
changes under viewport clipping, character image bounds move/scale, HUD
bounds remain fixed, the real accessibility preference event snaps to the
completed target pose, and a pointer tap on the same HUD location opens the
actual menu. This is native-probe evidence, not a Flutter/mobile screenshot
or video-surface transform acceptance.

Editor route and Chromium camera form tests passed 15/15, including editing,
undo/redo and canonical story save/reopen. The complete VN suite subsequently
passed 133 tests / 1009 assertions (including two atmosphere geometry tests).
The normal user play build remains the earlier revision until the integrated
story and atmosphere update has been verified.
