# Editor preview pointer transport

## Source-first note

The retained parent demo at `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was searched outside its retired `pocket_host/` directory before adapting the
browser preview. It contains no browser canvas pointer transport to reuse; the
browser-facing preview contract is therefore a necessary SDK adaptation rather
than a second guest/layout implementation.

The native input contract remains edge-based: a `down` allocates a contact,
`move`/`up`/`cancel` must use that contact, and at most eight contacts may be
active. The preview keeps that contract in the browser with reusable slots
`0..7`, ignores hover moves without a local down, and serializes wheel as one
`down → move → cancel` sequence on the same input queue.

Pointer state is retired on `up`, `cancel`, `lostpointercapture`, outside-
viewport cancellation, window blur, and preview close. Runtime starts/stops and
a frame counter rollback invalidate the old generation so queued events cannot
be sent to a rebuilt native session. Errors cancel existing contacts instead of
only forgetting their browser-side state.

An HTTP failure does not prove native rejected the input. The browser therefore
awaits a best-effort native CANCEL inside the failed queue operation before
admitting later input; it does not enqueue that cancellation behind a new DOWN
that may reuse the slot. This also covers a lost response after native already
accepted DOWN or MOVE. The original request error remains visible.

On browser reconnection a repeated DOWN first cancels the original captured
runtime at its last admitted coordinates, then admits the new contact.
Cancellation of an already-retired contact is idempotent; unknown MOVE/UP
still fail. Native send/frame failures also cancel the original target rather
than only dropping the adapter map entry. Disconnecting the last browser
projection retires its native contacts through the same cancellation boundary.

## Verification

```sh
cd sdk
bun install
bunx playwright install chromium
bun test editor/test/preview_pointer.test.ts --timeout 60000
bun test editor/test/preview.test.ts --timeout 60000
```

The pointer regression uses Playwright Chromium against a temporary HTTP server
backed by the real `pocket_probe` and lobby bytecode. It exercises the
outside-canvas mouse-down regression, real mouse capture, interleaved
multi-pointer/wheel requests, and lost pointer capture; it is not a source
pattern assertion or a fake screenshot/runtime.

Pointer recovery verification (2026-11-04) runs each test file in a separate
Bun process: `preview_pointer_recovery` (1 pass), `preview_pointer` (1 pass),
`preview_timing` (2 pass), and `preview` (3 pass). These cover real native
admission failures, repeated DOWN, a forced post-DOWN frame failure, browser
reconnection, a native-success MOVE whose HTTP response becomes 503, blur and
close cleanup, multi-contact/wheel ordering, queue coalescing, and real child
guest launch/return. All seven targeted checks pass. The attempted full Editor
suite is not counted as passing: its close-button backing geometry assertion
failed and a later same-process browser test hung; isolated input checks pass.
