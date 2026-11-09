# PFP1 delta-base resource lifetime ablation

Date: 2026-11-08. This change removes an unnecessary Dart object reference; it
does not change the frame wire format, rendering, or image quality.

## Source-first review

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was checked outside `pocket_host/`. Its
`lib/render/pocket_ui_components.dart` route compositor keeps a bounded set of
page subtrees (`_cachedRouteSubtrees`, evicting the oldest non-root route after
four entries) and its tab viewport cancels its ticker and timer on disposal.
Those lifecycle examples do not transport PFB1 resources or retain a native
DrawOp baseline, and the parent has no VN or Live2D renderer to port. The
necessary SDK adaptation is local to the native FFI delta protocol: retain the
minimum primary operation state required to apply PFP1 splices.

## Finding and ownership path

`PocketFrame.fromBinary` copies each resource's pixel and palette bytes out of
the borrowed PFB1 pointer so a returned frame remains valid after the next
native call. `FfiPocketRuntime._retainDeltaBase` previously stored that entire
returned `PocketFrame` in `_deltaBaseFrame`. On an unchanged static scene, the
native ABI returns a zero-byte marker and the Dart base is not replaced, so
the private protocol reference could keep raw resource `Uint8List`s reachable
for the lifetime of the runtime. In `PocketView`, `_visualFrame` removes
transient resource records before keeping the displayed frame, while the
resource loader decodes the bytes into its view-owned `ui.Image` cache.

All PFP1 base reads in `pocket_runtime.dart` use only `sequence`, `width`,
`height`, and the primary `ops` list. The patch itself carries complete current
resource/release/event metadata and auxiliary output. The retained parent
frame's `resources`, `events`, `releasedResources`, and `auxiliary` therefore
do not participate in applying a splice.

The implementation adds private `_PocketFrameDeltaBase` state containing only
`width`, `height`, `ops`, and `sequence`. `_retainDeltaBase` stores this small
protocol record and continues sharing the immutable primary operation list.
The caller still receives the original full `PocketFrame`; the record does not
copy or mutate its resource arrays.

## Controlled reachability comparison

The same-process macOS Profile comparison used the actual native ABI, one
8 MiB PAK-backed RGBA resource, 12 unchanged-frame probes, and three VM full-GC
observations per variant. The GC requests are diagnostic-only and are not part
of production behavior.

| Variant | Resource reachable after each in-process GC | Reachable after runtime disposal |
| --- | --- | --- |
| Baseline (`af67e338…`) | `true, true, true` | `false, false, false` |
| Candidate (`189ec94e…`) | `false, false, false` | `false, false, false` |

This directly confirms the old private delta base kept the decoded resource
bytes alive while the runtime was live, and the candidate removed that root.
It measures Dart reachability, not process RSS, allocator page return, GPU
completion, or a 20-cycle whole-game memory gate. The full source variants,
script, Flutter log, response and manifest are retained under
`../.pocket-build/delta-base-resource-ablation-20261108/`; the manifest
records the exact Flutter command and source hashes.

## Functional validation

The new actual-native FFI regression covers a resource-bearing full frame,
the zero-byte unchanged marker, and an event-only PFP1 patch. It checks that
the patch contains no resource payload, reuses the exact primary ops list, and
does not invalidate the caller's original resource bytes. The complete focused
`pocket_frame_binary_ffi_test.dart` file passed **8/8 tests** with Flutter
3.47.9 and the current arm64 native dylib. Targeted Dart analysis of
`pocket_runtime.dart` and the FFI test reported no issues.

This was a resource-lifetime change only. Existing image sampling, mesh LOD,
and Live2D rendering paths were not changed or re-rated by this ablation.


Final source is frozen at candidate hash `189ec94e6acabfe6263271497bb717634f27a07a3fcd7580ef6e639f9083e8a8`;
FFI regression source hash `93f71066a92977c1ebc5a29a29aa8308d281d259bfc7f6ba26f4f7b6e9cf64a5`.
The unchanged-marker and caller-resource ownership assertions use the actual
arm64 native library rather than a mocked runtime. No production GC requests
or resource-lifetime counters were introduced.


The reachability probe observes the actual owned pixel array, not a temporary
view wrapper: `PocketFrame.fromBinary` reads resource pixels with the default
`_PocketBinaryReader.bytes(copy: true)`, which creates `Uint8List.fromList`.
Primary-op coordinates are decoded values and do not retain the resource
packet's backing buffer. This supports the ownership interpretation while
still making no allocator/RSS return guarantee.


## Final-host functional regression

The unchanged existing `novel_model_showcase_test.dart` also passed on macOS
Profile, SSAA2, actual current Lantern bytecode: driver exit0/+2 and required
`model-showcase` completed. It exercises Spine, both 2048² Hiyori pages,
full/close/Idle0/TapBody states, background/resume, release/re-entry and main
story resume. Its host instance failure listener reported no startup failure.
Root inspected the actual 800×600 Idle0 capture. This is functional regression,
not a model-quality pass. Evidence is in
`sdk/.pocket-build/model-functional-delta-base-20261108/` with source/capture
hashes. Root separately archived a fresh 8/8 actual-native binary test pass and
clean targeted analysis in the resource-ablation QA directory.


## Ordinary Demo deployment

Fresh ordinary `lib/main.dart` Profile/SSAA2 build exit0; framework/app ad-hoc
signing and deep strict verification exit0. Bundle:
`sdk/.pocket-build/lantern-playable-delta-base-20261108/pocket_host.app`,
PID85465. Main isolate was observed runnable and all twelve bundled
QJBC/PAK/metadata files match current staged assets. Only then was old owned
PID32713 retired. The final AppKit query observed frontmost
`com.example.pocketHost` and its onscreen800×632 window; actual screen remains
1920×1080/backing1. No Editor was launched or user store removed. Manifest,
process/build logs, ready response, resource hashes and system observation are
in the same ignored artifact directory.
