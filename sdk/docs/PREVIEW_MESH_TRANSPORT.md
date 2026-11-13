# Browser Preview geometry transport

2026-11-12. Follow-up to the small Live2D seam/rasterization correction.

## Source-first boundaries

Inspected retained `../pocketjs_flutter_demo/web_wasm_preview/index.html`
(the WASM/ring-buffer preview) and `../pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`
(the retained Flutter rendering surface), excluding `pocket_host/`. The parent
contains no compatible Studio SSE mesh dictionary. Reuse the SDK's canonical
FrameResult and existing Canvas/WebGL compositor; optimize only the browser wire
projection. Native frames, pinned guest execution, recording replay, public
snapshots and loose resource HTTP delivery remain canonical.

Existing PMS1 stores float32 model-space geometry. Studio composites child
points using scale and offset in JavaScript, so its final coordinates may carry
double precision. A browser wire codec must round-trip those values losslessly;
reusing float32 PMS1 blindly would change screen-space coordinates. This change
adds no layout or animation implementation and no Flutter state machine.

## Baseline and ablations

Saved actual Hiyori frame at 375×812: 3,519 operations, 1,458,505 bytes of JSON
when resources are excluded. Original atlas resources travel separately over
HTTP in the normal browser projection; the large canonical debug snapshot is
not a steady-state SSE payload.

Local Node microbenchmark (15 warmed samples): JSON stringify median 3.38 ms,
JSON parse 4.45 ms. gzip level 1 reduced the sample to 179,744 bytes (12.3%), but
added 4.10 ms compression and 1.36 ms decompression. These are local saved-data
measurements, not end-to-end FPS. Compression does not remove native JSON output
or browser object reconstruction; it is not enabled by this change.

## Slow consumer policy

Frame packets can contain resource releases, input/lifecycle edges and launch
presentation barriers. Do not silently drop or coalesce them. The server's
ReadableStream application queue is byte-bounded. A slow connection is failed
explicitly and removed using the same cleanup path as cancellation, including
pointer cancellation, pending presentation failure when the last browser goes
away, timer cleanup and Bluetooth lease release. EventSource can reconnect to a
full current replay; connection-local geometry state must restart too.

The queue budget bounds only this application queue. Socket, HTTP runtime and
browser buffers are outside it. An oversized but otherwise valid initial
snapshot may exceed the budget by one packet. Disconnect recovery restores the
retained snapshot; it does not promise delivery of every one-shot event from the
failed connection. Pending barriers fail rather than being acknowledged falsely.

## Browser wire implementation and ablations

Clients explicitly negotiate `meshes=retained-v1`. Consecutive compatible native
texture triangles are represented by shared static metadata/UV templates and
little-endian Float64 position arrays. A connection-local, byte-bounded LRU
retains prior runs; changed coordinates update the positions, identical content
uses a reference. Every input is still inspected for in-place mutations. No
Core change flag or array identity substitutes for comparison. Unsupported
operations retain canonical JSON, in their original draw order.

Both endpoints retain at most 64 slots / 8 MiB of encoded mesh data and metadata.
Template replacement identifies the replaced slot explicitly, so a recently
used replacement cannot make decoder eviction diverge from encoder eviction.
The accounting includes the same metadata bytes at both endpoints. Reconnection
starts a fresh encoder and resets the decoder on every EventSource `open`, even
when automatic reconnect reuses its JavaScript EventSource object. Invalid or
missing references cause a fresh connection/replay rather than stale rendering.

Removed redundant implementations: the decoder is one self-contained function,
embedded by `clientSource()` and used directly by Node/Bun tests. There is no
second hand-maintained browser decoder. A raw legacy client without that codec
requests canonical SSE. Snapshot/recording/native JSON formats are unchanged.

The first prototype canonicalized and cloned static metadata for every triangle.
Its 40-sample total medians were 8.12 ms (moved) / 7.42 ms (unchanged), slower than
the 5.61 ms JSON baseline despite smaller packets. That redundant work was
removed: canonicalize the run template once and compare subsequent metadata
without reserializing or cloning it. Unknown JSON own properties, including
`__proto__`, remain data. Previous decoded frames are not mutated by later ones.

Final representative local Bun run, 40 warmed samples, same actual saved Hiyori
frame and textures excluded from the wire. Total medians include encoder,
stringify, parse and decoder; they are not browser FPS or network latency.

| Wire scenario | Bytes | Total median |
| --- | ---: | ---: |
| Canonical JSON | 1,458,505 | 4.75 ms |
| First retained frame | 534,543 | 4.39 ms |
| All positions changed | 311,589 | 1.83 ms |
| Geometry unchanged | 22,858 | 1.23 ms |

Reproduce with a local canonical snapshot (no licensed assets are committed):

```sh
sdk/node_modules/.bin/bun sdk/scripts/benchmark_preview_mesh_wire.mjs /path/to/frame.json
```

The native probe still emits full canonical JSON before Studio composition.
This browser transport change does not speed Flutter's FFI boundary; the shared
SDK submission optimization is documented separately in
`RETAINED_MESH_SUBMISSION_OPTIMIZATION.md`.

## Full-scene and runtime validation

`preview_full_scene_transport.test.ts` uses the locally captured complete Mist
Harbor frame, asserts background image, dialogue/text and more than 1,000 model
triangles are present, and compares every rendered RGBA component before/after
transport. The result is zero differing components, with all draw operations
retained. It skips when the uncommitted licensed capture is unavailable.
Synthetic codec, eviction, reconnect, slow-consumer and browser pixel tests
remain available without that capture. The actual Guest and mixed-stage browser
regressions also pass through the pinned compiler/native probe.

A separate headful hardware-rendered Hiyori fixture measured 87,958,445 versus
18,813,905 SSE characters over approximately four seconds (about 79% less).
Its model update intervals stayed around 50 ms in both variants; this demonstrates
transport reduction, not an FPS improvement. That fixture intentionally omits
other scene graphics and is not the complete-scene acceptance result above.
The full Demo is rebuilt and served separately by Studio on port 8791.
