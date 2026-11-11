# Preview Compact Native Resources

## Source-First Inspection

Per `AGENTS.md`, we inspected the retained parent repository `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` (excluding `pocket_host/`) before modifying the native probe or host crate:

- `native/pocket_runtime_multi.c` and `native/pocket_runtime_multi.h`: Retained C multi-sandbox runtime bridge for Flutter; does not include the line-oriented `pocket_probe` JSON process or Editor preview resource transport.
- `lib/core/pocketjs_bundle_runner.dart` and `lib/ui/mini_app_host_page.dart`: Retained Flutter host runners consuming native frames directly.
- `web_wasm_preview/index.html` and `pocketjs_super_app_demo.html`: Retained static/concept HTML surfaces without the `pocket_probe` process protocol.

In the active SDK (`sdk/`), `sdk/editor/client/preview.js` (`resourceBytes(value, bytesEncoding)`) and `sdk/editor/preview.ts` (`encodePreviewStreamPacket`) already support `bytesEncoding: "base64"` on `FrameResource` objects (`pixels` and optional `palette`), while `sdk/native/src/bin/pocket_probe.rs` enforced `MAX_RAW_FRAME_BYTES = 64 MiB` on the raw JSON emitted by `pocket_frame`.

## Evidenced Gap

When mounting Live2D Hiyori (`2 × 2048 × 2048` RGBA8888 atlas textures = `33,554,432` raw pixel bytes), `FrameResource.pixels` (`Vec<u8>`) was serialized by `serde_json` as a JSON numeric array (`[r,g,b,a,...]`). That expanded 32 MiB of texture bytes beyond `64 MiB` (`MAX_RAW_FRAME_BYTES`) before `pocket_probe` returned the response, failing with:

```text
pocket_frame returned JSON larger than 64 MiB
```

`git blame` and `git show` trace this exact guard/error to commit `3a2cfcda`
(`fix: keep mini app entry frames responsive and hide preparation before admission`,
2026-11-09). It introduced the raw-frame size rejection; numeric-array expansion
is the transport mismatch corrected here. The guard is retained.

## Retained Behavior & Minimal Adaptation

- **Public C ABI & Flutter Binary ABI Unchanged**: `pocket_frame`, `pocket_frame_delta`, `pocket_frame_binary`, `pocket_frame_delta_binary`, and `pocket_frame_delta_binary_v2` keep their exact signatures and payload formats.
- **64 MiB Safety Limit Retained**: `MAX_RAW_FRAME_BYTES` (`64 * 1024 * 1024`) in `sdk/native/src/bin/pocket_probe.rs` remains enforced on both `rawFrame: true` and parsed JSON probe frame paths.
- **Single `build_frame` & Shared Cache**: Added the Rust-only helper in `sdk/native/src/lib.rs`:
  ```rust
  pub unsafe fn pocket_frame_for_probe_json(
      handle: *mut HostState,
      delta_ms: f64,
      compact_resources: bool,
  ) -> *const c_char
  ```
  It runs the same guarded `build_frame(host, delta_ms, false, false)` once and delegates to `complete_frame_output(host, built, compact_resources)`.
- **Zero Numeric-Array Overhead When Compact**: When `compact_resources` is `true` and `frame.resources` is non-empty, `complete_frame_output` serializes a borrowing `CompactFrameResult` wrapper whose `CompactFrameResource` entries encode `pixels` (and optional `palette`) directly from `&[u8]` into standard base64 strings with `"bytesEncoding": "base64"`. Frames with no resources use the unchanged `FrameResult` serialization and `frame_json_cache` fast path.
- **Opt-In Probe Flag**: `sdk/native/src/bin/pocket_probe.rs` accepts `"resourceEncoding": "base64"` on:
  - `{"op": "frame", "deltaMs": 16, "resourceEncoding": "base64"}` (including `"rawFrame": true` and traced `"traceClock": {...}` requests)
  - `{"op": "load", ..., "render": true, "resourceEncoding": "base64"}`
  - `{"op": "loadBytecode", ..., "render": true, "resourceEncoding": "base64"}`
  - `{"op": "eval", ..., "render": true, "resourceEncoding": "base64"}`
  Omitting `resourceEncoding` preserves legacy numeric-array JSON byte-for-byte. Any unsupported `resourceEncoding` value is rejected with an explicit probe error.

## Validation

- Built debug `pocket_probe`:
  - `cd sdk/native && cargo build --bin pocket_probe`
- Focused library and binary unit tests in `sdk/native`:
  - `cargo test --lib probe_compact_resource_json_matches_legacy_and_shrinks_large_textures_under_64_mib`
  - `cargo test --bin pocket_probe`
  - Verified exact decoded byte and metadata parity (`asset`, `revision`, `width`, `height`, `psm`, `linear`, `pixels`, and `PSM_5` `palette`) against legacy numeric arrays on real guest execution, identical no-resource frame output and `frame_json_cache` hits, `rawFrame: true` + `traceClock` compatibility, and two `2048×2048` RGBA pages (`> 64 MiB` in legacy numeric JSON) serializing to `~42.7 MiB` (`< 64 MiB`) in compact base64 JSON.

### Actual Studio acceptance (2026-11-11)

Used Playwright Chromium against Studio on port 8791 with the source-built debug
probe and pinned compiler/bytecode tool. Opened Showcase → Visual Novel → 立绘试映,
advanced the introduction, and selected 官方 Hiyori · Live2D. The first displayed
model frame contained 3,381 textured triangles. Selected Idle 0 · 呼吸: successive
frames changed from frame 3391 / 3,345 meshes / vertex hash 3113270249 to frame
3394 / 3,353 meshes / hash 2069031712. A real mouse drag produced frame 3404 /
3,343 meshes / hash 3871437511. No browser page errors or failed preview input
responses occurred. This validates actual guest execution, animation and input,
in addition to serialization parity. Existing native recovery and browser
multi-pointer/wheel/lost-capture regressions also passed against this probe.
