# Float textured DrawList triangles

## Source-first boundary

The retained parent demo outside `pocket_host/` has a Dart `PocketCanvas2DPainter` in `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`. It consumes a JSON-like Canvas command list and draws rects, arcs and lines. It does not decode the pinned engine's binary DrawList records or contain the GPUI, WebGPU, GLES, Vita, PSP or 3DS readers, so there is no parent backend reader to transplant for these opcodes.

The pinned engine's existing `image-mesh.patch` adds integer-position `TEX_TRI` (op 8), repeat `TEX_TRI_REPEAT` (op 14) and the mesh compositing operations. The follow-up `image-mesh-subpixel.patch` adds float-position `TEX_TRI_FLOAT` (op 15) and `TEX_TRI_REPEAT_FLOAT` (op 16), each as 15 words:

```text
op, texture, x0, y0, u0, v0, x1, y1, u1, v1, x2, y2, u2, v2, color
```

Each coordinate and UV is an IEEE-754 `f32` bit pattern in a `u32`; `color` remains the packed modulation word. Integer ops 8 and 14 retain their original 12-word layouts. The portable Core parser validates the record before backend interpretation.

## Backend adaptation

The backend patch is deliberately separate from Core and follows it in bootstrap order. It changes only pinned backend readers and their focused reader tests.

| Backend reader | Op 15 handling | Op 16 / repeat boundary |
| --- | --- | --- |
| GPUI `engine/backends/gpui/src/render.rs` | Adds the float mesh to the existing triangle raster fallback. The content/revision key includes the 15-word record, and crop bounds use the actual float vertices. | Op 14 already falls through the closed DrawList walker and stops traversal; op 16 follows that same behavior. |
| WebGPU `devices/web/pocket-web-render/src/{lib.rs,batch.rs}` | Builds the existing three-vertex textured batch using float positions and UVs; the existing finite-vertex validation still applies. | Op 14 is unsupported by the batch builder; op 16 returns the same `Unsupported` error in preflight. |
| GLES `devices/gles/pocket-gles/src/{lib.rs,geometry.rs}` | Uploads the referenced texture and builds the same textured triangle vertices from four float words per vertex. | Both op 14 and op 16 remain explicitly `Unsupported`. |
| Vita `devices/vita/pocket-vita-render/src/{lib.rs,geometry.rs}` | Uses the existing texture cache and vertex pipeline with float positions and UVs. | Both repeat opcodes remain explicitly `Unsupported`. |
| PSP GE `devices/psp/pocket-psp-render/src/encode.rs` | Reads float positions and UVs before converting to the current driver vertex format. This driver feeds GE S16 position attributes, so it rounds positions to nearest integer only at that existing boundary; this does not claim the PSP hardware lacks other vertex formats. | The legacy repeat opcode already returns `Unsupported` from encode. Float repeat is rejected during validation, before opening a native pass. |
| 3DS PICA `devices/3ds/pocket-3ds-pica/src/driver.c` | Uses `word_float` for all six position components and six UV components, checks the 15-word record length, and submits the existing textured triangle command. | Op 14 remains unsupported by the visitor; op 16 explicitly returns `POCKET_STATUS_UNSUPPORTED`. |

No backend gained texture-repeat, mesh-layer, mask or blend support as part of this change. Unsupported operations retain the behavior each backend already had; they are not drawn as ordinary clamped triangles.

## Reproducible patch order

`sdk/native/patches/image-mesh-subpixel-backends.patch` is based on the pinned cache after `image-mesh.patch` and applies after `image-mesh-subpixel.patch`:

1. `image-mesh.patch`
2. `image-mesh-subpixel.patch`
3. `image-mesh-subpixel-backends.patch`

The ignored baseline snapshot is `sdk/.pocket-build/image-mesh-subpixel-backends-20261108/baseline/`. The patch test copies its target files from the prepared pinned cache, reverse-applies the backend patch, reapplies it, then byte-compares the result. It also checks the 3DS record-length/float-reader branch because that C backend has no host Cargo test target.

## Validation status

The backend patch is SHA-256 `2df145a8ba304c495d29d33036accd7de560df8261f0757b0a5418803e40cdce`.

The following focused checks passed against the prepared cache after the Core subpixel patch:

- `cargo test -p pocket-gles -p pocket-vita-render -p pocket-psp-render --quiet`: 57 unit tests passed (21 GLES, 18 Vita, 18 PSP). These include fractional vertex/UV/tint preservation and each renderer's repeat-op rejection behavior.
- `cargo test -p pocket-web-render --lib --quiet`: 1 library test passed.
- `cargo test -p pocket-web-render --test gpu float_textured_triangle_keeps_subpixel_coverage_on_gpu --quiet`: actual WGPU adapter readback passed. The fractional triangle covers the expected subpixel pixel and leaves the outside pixel black.
- `cargo test -p pocket-web-render --test gpu float_repeat_triangle_keeps_the_backend_unsupported_boundary --quiet`: the actual WGPU path rejects op 16, matching its existing op 14 boundary.
- Pinned Bun 1.4.4: `bun test sdk/scripts/tests/image_mesh_subpixel_backends.test.ts` passed (1 test, 21 expectations); it reverse-applies and reapplies the backend patch and byte-compares every patched target.
- `rustfmt --check` passed for the changed Rust implementation files and the GPUI renderer. The expanded WebGPU integration test file still has the same unrelated formatting differences in its baseline snapshot; it was not wholesale reformatted.

The GPUI focused test could not compile in this host because its `gpui` dependency requires Apple's Metal Toolchain, which is absent (`metal` could not be executed). The 3DS PICA C reader was checked by the patch round-trip and source assertions, but no DevkitARM/3DS target toolchain is installed here, so target compilation remains unverified. No platform-wide build or full visual parity is claimed.
