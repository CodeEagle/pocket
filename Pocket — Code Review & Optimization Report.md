# Pocket — Code Review & Optimization Report

Nov 11, 2026 · @Lincoln · Commit `83a780b` ("ship interactive back and preview startup fixes in Web SDK 0.1.9")

## Summary

Pocket is a big, serious codebase. There are about 450k tracked lines across Rust, Dart, TS/TSX, Swift and Kotlin, plus \~88 MB of binary assets. Its core architecture is sound: a thin Flutter host, a Rust/rquickjs runtime running real precompiled QuickJS bytecode, a binary PFB1 frame protocol with v2 deltas, an SPSC duplex input ring, and Ed25519-signed updates. Many P0/P1 items from the earlier audit reports in the repo are now fixed. The duplex ring is wired into `PocketView`, `PocketGuest` is keyed by an epoch instead of `ValueKey(config)`, the editor checks Host/Origin/Sec-Fetch, and the native side exposes `pocket_next_wake_delay_ms`, so idle views can stop ticking.

The remaining opportunities fall into three groups:

1. **Render-path performance.** Work per changed frame scales with the whole scene, not with what changed. This happens on both sides of the FFI and in the Flutter layer tree.
2. **Robustness.** A Rust panic anywhere behind the 57 `extern "C"` exports aborts the host app.
3. **Engineering hygiene.** There's no PR CI, the frame ABIs are kept up in parallel, files are 4–11k lines long, and generated binaries are committed without LFS.

**Method and limits.** This was a static review only. The sandbox has no network for Cargo/pub/bun, and `sdk/native` depends on `sdk/.cache/pocketjs`, which is produced by `prepare_upstream.py`. So nothing was compiled, tested or profiled. Performance impact is estimated from code shape. Confirm each item with the existing `pocket_bench`, `render_pipeline_profile_test` and FPS integration tests before and after the change.

## Priority table

| # | Area | Finding | Impact | Effort |
| --- | --- | --- | --- | --- |
| 1 | Flutter render | Fixed 32-op canvas blocks, each a full-screen RepaintBoundary | High | M |
| 2 | Rust frame build | Each changed frame deep-clones the DrawList, nodes and every FrameOp | High | M |
| 3 | Robustness | No `catch_unwind` at the FFI boundary, so a panic aborts the process | High | S |
| 4 | CI | No PR gating (cargo test/clippy, flutter analyze/test, bun test) | High | S |
| 5 | Dart frame apply | Each changed frame does 4+ O(n) passes even though native sends the splice range | Med | S–M |
| 6 | Worker HTTP | A new `ureq::Agent` per request and per redirect hop, so no keep-alive or TLS reuse | Med | S |
| 7 | Build | No `[profile.release]` tuning (LTO, codegen-units, strip) | Med | S |
| 8 | JS a11y | Semantics `onFrame` stringifies all nodes and forces relayout per query | Med | S |
| 9 | Maintainability | Four frame ABIs kept up; only two are used by the SDK | Med | M |
| 10 | Maintainability | God files and a \~960-line decode function | Med | L |
| 11 | Memory | Redundant full-buffer copies when loading bytecode and PAK | Low–Med | S |
| 12 | JS UI | `List` has no virtualization | Low–Med | M |
| 13 | Security | The random editor CSRF token can be bypassed with a static header | Low | S |
| 14 | Repo | 88 MB of binaries without LFS, 27 MB of them generated `.qjbc`/`.pak`; root clutter | Low–Med | S |

## 1. Flutter: index-based canvas blocks defeat raster retention

**Where:** `sdk/packages/pocket_flutter/lib/src/pocket_view.dart:853` (`_canvasBlockSize = 32`), `:7377–7470` (`_buildSurfaceBody`).

Ops are split into blocks every 32 indexes. Each block becomes `Positioned.fill(RepaintBoundary(CustomPaint))`.

- **Boundary shift.** Suppose one op is inserted or removed early in the list, for example a glyph run that gets longer, a list row that appears, or a toast. Every block boundary after that point shifts, so every downstream painter gets different ops, `shouldRepaint` returns true and all those layers repaint. The retained-layer design only pays off when changes happen at the tail.
- **Layer count.** A scene with 2,000 ops yields about 63 full-screen compositing layers. Every RepaintBoundary is a separate full-viewport layer, which costs raster-cache memory and compositor time even where the layer is mostly transparent.
- **Allocation.** `canvasOps.sublist(start, end)` allocates for every block on every scene build.

**Fix:**

- Pick block boundaries by content, not position. Cut at stable structural points that native already knows, such as node-subtree or clip/transform boundaries, and emit them as markers in PFB1. Or pick boundaries with a rolling hash of op identity, so an insertion only disturbs its own block.
- Size each layer to the block's union bounds rather than `Positioned.fill`.
- Cap the number of layers, for example by merging small adjacent blocks.
- Measure with `render_pipeline_profile_test` and `official_demos_fps_test` (raster thread p95, layer count).

