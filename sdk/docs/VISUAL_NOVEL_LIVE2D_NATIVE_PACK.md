# Live2D Native PMS1 Packing (Option B)

Date: 2026-11-10
Status: Implemented and validated (`sdk/packages/pocket_live2d`, `sdk/packages/pocket_vn`, `demo/js/apps/lantern`)

## 1. Evidence & Motivation

Section 7 of [`RENDER_ATTRIBUTION_BASELINE_20261110.md`](RENDER_ATTRIBUTION_BASELINE_20261110.md) established that during the 60 Hz Hiyori Live2D soak on macOS profile (`POCKET_NOVEL_PROFILE_ABLATION=true`, `POCKET_MESH_GROUP_ONLY=false`, `POCKET_MESH_SUPERSAMPLE=1`), `pocket.native` p95 was **7.8–8.9 ms**, of which QuickJS `js_tick` (`nativeJsTickP95Ms`) accounted for **6.4–7.2 ms** while native Cubism `live2d_update` (`nativeLive2dUpdateP95Ms`) was only **0.06–0.08 ms**.

Code inspection isolated four per-frame JS hot loops across Hiyori's ~109–134 drawables (~3,000+ vertices, ~3,200 triangles per model update):

1. **Host response typed-array decoding in JS** (`sdk/packages/pocket_live2d/src/transport.ts`, former `decodeNumericArray` / `parseDrawable`): converted raw float32/uint16 `Uint8Array` views into JS `number[]` arrays with per-element `Number.isFinite` checks on every updated position buffer (and uncached UV/index buffers).
2. **Per-vertex placement transform and UV interleave in JS** (`sdk/packages/pocket_vn/src/live2d.ts`, former `toMeshes`): looped over every vertex of every visible drawable to compute `dx + x * scale`, `dy + y * scale`, and `1 - v` into a staging `Float32Array`.
3. **Per-element validation and `PMS1` byte packing in JS** (`sdk/packages/pocket_vn/src/mesh.ts`, `encodeNovelMesh`): looped over `vertexCount * 4` floats calling `Number.isFinite` and `indexCount` indices checking integer bounds before copying vertices and indices into a freshly allocated `PMS1` `ArrayBuffer`.
4. **Per-drawable host bridge calls** (`sdk/packages/pocket_vn/src/model-view.tsx` and `sdk/packages/pocket_vn/src/mesh-view.tsx`): invoked `ops.setMesh` and `ops.setMeshEffect` per drawable over the QuickJS -> Rust bridge.

## 2. Architecture & `AGENTS.md` Justification

Per `AGENTS.md`:
- *"Flutter owns only the rendering surface, input/IME, lifecycle, resource decoding and explicitly registered native capability transport. Business UI, state, routing and component composition belong in JS."*
- *"Capture native Worker/IO facts at the official native execution boundaries when JS cannot observe them accurately."*
- *"Use ablation to remove redundant layers and duplicate state."*

Under **Option B (no engine patch, no new node type)**:
- **JS retains 100% of business and presentation policy**: motion cue selection, expression blending, physics/pose/breath/eye-blink/lip-sync evaluation, parameter transitions, and stage placement computation (`scale`, `dx`, `dy`, `modelOpacity`).
- **Native capability boundary packs the render-ready `PMS1` binary buffer**: `media.live2d.model.update` receives the JS-computed placement transform `{ dx, dy, scale, opacity }` and emits each drawable's `meshBytes` (`Uint8Array`) already formatted as a `PMS1` binary mesh packet.
- **Single-path ablation in JS**: `@pocket/live2d` validates the `meshBytes` container header alignment and passes the `Uint8Array` view directly through `@pocket/vn` (`live2d.ts` -> `model-view.tsx` -> `mesh-view.tsx`) into `ops.setMesh(nodeId, geometry)` without reading or copying individual floats/indices in QuickJS. The legacy JS per-vertex transform path for Live2D drawables is removed rather than retained as a fallback.

## 3. Design Details

