# Retained PMS1 exact-byte gate

## Retained source and adaptation

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was checked outside `pocket_host/`. Its
`lib/render/pocket_ui_components.dart` pools native UI nodes by tag, keeps a
per-tree revision notifier, and skips unchanged `uiSetText` calls through
`_lastTextByNodeId`. Its `lib/core/ffi_bridge.dart` has no retained image-mesh
operation, and the retained project contains no PMS1 or Live2D mesh renderer.
There is no parent mesh implementation to port; those existing dirty-update
and node-ownership patterns remain the relevant behavior.

## Change

`NovelMeshView` now submits each committed version through the existing
`getOps().setMesh` boundary and keeps no JS-side node/texture/byte cache. This
removes the duplicate snapshot, byte scan, cleanup state, and stale view of
native node contents. It also lets the native owner decide whether the current
mesh still matches.

The follow-up native patch `sdk/native/patches/image-mesh-dedup.patch` adds an
exact-byte early return to `Ui::set_mesh`. It first resolves the current node,
checks that it is an Image, preserves the empty-byte clear path, and resolves
the requested texture handle. Only then does it return success when the live
node has the same texture, is not a sprite, and already owns the identical
validated PMS1 bytes. A changed mesh still follows the existing validation,
budget, and replacement logic. The native `set_image` and `set_sprite` paths
release a mesh, so a later versioned submission with identical bytes after
either operation reinstalls the geometry. Stale texture handles still fail
before comparison.

The follow-up patch is registered immediately after `image-mesh.patch` in
`sdk/scripts/prepare_upstream.py`. Keeping it separate allows an existing
cache with the original retained-mesh patch to apply the update, and repeated
bootstrap runs recognize the patch in either direction.

## Guest and native evidence

`sdk/scripts/tests/novel_model_commit_guest.test.ts` builds the real Guest with
the pinned QuickJS compiler and executes its QJBC through `pocket_probe`. The
legacy control reconstructs the reviewed JS snapshot cache. It clears the
native image using `getOps().setImage(node, -1)`, then increments the version
without changing the PMS1 bytes. In the stage-1 frame, the legacy control has
no mesh; the production component submits again and paints the restored mesh.
After later geometry and resource changes, both Guest runs paint equal final
mesh output. The production path records ten `setMesh` op calls because the JS
layer no longer skips them; that count describes boundary calls and is not a
performance measurement.

The native regression in `sdk/native/tests/image_mesh.rs` covers exact-byte
success, clear and restore through `set_image` and `set_sprite`, empty-byte
clear, texture change, freed texture rejection, and invalid payload behavior.
`sdk/scripts/tests/image_mesh_patch.test.ts` checks that the base and follow-up
patches reverse and reapply in order.

The model fixture still compares batched and unbatched Guest execution across
six advances and 48 frames. It verifies equal rendered geometry and preserves
the existing effect update behavior. Its `setMesh` call count is not used as a
performance claim; batching can change the number of JS boundary calls while
the native exact-byte gate independently avoids repeated validation and
geometry copying for an unchanged retained mesh.

## Cost and limits

Every mesh version still crosses the JS/native operation boundary with its
bytes. For equal retained geometry, native performs an exact byte comparison
and skips repeated PMS1 validation and geometry copying. The retained native
buffer and optional effect stay in place. There is no retained JS snapshot or
scan. Changed geometry still validates and replaces native storage. This
change establishes correctness and removes redundant state; the Guest and
native regressions do not establish an FPS improvement.
The tests do not include the official Hiyori model, so no model-level or
cross-platform performance claim is made.

## Validation

- `python3 scripts/prepare_upstream.py` ran twice against the existing cache;
  both runs exited successfully, including recognition of the base and
  follow-up patch on the second run.
- `cargo test --release --test image_mesh` passed all 6 native regressions.
- `bun test scripts/tests/image_mesh_patch.test.ts` passed the full bootstrap
  patch replay and frozen-source comparison.
- The pinned Guest command below passed all 3 tests, including the external
  `setImage` clear control and production restore path.

```sh
POCKET_SOURCE_BUILD=1 \
POCKET_COMPILER_PATH="$PWD/.cache/pocketjs/tools/build.ts" \
POCKET_BYTECODE_BIN="$PWD/native/target/release/pocketjs_bytecode" \
POCKET_NATIVE_PROBE="$PWD/native/target/release/pocket_probe" \
bun test scripts/tests/novel_model_commit_guest.test.ts
```

This uses the pinned compiler and native probe rather than the mismatched
installed npm platform package.