## 2. Rust: changed-frame path copies the whole scene several times

**Where:** `sdk/native/src/lib.rs`, `build_frame` (`:3089`).

On a cache miss, each frame:

- clones the full DrawList: `current_draw_list().words.clone()` (\~`:3165`)
- deep-clones every `NodeMeta`: `host.nodes.borrow().clone()` (`:3197`). Each `NodeMeta` holds 6 heap `String`s and a `Vec<u8>` (`:54–75`).
- decodes the whole DrawList again, with no incremental decode
- deep-copies the decoded result again: `ops: Rc::new(ops.clone())` and `auxiliary.clone()` (`:3246–3247`)

`FrameOp` (`:224–274`) is a wide struct of about 30 `Option` fields, including four `Option<String>`s (`text`, `id`, `fit`, `surface_kind`) and an `Option<Vec<u8>>`. Cloning the vector re-allocates every text string. Op kinds are `&'static str` and get compared as strings throughout (22 `kind == "…"` sites). The cache-hit check also runs `self.nodes == nodes`, which compares strings, on every frame.

**Fix:**

- Decode straight into an `Rc<Vec<FrameOp>>` and share it between the cache and the output, so there's no second copy.
- Make `text`, `id`, `fit` and `surface_kind` `Rc<str>` (like `SharedStr`), and `surface_parameters` an `Rc<[u8]>`.
- Keep `nodes` behind an `Rc` with a monotonically increasing `nodes_revision`. Compare the revision instead of the vectors, and clone the `Rc` instead of the data.
- Replace `kind: &'static str` with a `#[repr(u8)] enum OpKind`. Then the encoder `match` is an integer jump, and the struct could become an enum of per-kind payloads, which shrinks memory.
- Longer term, decode incrementally: reuse decoded ops for the unchanged DrawList prefix and suffix, the same splice the v2 delta already computes.

## 3. Robustness: a panic behind the FFI aborts the host app

**Where:** all 57 `#[no_mangle] extern "C"` functions in `sdk/native/src/*.rs`. `catch_unwind` appears once, in `worker.rs`.

Since Rust 1.81, a panic that unwinds out of an `extern "C"` function aborts the process. `lib.rs` has many `unwrap`/`expect` calls and direct `words[n]` indexing in DrawList decode (for example `:793–796`, `:2730–2794`). The DrawList and the JS-driven inputs come from guest code, so a malformed op or a bug in the pinned upstream takes down the whole Flutter app instead of failing one mini-app.

**Fix:**

- Add an `ffi_guard!` wrapper that runs each export body in `std::panic::catch_unwind(AssertUnwindSafe(..))`. On a panic it should store the message in `last_error`, mark the host poisoned, and return the function's error sentinel (`ptr::null()`, `-1`, etc.).
- Have Dart treat a poisoned host as a runtime failure (`_failRuntime`), which it already handles.
- In decode, replace `words[i]` with `words.get(i).ok_or(...)?`.

## 4. CI: nothing gates changes

**Where:** `.github/workflows/` contains only `toolchain.yml`, a release pipeline that runs on `sdk-v*` tags or manual dispatch. It runs three packaging tests.

The repo has hundreds of Rust, Dart and Bun tests (`sdk/native/tests`, `sdk/test`, `pocket_flutter/test`, `editor/test`, `scripts/tests`) and an architecture checker (`scripts/check_architecture.py`). None of them runs on push or PR.

**Fix:** add a `ci.yml` on `pull_request`/`push` that does the following, reusing the existing cache key for `.cache/pocketjs`:

- `prepare_upstream.py`
- `cargo test --locked` and `cargo clippy -D warnings`
- `flutter analyze` and `flutter test` for `sdk/` and its packages
- `bun test` for `sdk/scripts`, `editor` and `demo/js`
- `check_architecture.py`

Run device and integration tests nightly.

## 5. Dart: per-frame O(n) passes after a delta

**Where:** `pocket_runtime.dart:1506–1556` and `pocket_view.dart:3056–3200`, `:3883` (`_requestResources`).

Native sends `prefixCount`, `deleteCount` and the inserted ops. Dart merges them into a full list, then throws the splice range away. `_applyFrame` then makes these passes over every op:

- `_frameVisualEquals`
- `focusedApplication(_frame)` and `focusedApplication(visual)`, each a `whereType` scan
- `_requestResources` → `collectResources`, which builds several `Set`s and calls `_loadImage` for every image asset on every changed frame

The identity fast path in `_pocketOpEquals` keeps each step cheap, but it's still O(n) four or more times per frame during animations and scrolling.

