# CI Gating & Batched Semantics Layout/Diffing Optimization (2026-11-11)

## Scope & Provenance

- **Repository**: `/Volumes/ORICO/Development/Github/pocket`
- **Parent Reference Inspected**: `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` (excluding `pocket_host/`)
- **Items Addressed**:
  - **Item #4**: PR/Push CI Workflow (`.github/workflows/ci.yml`) & static analysis gate cleanup (`cargo clippy`, `flutter analyze`).
  - **Item #8**: Batched `pocket.getLayouts(ids)` single-relayout native bridge + zero-`JSON.stringify` field-by-field semantics snapshot diffing (`sdk/packages/pocket_ui/src/semantics.ts`).
  - **Item #13 (Audited & Preserved)**: `sdk/editor/server.ts` CSRF contract verification.

---

## 1. Item #4 — PR/Push CI Workflow & Static Gate Cleanup

### Source Paths
- `.github/workflows/ci.yml`
- `.github/workflows/toolchain.yml` (reference for pinned versions: Node 24, Bun 1.3.9, Rust 1.98.1)
- `sdk/native/src/worker.rs`
- `sdk/native/src/lib.rs`
- `sdk/native/src/bin/pocket_worker_probe.rs`
- `sdk/packages/pocket_flutter/test/pocket_mesh_alias_sources_test.dart`

### Retained Behavior & Necessary Changes
1. **`clippy::not_unsafe_ptr_arg_deref` fix in `sdk/native`**:
   - Marked `WorkerRuntime::attach_ui(&self, context: *mut rquickjs::qjs::JSContext)` as `pub unsafe fn attach_ui` with a `# Safety` doc comment requiring a live UI realm `JSContext` pointer on the calling thread.
   - Wrapped all 7 callers (`sdk/native/src/lib.rs`, `sdk/native/src/bin/pocket_worker_probe.rs`, and 5 tests in `sdk/native/src/worker.rs`) in `unsafe { ... }`.
   - Verified `cargo clippy --locked --manifest-path sdk/native/Cargo.toml --all-targets` exits `0`.
2. **`flutter analyze` unused local variable cleanup**:
   - Removed the unused `final canvas =` binding in `sdk/packages/pocket_flutter/test/pocket_mesh_alias_sources_test.dart:207` (`_solidTexture`), allowing `flutter analyze --no-fatal-infos lib test` to exit `0` across all 4 Flutter packages (`pocket_services`, `pocket_flutter`, `sdk`, `demo`).
3. **`.github/workflows/ci.yml`**:
   - Configured `push` (`main`) and `pull_request` triggers with `contents: read` permissions and concurrency group cancellation on PR updates.
   - Defined 3 parallel `ubuntu-24.04` jobs:
     - `architecture-and-rust`: runs `python3 sdk/scripts/check_architecture.py`, prepares pinned PocketJS upstream, and runs `cargo clippy --locked --all-targets` + `cargo test --locked`.
     - `js-sdk-and-guest`: builds `pocket_probe` and `pocketjs_bytecode`, runs explicit SDK JS package/toolchain test suites (`packages/pocket_ui/test`, `packages/pocket_vn/test`, `packages/pocket_spine/test`, `packages/pocket_live2d/test`, `packages/pocket_tftc/test`, `tests`, and packaging scripts), and runs `bash demo/js/scripts/test_guest.sh`.
     - `flutter-sdk-and-demo`: runs `flutter pub get`, `flutter analyze --no-fatal-infos lib test`, and `flutter test` across `sdk/packages/pocket_services`, `sdk/packages/pocket_flutter`, `sdk`, and `demo`.

---

## 2. Item #8 — Batched `pocket.getLayouts(ids)` & Zero-Stringify Semantics Diffing

### Source Paths
- `sdk/native/src/lib.rs`
- `sdk/targets/wechat/src/wechat_guest.rs`
- `sdk/packages/pocket_ui/src/semantics.ts`
- `sdk/packages/pocket_ui/test/semantics.test.ts`