### 3.1 `PMS1` Binary Format Contract
`PMS1` (`0x31534d50`) is the binary mesh payload consumed by `Ui::set_mesh` in the Rust engine (`sdk/native/patches/image-mesh.patch`) and produced by `encodeNovelMesh` in [`sdk/packages/pocket_vn/src/mesh.ts`](../packages/pocket_vn/src/mesh.ts):
- **Header (16 bytes, little-endian `uint32[4]`)**:
  - `word[0]`: `0x31534d50` (`"PMS1"` magic)
  - `word[1]`: `vertexCount` (`n`)
  - `word[2]`: `indexCount` (`m`)
  - `word[3]`: `color` (`0x00ffffff | (alpha << 24)`, where `alpha = round(clamp(drawableOpacity * modelOpacity, 0, 1) * 255)`)
- **Vertices (`vertexCount * 16` bytes, little-endian `float32[vertexCount * 4]`)**:
  - Interleaved `[dx + px * scale, dy + py * scale, u, 1.0 - v]` per vertex, where `(px, py)` are Cubism canvas pixel coordinates (`originX + x * pixelsPerUnit`, `originY - y * pixelsPerUnit`).
- **Indices (`indexCount * 4` bytes, little-endian `uint32[indexCount]`)**:
  - Widened 32-bit triangle vertex indices.

### 3.2 One-Pass C++ Packing (`pocket_live2d_core.cpp`)
In [`sdk/packages/pocket_live2d/native/src/pocket_live2d_core.cpp`](../packages/pocket_live2d/native/src/pocket_live2d_core.cpp):
- On topology initialization (`ensure_drawable_topology`), static `uint16_t` Cubism triangle indices are widened once into `std::vector<uint32_t> indices_u32` and copied once via `std::memcpy` into the index tail of each drawable's `pms1_bytes` buffer (`16 + vertex_count * 16`).Both `indices_u32` and `pms1_bytes` are included in `pocket_live2d_model_native_bytes` memory accounting.
- On `pocket_live2d_model_update_with_placement(model, items, item_count, dx, dy, scale, model_opacity)`:
  - After `csmUpdateModel`, `copy_drawables` writes the 16-byte `PMS1` header and transforms/interleaves `(px, py, u, 1 - v)` directly into the vertex region of `pms1_bytes` in a single pass over `vertex_count`.
  - Static indices in the tail of `pms1_bytes` remain untouched across frames (`0` per-frame index copies in C++).
  - If `vertex_count <= 0` or `index_count <= 0`, `pms1_bytes` is empty (`0` bytes), which `@pocket/vn` skips before mounting a mesh node.

### 3.3 Rust Engine Validation Citation
Removing per-element JS validation from the Live2D frame path is safe because the Rust engine validates every `PMS1` buffer at the FFI boundary before admitting it into the scene tree. Specifically, in [`sdk/native/patches/image-mesh.patch`](../native/patches/image-mesh.patch) (`Ui::set_mesh`, lines 546–578):
- Line 548: Rejects buffers shorter than the 16-byte header (`bytes.len() < 16`) or missing magic `0x3153_4d50`.
- Lines 551–559: Enforces `n in 1..=16_384`, `m in 3..=98_304`, `m % 3 == 0`, and exact byte length `16 + n * 16 + m * 4`.
- Lines 560–566: Iterates over all `n * 4` `f32` vertex components and rejects any `!v.is_finite() || v.abs() > 1_000_000.0`.
- Lines 567–571: Iterates over all `m` `u32` indices and rejects any `idx >= n`.
- Lines 572–578: Enforces the 8 MiB total `mesh_bytes` budget across the `Ui` tree before storing the vertex/index slices.

## 4. Back-to-Back A/B Measurement

Both runs executed back-to-back on the same machine under identical conditions (`ps` verified free of concurrent `flutter`/`xcodebuild`/`cargo` builds before each run) using the command from [`RENDER_ATTRIBUTION_BASELINE_20261110.md`](RENDER_ATTRIBUTION_BASELINE_20261110.md) Section 3/7:

```sh
cd /Volumes/ORICO/Development/Github/pocket/demo && \
  flutter drive --no-pub --profile --no-start-paused -d macos \
  --dart-define=POCKET_NOVEL_PROFILE_ABLATION=true \
  --dart-define=POCKET_MESH_GROUP_ONLY=false \
  --dart-define=POCKET_MESH_SUPERSAMPLE=1 \
  --driver test_driver/integration_test.dart \
  --target integration_test/novel_model_soak_test.dart
```

