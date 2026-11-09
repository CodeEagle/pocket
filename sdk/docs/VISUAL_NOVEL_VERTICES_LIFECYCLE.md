# Visual Novel Vertices Resource Lifecycle

## Scope

`PocketCanvasPainter` creates native-backed `ui.Vertices` while painting
ordinary triangle ops and batched textured triangle ops. Both production
creation points now dispose the Dart wrapper in `finally` immediately after
the synchronous `Canvas.drawVertices` recording call. The texture batch also
creates its `ImageShader` inside a `try/finally`; canvas save/restore is paired
with its own `try/finally` so an exception during clipping or drawing cannot
leave the canvas stack unbalanced.

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was checked outside `pocket_host/`. Its Canvas implementation in
`lib/render/pocket_ui_components.dart` has no `ui.Vertices` construction or
`drawVertices` call, so there is no existing parent helper to reuse for these
resources. The thin Flutter painter owns the necessary adaptation.

## Pinned ownership evidence

The local Flutter engine pin is recorded in
`.fvm/flutter_sdk/bin/cache/engine.stamp` as
`89c39edfdfae2949f6806e4a315c0c08522238b7`.

- `engine/src/flutter/lib/ui/painting/canvas.cc` passes
  `vertices->vertices()` to `builder()->DrawVertices(...)`.
- `engine/src/flutter/lib/ui/painting/vertices.h` exposes that value as a
  `const std::shared_ptr<DlVertices>&`; `vertices.cc` implements disposal by
  resetting the wrapper's shared pointer and clearing its Dart wrapper.
- `engine/src/flutter/display_list/dl_builder.cc` records the draw as a
  `DrawVerticesOp`. `engine/src/flutter/display_list/dl_op_records.h` stores a
  copied `std::shared_ptr<DlVertices>` in that op.
- Pinned `sky_engine/lib/ui/painting.dart` documents `Vertices.dispose()` as
  releasing the object's resources and making it unusable.

Therefore, after `Canvas.drawVertices` returns, disposing the Dart
`ui.Vertices` wrapper is safe: a recorded DisplayList op retains its own
reference to the native `DlVertices`. The native ownership type is
`std::shared_ptr`, not `sk_sp`.

## Creation points and exception cleanup

The two production creation points are
`pocket_view_painter.dart`'s `PocketTriangleOp` branch and
`_drawTextureTriangleBatch`. The texture batch's shader lifetime is
nested inside the vertices lifetime, so a throwing `ImageShader` constructor
still reaches vertex cleanup. The inner canvas `finally` restores the canvas
if clipping or `drawVertices` throws; shader and vertices cleanup then runs in
outer `finally` blocks. The ordinary triangle path similarly disposes its
vertices if recording throws.

The SDK has two additional `ui.Vertices` constructions in rendering test
fixtures (`pocket_mesh_sampling_test.dart` and
`pocket_mesh_alias_sources_test.dart`); this patch is limited to the two
production per-paint allocation sites.

## Validation status

Root validated the final merged production source with targeted Dart analysis
(no issues) and six focused Flutter test files at SSAA2 (34/34 passed). Logs:
`/tmp/pocket-mesh-span-final-analyze-20261108.log` and
`/tmp/pocket-mesh-span-final-focused-20261108.log`. A full Profile run completed
20 real model entry/exit cycles with 8,075 snapshot handles created/disposed,
but failed the unchanged RSS stability gate because cycles 7–10 had unstable
sample windows. See [SSAA ablation](VISUAL_NOVEL_MESH_SSAA_ABLATION.md).
These results do not establish GPU completion, leak freedom, or a measured
performance gain from explicit Vertices disposal.
