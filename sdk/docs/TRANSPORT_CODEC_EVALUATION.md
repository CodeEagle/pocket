# Pocket transport codec evaluation

**Scope:** read-only assessment of the current `pocket/sdk` transport. No production source was changed for this evaluation. The active worktree already contains unrelated glyph and scheduling edits; this report describes the live source paths at the time of inspection.

## Finding

A wholesale JSON-to-Protobuf conversion is not justified by the current transport. The highest-volume rendering path already uses a typed binary frame (`PFB1`), and the default pointer-input path already uses a fixed 16-byte SPSC record. JSON remains mainly in the extensible event/capability protocol and in compatibility paths. A dynamic Protobuf representation (`google.protobuf.Struct`) saved 12–57% of encoded bytes for these representative request/response messages, but its encode/decode/map-conversion work was about 6–17× slower in the linked QuickJS benchmark. This is codec-only evidence, not an end-to-end Dart/FFI/Rust comparison and not an application frame-rate estimate.

The narrower ablation candidate is the remaining JSON round trip *inside* the native pointer adapter: the host sends 16 binary bytes, but Rust rebuilds an `input.pointer` JSON line for the existing guest handler. If profiling shows that dispatch is material, test a direct scalar/object binding which preserves the guest event contract while avoiding that internal stringify/parse. The measured Protobuf path adds serialization work and is not a good replacement for this already compact record.

## Current lanes

| Lane | Current representation | Where conversion still occurs | Normal frequency |
|---|---|---|---|
| Frame output | `pocket_frame_delta_binary` returns PFB1; typed operation tags, fixed-width geometry, and raw pixel/palette bytes | Each emitted event is still encoded as a JSON byte segment in PFB1, then UTF-8 decoded and `jsonDecode`d by Dart. Host-surface descriptors can also remain JSON strings. | On changed frames; unchanged stable frames return no binary payload. |
| Pointer input | ABI v2 SPSC ring record: 16 bytes (`u16 type`, `u16 flags`, `u32 target`, two `f32` args); 256 slots, 255 usable | Normal Dart-to-native transfer does not build a JSON envelope. Rust adapts the record into the canonical JSON `input.pointer` line before dispatch to QuickJS. If the ring is missing, full, or explicitly disabled, the fallback sends JSON. | Per accepted down/move/up/cancel. This is the only standard `PocketView` input currently routed through the ring. |
| Guest host request | JSON event `host.request` with open `params` map | JS `JSON.stringify` → native `_emit` `serde_json::from_str` into a `Value` → PFB1 JSON event segment → Dart UTF-8/`jsonDecode` → `PocketHost` provider. | Per guest capability invocation, not once per frame. The guest bridge allows up to 32 outstanding requests. |
| Host response | JSON event `host.response` with open `result` or `error` | Dart `jsonEncode` → UTF-8/C allocation → `pocket_send` `serde_json::from_str` → original JSON line copied into QuickJS → guest `JSON.parse`. | One response per completed or failed request. |
| Other host/input events | JSON maps | `PocketViewController.send` / `FfiPocketRuntime.send` and `pocket_send`; display geometry is deduplicated when unchanged, while text input sends `textInput.edit` on each editor change. Buttons, axes, and motion remain on the JSON entry point when used. Generic `stream.data` also uses the event wire and can repeat at its producer's rate. | Event-specific; no aggregate event-rate instrumentation was found. |

The ring’s 16-byte record layout and 256-slot storage are in `sdk/native/src/duplex.rs:25-39`; its reported capacity is 255 in `sdk/native/src/lib.rs:3894-3897`. The Dart view defaults `enableDuplexPointerInput` to `true` (`sdk/packages/pocket_flutter/lib/src/pocket_view.dart:171-195`, `:290-295`). The input implementation writes directly into a borrowed ring view and publishes it (`sdk/packages/pocket_flutter/lib/src/pocket_duplex.dart:131-153`); `_sendPointer` uses it by default and preserves a deferred JSON FIFO on fallback (`sdk/packages/pocket_flutter/lib/src/pocket_view.dart:2860-2916`).

### PFB1 and copies