| Soak Window (10 s @ 60 Hz) | `js_tick` p50 Before -> After (ms) | `js_tick` p95 Before -> After (ms) | `pocket.native` p50 Before -> After (ms) | `pocket.native` p95 Before -> After (ms) | Flutter `UI build` p95 Before -> After (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `hiyori_idle_0` | 5.778 -> **3.019** (-47.7%) | 6.707 -> **3.514** (-47.6%) | 7.215 -> **4.471** (-38.0%) | 8.359 -> **5.292** (-36.7%) | 10.080 -> **8.931** (-11.4%) |
| `hiyori_idle_1` | 5.678 -> **2.978** (-47.6%) | 6.378 -> **3.489** (-45.3%) | 7.130 -> **4.516** (-36.7%) | 8.011 -> **5.201** (-35.1%) | 9.988 -> **8.785** (-12.0%) |
| `hiyori_idle_1_closeup` | 1.331 -> **3.065** | 6.396 -> **3.667** (-42.7%) | 3.067 -> **4.486** | 7.812 -> **5.312** (-32.0%) | 9.672 -> **8.884** (-8.1%) |
| `hiyori_idle_0_repeat` | 1.146 -> **2.963** | 7.158 -> **3.993** (-44.2%) | 1.867 -> **4.534** | 8.847 -> **6.300** (-28.8%) | 10.975 -> **10.521** (-4.1%) |
| `hiyori_idle_1_repeat` | 1.103 -> **1.429** | 7.104 -> **3.517** (-50.5%) | 1.878 -> **2.978** | 8.906 -> **5.415** (-39.2%) | 11.042 -> **8.364** (-24.3%) |

*Note on p50 in later windows*: When `nativeCalls` is ~170–400 across a 600-frame 10 s window (model ticks at 30–60 Hz while vsync ticks at 60 Hz), non-model ticks have ~1.1 ms `js_tick` whereas model-update ticks dominate p95. Across all five windows, model-update `js_tick` p95 dropped from **6.38–7.16 ms** to **3.49–3.99 ms** (~**3.0–3.6 ms saved per Live2D update frame**, a **43%–51% reduction**), and `pocket.native` p95 dropped from **7.81–8.91 ms** to **5.20–6.30 ms** (**29%–39% reduction**). Native Cubism update (`nativeLive2dUpdateP95Ms`) remained **0.075–0.088 ms** (including the C++ `PMS1` one-pass vertex transform).

## 5. Remaining Costs & Next Option (Not Done)

With per-vertex JS work removed, the remaining ~3.5 ms `js_tick` p95 on Live2D model-update frames is dominated by:
1. **Host bridge IPC copies & object marshaling**:
   - Encoding the 134-drawable response map (~277 KB of `PMS1` `Uint8List` slices + metadata) in Dart (`PocketLive2dPlugin.update`), copying it into QuickJS `Uint8Array` views during `host.call("media.live2d.model.update")`, and copying each drawable's `Uint8Array` back from QuickJS into Rust `Ui::set_mesh`.
2. **Per-drawable SolidJS reconciliation & FFI dispatch count**:
   - Reactive store updates (`reconcile(meshes)` in `sdk/packages/pocket_vn/src/model-view.tsx`) and ~240+ individual QuickJS -> Rust FFI calls per frame (`ops.setMesh` + `ops.setMeshEffect` across 109–134 drawables in `model-view.tsx` and `mesh-view.tsx`).

### Next Architectural Option (Explicitly NOT Done in Option B)
- **Option C — Engine-Retained Live2D Node**: Registering a retained native model surface or batching all drawables of a `modelId` into a single native/engine command so `PMS1` buffers stay in native memory between Cubism Core and the renderer without round-tripping 134 `Uint8Array` buffers through Dart/QuickJS IPC and 240+ per-node `setMesh`/`setMeshEffect` FFI calls. This requires an engine patch / retained node contract and is intentionally **not done** here.
