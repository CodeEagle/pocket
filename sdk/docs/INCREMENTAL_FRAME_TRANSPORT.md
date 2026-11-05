# Incremental frame transport

## Source-first review

The retained parent implementation was inspected before changing the native
transport:

- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart`
  keeps the retained node tree, reuses nodes by component tag, and reports
  tree revisions to the active viewport.
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart`
  drives page lifecycle, VSync, and real-time canvas updates through the
  native boundary; it does not own a second DrawOps layout or frame-delta
  state machine.

Those paths establish the behavior that matters for this adaptation: business
state and component composition remain in JS, retained visual output is
consumed at a frame boundary, and an input/event boundary must not be hidden by
an unchanged visual cache. The parent code has no PFB1/PFP1 implementation to
reuse, so the native change reuses the SDK's existing `FrameDrawCache`, typed
`FrameOp` values, and PFB1 encoder rather than introducing another renderer or
unbounded resource cache; the resync path keeps only the one caller-baseline
ledger described below.

## ABI and protocol

`pocket_frame_delta_binary` remains unchanged. It still returns a complete PFB1
frame for a changed frame and a null pointer with a zero length for an unchanged
frame. Existing JSON and PFB1 callers therefore retain their prior semantics.

The opt-in symbol is:

```c
const uint8_t *pocket_frame_delta_binary_v2(
    HostState *handle, double delta_ms, uint64_t base_frame,
    uint64_t *out_byte_length);
```

The result is either the original PFB1 bytes or a PFP1 envelope. PFP1 is
little-endian and has an exactly 28-byte header:

| offset | type | meaning |
| ---: | --- | --- |
| 0 | `u32` | magic `0x31504650` (`PFP1`) |
| 4 | `u64` | `baseSequence` supplied by the caller |
| 12 | `u32` | common ordered prefix operation count |
| 16 | `u32` | operation count deleted after the prefix |
| 20 | `u32` | resulting full primary operation count |
| 24 | `u32` | embedded PFB1 byte length |

The payload is a complete PFB1 frame for the new sequence. Its primary `ops`
array contains only the insertion segment between the common prefix and suffix.
Events, resources, released resources, and the complete auxiliary surface
metadata remain the current frame's full values. The splice compares typed
`FrameOp` values (including geometry, clip, order, and metadata), never a
probabilistic hash.

The native side returns zero bytes only when the caller's base is the latest
published sequence, the retained visual frame is unchanged, and there are no
events or resource lifecycle records. An idle probe advances the internal
diagnostic counter but does not advance the published v2 baseline. A first
frame, invalid base, resize, guest evaluation/reload, or a patch that is not
smaller than a full PFB1 returns PFB1. Full-frame calls publish their sequence
for v2 base matching so a caller may safely interleave full and delta reads;
they do not confirm/update the resource snapshot and retain the legacy
resource-delta behavior described below.

### Resource resynchronization

`sent_resources` is the native-side ledger used to keep ordinary in-order
frames incremental. It is advanced while a frame is built, so it cannot also
serve as the caller's acknowledged baseline: a Dart decode failure can discard
the packet after native has already consumed its resource/release records.
The host therefore retains one bounded snapshot of the caller-confirmed
resource identities (asset, texture handle, and content revision). A v2 call
whose base matches the last published sequence confirms that snapshot before
building the next frame. Resource acknowledgement does not require a retained
DrawOps cache: viewport resize keeps the published sequence and Dart's last
decoded frame while invalidating native DrawOps. The next packet is still full
PFB1, but its echoed sequence confirms the resources the receiver already has.
This lets a subsequent stale-base retry recover a release even when the first
post-resize packet was dropped. No second Dart resource ledger is needed.
A stale-base, first, resize, reload, auxiliary-surface
generation change instead emits every resource referenced by both primary and
auxiliary DrawLists and adds releases for assets absent from the confirmed
snapshot. Before the first v2 base echo, the current sent ledger is used only
as a conservative same-asset release source; no frame history or reset field
is added.

Same-asset handle/revision replacement emits a release before the replacement
resource so Flutter's asset-keyed image cache cannot retain old pixels. Normal
in-order v2 frames still send only changed resources; a stable idle frame keeps
the existing null/zero-byte result. Legacy JSON/PFB1 full calls continue to
use their original resource-delta behavior; a Dart decode failure must request
an explicit v2 base-zero resync so native can distinguish that recovery from a
normal editor/full-frame transaction.

## Validation

The native QuickJS integration test creates 100 real retained rectangles,
changes one rectangle through a dispatched JS event, checks the PFP1 prefix /
delete / resulting counts and embedded one-op payload, verifies that the event
is preserved, exercises zero-byte idle and stale-base full fallback, and checks
that a guest re-evaluation forces a new full baseline. A second real fixture
uploads red pixels, replaces them with green pixels, drops the replacement and
release packets, then verifies that stale-base PFB1 contains the green resource
and the baseline release record; the in-order half of the fixture asserts the
resource delta stays incremental and idle remains zero bytes.
The resize regression starts with an unacknowledged texture frame, changes the
viewport, releases the image, drops the next packet, and retries the old
sequence. Both the dropped packet and the full recovery must contain the
release. The Flutter FFI fixture separately checks full operations and texture
pixels for the new viewport after resize.

Focused command:

```text
cargo test --manifest-path sdk/native/Cargo.toml --test frame_delta_cache -- --nocapture
```

The test also retains the pre-existing legacy `pocket_frame_delta_binary`
coverage, so old PFB1 behavior is checked alongside v2.

The measured QuickJS run reports 3,741 bytes for the initial 100-rectangle
PFB1 frame, 0 bytes for the idle v2 probe, and 159 bytes for the one-rectangle
change (PFP1 plus its one-op embedded PFB1 payload).