**Fix:**

- Carry `changedStart` and `changedEnd` on `PocketFrame`.
- Compare visuals and scan resources only inside the inserted window. Keep the ops outside the window and their resource set from the previous frame.
- Track the focused-surface op index incrementally.
- Skip `_loadImage` for assets already loaded at the current revision before building futures.

## 6. Worker HTTP: no connection reuse

**Where:** `sdk/native/src/worker.rs:3458` (`let agent = http_agent(remaining)` inside the redirect loop) and `:3603–3611`.

Every request, and every redirect hop, builds a fresh `ureq::Agent`. ureq's connection pool lives inside the agent, so every call pays DNS, TCP and a full TLS handshake. On mobile that's often 100–300 ms per request.

**Fix:** keep one `ureq::Agent` per `WorkerState`, or per granted origin, with `redirects(0)`. Apply the per-request deadline with `Request::timeout(remaining)`, which ureq 2 supports. The origin checks and header stripping on redirect stay as they are; they're already correct (`:3480–3500`).

## 7. Native build profile

**Where:** `sdk/native/Cargo.toml` has no `[profile.release]`, and `build_native.sh` passes no profile overrides.

The defaults (no LTO, 16 codegen units) leave cross-crate inlining between `rquickjs`, `pocket-runtime` and this crate unused, and they make the mobile `.a`/`.so` files bigger.

**Suggested:**

```toml
[profile.release]
lto = "fat"
codegen-units = 1
opt-level = 3
debug = "line-tables-only"   # keep symbolicated crash stacks
strip = "debuginfo"
```

Keep `panic = "unwind"` if you add the `catch_unwind` guard from item 3. Measure binary size and `pocket_bench` before and after the change.

## 8. JS accessibility: per-frame stringify and forced relayout

**Where:** `sdk/packages/pocket_ui/src/semantics.ts:267` and `:424`, plus `sdk/native/src/lib.rs:1126–1171` (`committed_layout`).

`flush` runs on every frame. For each control it reads the layout through the host, and each read calls `core.ui.relayout_outputs()` and walks the parent chain. It then runs `JSON.stringify(nodes)` over the whole snapshot just to check whether anything changed. During scrolling or animation that's per-frame JS allocation plus repeated relayout calls. If any JS mutation lands between the reads, the relayouts thrash the same way forced reflows do in a browser.

**Fix:**

- Expose a batched `layoutMany(ids)` host call that does one relayout.
- Skip `flush` when the core layout revision and the route state haven't changed.
- Compare snapshots field by field (numbers and booleans) instead of stringifying.

## 9. Ablation: retire legacy frame ABIs

**Where:** `sdk/native/include/pocket_flutter.h:55–61`, `lib.rs` (`LegacyFrameOp`, `frame_json_cache`, `patch_frame_number`, `complete_frame_output`).

The native side keeps up four frame outputs: `pocket_frame` (JSON), `pocket_frame_delta` (JSON), `pocket_frame_delta_binary` (v1) and `pocket_frame_delta_binary_v2`. The Dart SDK only looks up `pocket_frame_binary` and `pocket_frame_delta_binary_v2` (`pocket_runtime.dart:567–572`). The JSON frame is only called from `demand.rs` and `replay.rs` tests and probes. The JSON path also does an extra copy for static frames (`json.clone()` plus `c_string(&json)`, `:6433–6438`).

**Fix:**

- Put the JSON and v1 delta exports behind a `legacy-json-frame` Cargo feature that only tests and probes enable.
- Delete `LegacyFrameOp` and the JSON cache fields from `HostState`.
- Move the replay and demand tests onto the binary decoder.

This removes a large share of `lib.rs` and one of the four places a new op kind has to be added.

## 10. Maintainability: file and function size

| File | Lines |
| --- | --- |
| `sdk/native/src/lib.rs` | 10,874 |
| `sdk/packages/pocket_flutter/lib/src/pocket_view.dart` (one `State` class) | 8,040 |
| `sdk/packages/pocket_ui/src/mobile.tsx` | 5,613 |
| `sdk/editor/preview.ts` | 4,986 |
| `sdk/native/src/worker.rs` | 4,886 |
| `sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart` | 4,204 |
| `sdk/editor/server.ts` | 4,071 |
| `sdk/lib/src/pocket_system_host.dart` | 4,070 |

`append_draw_operation_cached` (`lib.rs:3657–4612`) is a single function of about 960 lines. Most of that is struct literals of 30 fields each, repeated once per opcode.

**Fix:**

- Split `lib.rs` into modules: `ffi/`, `frame/{decode,encode,delta}`, `input/`, `bridge/`, `pak/`.
- Give `FrameOp` a `Default` (or use per-kind constructors) so each opcode arm is a few lines.
- Split `_PocketViewState` into collaborators: input/IME, resources/images, video/surfaces, scene builder, performance sampling.
- Split `server.ts` routes into per-resource handlers.