The native code labels PFB1 as the production Flutter frame transport and retains the JSON frame functions for diagnostics and older hosts (`sdk/native/src/lib.rs:313-318`). `encode_binary_frame` writes versioned typed operations, JSON-encoded event segments, and raw resource bytes (`sdk/native/src/lib.rs:490-537`). The active Dart FFI path looks up `pocket_frame_delta_binary`, copies the borrowed native pointer into a `Uint8List`, and calls `PocketFrame.fromBinary` (`sdk/packages/pocket_flutter/lib/src/pocket_runtime.dart:695-745`; lookup/fallback at `:769-797`). The model decodes each embedded event with `utf8.decode` and `jsonDecode` (`sdk/packages/pocket_flutter/lib/src/pocket_model.dart:492-520`); its length-delimited byte reader also copies each segment (`:825-833`). Thus PFB1 avoids JSON maps and decimal arrays for geometry and image pixels, but it is not zero-copy end to end.

The legacy JSON frame fallback remains available when a loaded native library lacks the optional binary symbol (`pocket_runtime.dart:696-745`). This compatibility path is distinct from the compiled current native library. The retained predecessor at `pocketjs_flutter_demo/pocket_host` used JSON frames and JSON `send` (`native/src/lib.rs:3110-3154`, `packages/pocket_flutter/lib/src/pocket_runtime.dart:611-641,684`); old audit notes about “100% JSON” describe that predecessor, not the current `pocket/sdk` source.

### Capability-event conversion boundaries

Guest requests are produced by `JSON.stringify` in `sdk/packages/pocket_ui/src/host.ts:177-215`. Rust's `_emit` parses the string into `serde_json::Value` and queues it (`sdk/native/src/lib.rs:692-705`); `build_frame` drains those values into `FrameResult.events` (`:1985-2000`). PFB1 serializes those events back to JSON bytes (`:499-504`) and Dart creates `PocketEvent` maps from them (`pocket_model.dart:512-520`). Dart then handles the request and validates provider output with `jsonEncode` (`sdk/packages/pocket_services/lib/src/pocket_host.dart:290-341,422-430`).

Responses go through `PocketHost._respond` / `_respondError` and `PocketViewController.send` (`pocket_host.dart:390-409`, `pocket_view.dart:85-115`). `FfiPocketRuntime.send` serializes the map and allocates UTF-8 for the C ABI (`pocket_runtime.dart:1028-1038`). Rust parses the incoming C string as JSON, selects `__pocketDeliver` for a response, and dispatches the JSON line to QuickJS (`native/src/lib.rs:4027-4067`); the guest bridge parses response strings (`sdk/packages/pocket_ui/src/host.ts:61-71,145-157`).

The normal pointer route avoids that host-to-native JSON/C-string parse, but Rust currently reconstructs and serializes the event before invoking the same guest handler (`native/src/lib.rs:1021-1062`). A future optimization, if profiling supports it, should ablate this internal conversion first. It should preserve the `input.pointer` semantics and the existing JS compatibility surface.

## Codec microbenchmark

### Setup

- Host: Apple Silicon arm64, macOS 27.0.1 (2026-11-03).
- Guest engine: existing static `pocket_probe` at `/Volumes/ORICO/Development/Github/pocket/sdk/native/target/aarch64-apple-darwin/release/pocket_probe` (Mach-O arm64; the project Cargo lock pins `rquickjs` 0.12.2). The probe was not rebuilt for this assessment.
- Codec: `protobufjs` 7.5.4, installed only under `/tmp/pocket-proto-bench`; no repo dependency or lockfile was changed. The bundle is executed by the existing QuickJS probe, rather than timing Bun or Node as the guest VM.
- Work per pair: JSON is `JSON.stringify` plus `JSON.parse`. Protobuf is `Event.encode` plus `Event.decode`, `toObject`, and conversion between JS maps and `google.protobuf.Struct`/`Value`. The latter map conversion is required to preserve the open JSON `params` and `result` API.
- Sample shapes: the tested `host.request` envelope for `runtime.info` with empty params; a successful six-field `runtime.info` response fixture; and a primary `input.pointer` fallback envelope. Every protobuf round trip was checked against its JSON object before timing.
- Counts: 2,000 warmup pairs once per case, then 7 timed samples of 6,000 pairs. Per-sample nanoseconds per pair are calculated from `Date.now()` deltas, then the median of the seven samples is reported. The QuickJS `Date.now()` clock is millisecond resolution: JSON samples lasted about 18–35 ms, so small JSON timings have several-percent quantization; Protobuf samples were longer. Treat these as order-of-magnitude codec comparisons, not precise nanosecond measurements.

The schema uses the standard Google dynamic JSON value model, plus typed request/response and pointer envelopes. It is not a schema used by production today:

```proto
syntax = "proto3";
package google.protobuf;
enum NullValue { NULL_VALUE = 0; }
message Struct { map<string, Value> fields = 1; }
message Value {
  oneof kind {
    NullValue null_value = 1;
    double number_value = 2;
    string string_value = 3;
    bool bool_value = 4;
    Struct struct_value = 5;
    ListValue list_value = 6;
  }
}
message ListValue { repeated Value values = 1; }
```

```proto
syntax = "proto3";
package pocket;
message Event {
  string type = 1;
  string id = 2;
  string name = 3;
  oneof payload {
    HostRequest request = 4;
    HostResponse response = 5;
    google.protobuf.Struct generic_payload = 6;
    PointerInput pointer = 7;
  }
}
message HostRequest {
  string request_id = 1;
  string capability = 2;
  google.protobuf.Struct params = 3;
}
message HostResponse {
  string request_id = 1;
  bool ok = 2;
  google.protobuf.Struct result = 3;
  HostError error = 4;
}
message HostError { string code = 1; string message = 2; }
message PointerInput {
  enum Phase { PHASE_UNSPECIFIED = 0; DOWN = 1; MOVE = 2; UP = 3; CANCEL = 4; }
  Phase phase = 1;
  uint32 id = 2;
  float x = 3;
  float y = 4;
  uint32 surface = 5;
}
```

### Results

| Sample | JSON bytes | Protobuf bytes | JSON stringify+parse median | Protobuf encode+decode+map median |
|---|---:|---:|---:|---:|
| `host.request` (`runtime.info`, empty params) | 112 B | 48 B | 3.00 µs | 21.83 µs |
| `host.response` (six-field runtime info result) | 327 B | 289 B | 5.83 µs | 99.00 µs |
| JSON pointer fallback envelope | 123 B | 61 B | 3.67 µs | 22.67 µs |

The dynamic Protobuf payload is 57% smaller for the sampled request, 12% smaller for the response, and 50% smaller for the pointer envelope. Its guest-code round trip is respectively about 7.3×, 17.0×, and 6.2× slower in this QuickJS run. The pointer result is not the production comparison: its standard path is already a 16-byte native ring record, smaller than the 61-byte protobuf envelope.

### Reproduction artifacts

These exact isolated resources produced the final run; they were kept outside the project dependencies:

- `/tmp/pocket-proto-bench/repro/bench.mjs` — codec and inlined schema.
- `/tmp/pocket-proto-bench/repro/quickjs_probe.mjs` — sends source and case calls to the native probe.
- `/tmp/pocket-proto-bench/repro/bench.bundle.js` — generated browser IIFE loaded by QuickJS.
- `/tmp/pocket-proto-bench/final-quickjs-results.json` — final result payload.
- `/tmp/pocket-proto-bench/node_modules/protobufjs` — isolated ProtobufJS 7.5.4 installation.

The reproduction flow is: copy the two `.mjs` files into the same temporary folder as an isolated `protobufjs@7.5.4` install, run `bun build bench.mjs --target=browser --format=iife --outfile=bench.bundle.js`, then run `node quickjs_probe.mjs <path-to-pocket_probe>`. The final run used 6,000 iterations, 7 samples, and 2,000 warmups per case.

### Limits

The scripts and original machine-readable result are now retained under `sdk/scripts/bench/transport_codec/`; its README describes a reproducible isolated install. They do not add ProtobufJS to SDK dependencies. The original `/tmp` paths above remain provenance for the measured run.

The benchmark times only the guest JavaScript codec. It does not time Dart's `jsonEncode`/`jsonDecode`, `toNativeUtf8`, Rust `serde_json`, PFB1 serialization/decoding, FFI crossings, or the plugin/provider work. `protobufjs` is one real Protobuf implementation, not a proxy for every generated Dart/Rust/JS codec; a generated fixed schema may perform differently. A fully typed per-capability protocol may also encode smaller than `Struct`, at the cost of replacing the current open-ended plugin data contract. No event-rate or end-to-end latency trace was available, so no per-second bandwidth or frame-rate projection is made.

## Recommendation

Keep PFB1 for frames and the 16-byte duplex record for pointer input. Keep JSON for the low-frequency, extensible capability/control events unless end-to-end profiling shows their serialization is a bottleneck. If optimizing the remaining pointer path, first compare the current native JSON adaptation against a direct scalar binding to the existing guest event dispatch. That ablation targets an actual duplicate conversion without adding another codec layer.
