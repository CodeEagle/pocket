# Scene objects and optional inspection

Status: partially accepted, S02.2/S02.3 (2026-11-09).
The complete engine/game goal remains active. Live2D clarity is deferred.

## Source-first and reference

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was inspected excluding `pocket_host/`. Its
`mini_apps/app_game_detail/main.js` owns a JS game state and Canvas HUD but its
Rapier 3D collision and BLE input are not a visual-novel object model.
`mini_apps/app_canvas_lab/main.js` exercises DrawList throughput, while
`lib/render/pocket_ui_components.dart` supplies ordinary clipping and pointer
primitives. None contains story-owned object declarations, optional narrative
inspection or their persistence/editor workflow to migrate.

The implementation adapts Pocket's existing `scene` transaction, canonical
condition/variable handling, serialized stage and rollback checkpoints,
`View`/`Image` clipping, focusable pointer controls and shared camera transform.
[Ren'Py screen documentation](https://renpy.org/doc/html/screens.html) provides
an official functional reference for image controls and hotspots; its runtime
and screen language are not imported.

Existing `choiceSurfaces` remain choice-option presentations. A scene object
instead applies optional variable effects during a running dialogue without
advancing, revealing or replaying that line, jumping to a route, selecting an
option or creating another story interpreter.

## One declaration and one state

`scene.objects` is an optional complete array. Omission preserves the current
objects, `[]` clears them and a nonempty array replaces them. The same object
declarations live in `StageComposition.objects`, transition snapshots and
save/rollback state. There is no parallel object registry or clicked-ID store.
Images resolve existing background registry keys, which use the established
resource collection and pinned `buildGuest` pipeline.

Each object has a stable `id`, `image` key, normalized `frame`, optional source
`crop`, optional `aspectRatio`, optional integer `layer`, and optional `interaction`.
An aspect ratio contains the actual frame within its normalized layout box,
preserving the cropped artwork’s proportions across viewport shapes; omission
retains the explicitly stretched frame. The interaction
contains a human-readable `label`, existing `set`/`inc` effects, optional existing
`Condition`, and optional `hit` rectangle within the visible frame. Counts and
geometry are bounded by the shared schema. Characters and objects share one
stable layer order; primitive view keys retain existing model nodes through
snapshot/camera/timeline changes.

`resolveNovelSceneObjectGeometry` is shared by the game, Editor and acceptance
inputs. Its frame is in stage pixels; image and hit bounds are relative to that
frame. The image extends beyond a clipped frame to show the selected source
window. A crop changes sampled content, not the destination hit rectangle.
The camera transforms the same render/input subtree; no separate pointer
coordinate engine is introduced.

`interactSceneObject(id)` uses the existing transaction and variable lifetimes.
Only a running, unpaused `say` may interact. A false condition or unavailable
object rejects atomically. Multiple effects either all commit or all roll back.
One-time discovery is authored with a variable guard rather than duplicated
runtime flags. Saving and rolling back retain the object declaration and the
ordinary variable state. Legacy saves without objects continue to load.
The game additionally suppresses controls under menus, titles and transitions.

Source labels use the existing locale `ui` map via
`novelSceneObjectTextKey(id)`. Missing translations fall back to source labels,
and normal UI translation diagnostics include them. Translation changes neither
object identity nor its effects or saved state.

## Editor and Showcase

The Editor edits the same scene declaration with existing story history,
validation, save/reopen and Guest build. Its live preview invokes the actual
engine; stage editing uses the shared geometry and layer order. The object
inspector shares existing history and preserves authored layout-box origins
when dragging contained frames. Normalized x/y use three-decimal precision;
pixel coordinates retain the existing rounding. Browser pointer evidence
exposed the initial one-decimal normalized rounding error.

There is no duplicate clicked-object state, conditions interpreter, image
registry, camera hit transform, preview interpreter or Dart business layer.
Object source facts remain tied to the running preview when the author chooses
a future root; rebuilding or changing the draft still invalidates them.

Lantern adds the independent replay **灯下的两件证物 / Two Objects beneath the
Lamp**. The player examines a water-stained letter and salt inside a lamp in
either order, compares the records and discovers a returning light path. Leaving
with incomplete evidence has its own honest ending. The sequence uses the
existing generated letter illustration and transparent lantern artwork, not
application buttons. Original story labels and mainline routes are retained.

Standalone SDK builds containing scene objects also use the canonical story
validator and check object image keys against the existing background registry
before invoking the compiler. Editor-only diagnostics are insufficient for
custom consumers. Invalid crop math and an unknown image cannot produce a
successful Guest with an invisible object.

## Acceptance boundaries

Required evidence includes actual Editor edits/history/save/reopen, rejecting
bad image/effect/condition/rectangle paths, pinned Guest compilation and real
pointer changes. Native checks must distinguish visible frame, source crop and
local hit area; include overlap/layers, camera, pause/menu gating, once guards,
transaction failures, persistence/rollback and legacy state. Actual Lantern
checks must exercise both viewport sizes, preserve a nonempty parked main
save, continue existing model animation and pause behavior, and reach the new
replay through player controls.

The final aspect-ratio SDK suite passes 266 tests / 2,252 assertions across
45 files, plus scoped strict TypeScript. Canonical build-boundary and existing
Guest/font regressions pass four tests / 52 assertions. This is not a whole
monorepo typecheck.

The final Lantern pinned Guest passes real input at 390×844 and 1920×1080,
including existing Spine animation/pause behavior, optional inspection without
advancing the line, once guards, replay return and a nonempty parked main save.
The initial retained failure checked removal before the authored dissolve had
finished; the corrected check waits for the real transition.

macOS Flutter Profile acceptance passes all five required checkpoints: actual
PNG decoding/clipping at phone and wide constraints, optional pointer actions,
replay-store isolation and unchanged ordinary user-store bytes. Captured and
visually reviewed images are `phone-before-clicks.png` (780×1688) and
`wide-before-clicks.png` (1920×1080) in the QA directory. The first actual
screenshot exposed stretched objects; the shared optional `aspectRatio` and
final real clip-ratio assertions address that evidenced gap. Phone DPR 2 here
is a test viewport, not a physical Retina-device or OS rotation acceptance.

The primary NativeSession save/load/legacy/rollback checks use its storage
protocol fixture across Guest sessions; they do not establish OS file or process
restart persistence. The separate Flutter Profile test covers real platform
storage and replay isolation at its declared scope.

The primary Browser→Guest fixture uses full-frame hit rectangles. SDK tests
cover custom normalized `interaction.hit` schema and geometry, and Lantern uses
inset rectangles for positive clicks; this does not prove native rejection of
every point inside the visible frame but outside a custom hit subrectangle.

Rectangular source cropping/clipping and PNG's existing transparency are the
implemented visual model. Arbitrary path/alpha masks, alpha-sensitive hit tests,
object collision and particle editing remain separate missing capabilities.
Native draw/input facts do not establish Flutter pixel quality, physical-device
behavior or whole-game frame-time/RSS success. Final source/artifact hashes and
accepted commands are recorded under
`sdk/.pocket-build/scene-objects-20261109/`.

## Final Editor and ordinary Demo checkpoint

A separate real Chromium preview flow verifies pause/condition gates, one-time
interaction without advancing the say, source navigation, retaining the current
source when choosing a future root, and replacing it on actual rebuild.
Invalid image/crop/condition/effect drafts show diagnostics that clear after a
valid declaration is restored. This exposed a real stale-diagnostic bug:
`renderDiagnostics(localValidation())` cached derived draft errors back into
`state.validation`. Removing that assignment keeps the existing field for
server facts and makes draft diagnostics compute-and-render only. The merge
also rechecks server object-image references against the current draft, dropping
an obsolete reference diagnostic once the object is removed or its key fixed;
current invalid references are still emitted by draft validation. No second
validation store was introduced. The red runs and final green Browser log are
retained in `preview-validation-browser/`.


The frozen Editor passes 24 original scoped regressions and five original
context/bounds/trace/input Browser regressions. The new focused Chromium flow
edits the actual scene, drags the contained frame by real pointer delta, checks
history/save/reopen, rejects invalid declarations, builds the saved revision
with the pinned compiler and drives its real Guest. Full frozen source, saved
story, artifact and raw-frame hashes are retained in the final QA manifests.

The ordinary `lib/main.dart` Profile app was cloned from the previous verified
SSAA2 host, with only the four exact Lantern assets replaced and its local
signature renewed. The unsigned host executable hash is unchanged. Its runnable
main isolate and normal window were established before retiring owned PID40085.
The ordinary macOS user-store bytes remain unchanged. The system foreground is
still loginwindow, so this is not a claim that the user saw the window.

Final artifacts and commands: `sdk/.pocket-build/scene-objects-20261109/`:
`game-final-manifest.json`, `guest-manifest.json`,
`post-validation-fix-regressions/manifest.json`,
`preview-validation-browser/manifest.json`,
`flutter-response-final.json`, both reviewed PNGs, `ordinary-after.json`,
`requirements.json` and `final-manifest.json`. Retained red runs distinguish
production fixes (Inspector guard/button wiring and normalized drag precision)
from corrected fixture paths, missing ending and frame/text observation.

The tracker now has **9 passed / 35 partial / 10 pending** groups. This moves
S02 from pending to partial; arbitrary masks are still missing. No whole-game
performance or final iOS/Android/Windows package acceptance was added.