### Retained Behavior & Necessary Changes
1. **Single-relayout `pocket.getLayouts(ids)` in `sdk/native/src/lib.rs`**:
   - Extracted `committed_layout_in_ui(ui: &Ui, id: i32)` to walk the retained parent chain on an already-relayouted `Ui` reference.
   - Kept `committed_layout(ops: &OpContext, id: i32)` behavior identical for single-node callers (`pocket.getLayout(id)`).
   - Added `MAX_BATCH_LAYOUT_IDS = 256`, `committed_layouts(ops: &OpContext, ids: &[i32])`, and `js_layouts` (`LayoutsFunction` registered as `pocket.getLayouts`).
   - When `ids` is empty or all zeros, `committed_layouts` returns `vec![None; ids.len()]` without borrowing `core_mut()` or running `relayout_outputs()`. Otherwise it borrows `ops.core_mut()` **once**, calls `core.ui.relayout_outputs()` **once**, and resolves every node's committed logical surface rectangle in a single pass.
   - Mirrored `pocket.getLayouts(ids)` in `sdk/targets/wechat/src/wechat_guest.rs` (`LayoutsFunction`, bounded at `MAX_BATCH_LAYOUT_IDS = 256`, normalizing `undefined` to `null`) so Flutter and WeChat guest bridges remain symmetric.
2. **Batched layout reads & field-by-field diffing in `sdk/packages/pocket_ui/src/semantics.ts`**:
   - Extracted `parseCommittedRect(raw)` and added `readCommittedLayoutsBatch(nodes)` which calls `pocket.getLayouts(ids)` once per `flush()` when available, falling back cleanly to `readCommittedLayout(node)` when `getLayouts` is absent (such as legacy single-read mocks) or throws.
   - Preserved 100% of `routeActive` transitions (`armInitialMeasurement`), `needsInitialMeasurement` / `initialMeasurementFrames` 3-frame admission countdown, `pendingAdmission` empty-tree suppression, `visualRect`, `clipRect`, and `maxControls`.
   - Replaced `JSON.stringify(nodes)` signature string allocation with `lastNodes: readonly SemanticSnapshotNode[]` and `semanticSnapshotsEqual(left, right)` comparing `guestId`, `nativeId`, `label`, `role`, `selected`, `disabled`, `enabled`, `Object.is(a.checked, b.checked)`, and `Object.is` on `rect.{x,y,width,height}`.

---

## 3. Item #13 Note — `sdk/editor/server.ts` CSRF Contract Preserved

- Inspected `sdk/editor/test/editor_server.test.ts:719-730` (`POST /api/project/open` with `x-pocket-editor: 1` and no `csrfToken` is explicitly asserted to return `200`, while requests without `x-pocket-editor: 1` or `csrfToken` return `403`).
- Because browsers enforce CORS preflight on custom headers (`x-pocket-editor: 1` cannot be sent cross-origin by a simple form/fetch request, whereas HTML `<form>` multipart uploads use `csrfToken`), `x-pocket-editor: 1` is an intentional, locked programmatic local client contract across 16 editor test suites and was preserved untouched.

---

## 4. Validation Summary

- `ruby -ryaml -e 'YAML.safe_load(File.read(".github/workflows/ci.yml"))'` — passed.
- `python3 sdk/scripts/check_architecture.py` — passed.
- `cargo clippy --locked --manifest-path sdk/native/Cargo.toml --all-targets` — passed (`0` errors).
- `cargo test --locked --manifest-path sdk/native/Cargo.toml` — passed (including `get_layouts_batches_committed_rects_and_enforces_batch_limit`).
- `bash sdk/scripts/build_native.sh macos` — passed (`libpocket_flutter.a`, `pocket_probe`, `pocketjs_bytecode` updated).
- `bun test` across `sdk/packages/pocket_ui/test/semantics.test.ts`, `sdk/tests/demand_scheduler.test.ts`, and `sdk/scripts/tests/*.test.ts` — passed.
- `POCKET_BUILD_GUEST=0 bash demo/js/scripts/test_guest.sh` — passed.
- `flutter analyze --no-fatal-infos lib test` & `flutter test` across `sdk/packages/pocket_services`, `sdk/packages/pocket_flutter`, `sdk`, and `demo` — passed.