The point is to make the splice and caching optimizations above reviewable in isolation.

## 11. Memory: redundant copies on load

- `pocket_services/lib/src/pocket_package.dart:758,763`: `Uint8List.fromList(await file.readAsBytes())`. `readAsBytes` already returns a `Uint8List`, so this copies the PAK a second time. A PAK may be up to 256 MB, which doubles peak memory. The same pattern appears at `:1920`, `:2063` and in `pocket_view.dart:1992`.
- `pocket_runtime.dart:948` and `:1009–1012` use `calloc` and then overwrite the whole buffer. Use `malloc` to skip the zeroing.
- The bundled-asset path goes rootBundle → Dart bytes → native buffer → native `Vec`. Prefer the existing `pocket_load_bytecode_files` path where an asset can be extracted to a file once, or hand ownership to native without a further copy.

## 12. JS UI: lists are not virtualized

**Where:** `sdk/packages/pocket_ui/src/ui.tsx:2383` (`List` renders every item with `<For>`).

Every item becomes nodes, layout and draw ops, so long feeds grow linearly in JS heap, layout and frame size. That in turn feeds items 1, 2 and 5. A code comment (`ui.tsx:2173`) mentions upstream `VirtualList` examples.

**Fix:** ship a windowed `VirtualList` in `@pocket/ui` with fixed or estimated row heights, overscan and item recycling, and use it in the Showcase feeds.

## 13. Editor: CSRF token can be bypassed

**Where:** `sdk/editor/server.ts:1958–1966` and `:3890–3897`.

A mutating request passes if it carries either the random `x-pocket-csrf` token or the constant header `x-pocket-editor: 1`. The Host allow-list, Origin/Referer and Sec-Fetch checks still block browsers, because a custom header forces a CORS preflight. Even so, the constant header makes the random token pointless. Line 1958 is also redundant with line 1963.

**Fix:** require the token everywhere. The editor UI already reads it from `/health`. Keep `x-pocket-editor` only as a client marker, not as a credential.

## 14. Repository hygiene

- **Binaries.** About 88 MB of tracked binary assets, with no Git LFS (`.gitattributes` only covers patches). 27 MB of that is generated `.qjbc`/`.pak` output under `demo/assets`, and 55 MB is `demo/js/apps/lantern/art` masters at about 2.5 MB per PNG. This contradicts AGENTS.md ("Generated caches and binaries are not source"), and every rebuild grows the history. A shallow clone is already 70 MB. Track art in LFS. Build demo bytecode in CI, or attach it to releases.
- **Root clutter.** Seven audit/review reports (\~320 KB) sit at the repo root, with more in `sdk/docs`. Move them to `docs/reviews/` and keep a single `AUDIT_REMEDIATION.md` status table.
- **AGENTS.md.** It hard-codes the absolute paths `/Volumes/ORICO/...` and specific agent/model commands. Make the paths relative, and move personal workflow notes to a local, untracked file.
- **Lockfiles.** `pubspec.lock` is committed inside library packages (for example `pocket_flutter`). Pub convention is to commit lockfiles only for apps.
- **JS-source entry formats.** Signed packages can still ship JS source (`pocket_view.dart:1997–2015`), and `PocketView` keeps `eval(source)` paths (`:2036–2041`), even though the error message says "source fallback is disabled". Consider rejecting non-bytecode entries in release builds.

## Suggested order of work

1. **Week 1, quick wins:** CI workflow (4), FFI panic guard (3), release profile (7), shared HTTP agent (6), copy removals (11), CSRF tightening (13).
2. **Week 2–3, render path:** remove the Rust clones (2), use the splice window in Dart (5), cheaper semantics flush (8). Benchmark each change with `pocket_bench` and the FPS tests.
3. **Week 3–5, structure:** content-defined canvas blocks (1), retire the legacy ABIs (9), then split the large files (10).
4. **Ongoing:** VirtualList (12), LFS and repo cleanup (14).

## What's already good

- The upstream compiler is pinned and SHA-verified, with controlled patches. Bytecode uses a PJSB envelope with an ABI check.
- The PFB1 binary frames with v2 deltas have careful baseline invalidation on failure.
- The duplex SPSC ring is now on the production input path, and the scheduler can park on idle.
- Worker HTTP has strict origin grants, header filtering, a redirect cap and auth stripping across origins.
- Per-realm QuickJS heap limits and PAK size checks are in place before load.
- Package hashing is streamed (chunked SHA-256), and `pruneInactiveVersions` is now called.
- Editor requests are Host, Origin and Sec-Fetch validated.
