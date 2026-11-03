# JS host streams and platform experience

`@pocket/ui/streams` is the guest-side adapter for the existing Dart
`PocketStreamBridge`. It does not create a second event bus: packets are
emitted with the `HostBridge`'s existing `pocket._emit` path and inbound
packets are consumed from the existing `__pocketEvent` sink.

## Wire contract

An outgoing stream uses the same event envelope as a host request:

```json
{
  "type": "event",
  "name": "stream.open",
  "payload": {
    "streamId": "guest-stream-1",
    "topic": "platform.links.events",
    "params": { "source": "profile" }
  }
}
```

Data, normal completion, failure, and cancellation use the corresponding
`stream.data`, `stream.end`, `stream.error`, and `stream.cancel` names. Data is
`payload.data`; failure is `{streamId,error:{code,message}}`. A batch is:

```json
{
  "type": "event",
  "name": "stream.batch",
  "payload": {
    "events": [
      {
        "method": "stream.data",
        "params": {
          "streamId": "guest-stream-1",
          "data": { "value": 1 }
        }
      }
    ]
  }
}
```

The Dart host matches `stream.open.topic` exactly against its registered
stream capability. The adapter therefore does not infer capabilities, select
an app, or silently fall back to an optional global. Host policy can reject an
open with `capability_denied` or `capability_unavailable`; a failed guest
transport is reported locally as `stream_unconfigured` or
`stream_send_failed`.

Guest IDs use a deterministic, per-adapter `guest-stream-N-` prefix, while the default Dart bridge uses
`host-stream-`. Explicit guest IDs must retain their adapter prefix. The adapter
rejects collisions instead of accepting a packet from the wrong owner.

Each adapter admits at most 16 active streams by default (configurable up to 128).
Each stream has a bounded queue and pending-read count (default 64, maximum 4096). If a
consumer does not read quickly enough, it enters `errored` with
`stream_buffer_overflow` and sends a structured `stream.error`. Deadlines are
optional and use the official guest virtual timer through `HostBridge.scheduleTimeout`.
The timer wakes an idle runtime at its deadline without a frame probe or a
wall-clock interval. Request-only/manual test bridges can fall back to explicit
`HostBridge.tick()` advancement; that fallback does not itself wake an idle runtime.
A normal `stream.end` preserves already-buffered data; remote
`stream.error` and `stream.cancel` reject pending `read()` calls, and later
terminal packets are ignored. Breaking an async iterator cancels its producer.
Equal data payloads remain separate events. Consumers which wrap `__pocketEvent`
must forward each packet once; they must not also call `host.handle` on a bridge
which already owns the underlying event sink.

Minimal usage:

```ts
import { createHostBridge } from "@pocket/ui/host";
import { createPocketStreamAdapter } from "@pocket/ui/streams";

const host = createHostBridge();
const streams = createPocketStreamAdapter(host);
const readings = streams.open("sensor.readings", { sensor: "accelerometer" });
readings.onData((value) => console.log(value));
// readings.cancel("screen closed") when the consumer leaves the screen.
```

## Platform experience

`@pocket/ui/platform-experience` is a thin policy wrapper around the same
bridge. It exposes these fixed capabilities:

- `platform.links.initial` and `platform.links.latest` are one-shot requests;
- `platform.links.events` is an explicit, callback-driven stream;
- `platform.systemUi.set` and `platform.haptics.perform` are one-shot
  requests.

Construction performs no link request and creates no stream adapter. Calling
`subscribeLinks` (or `experience.links.subscribe`) is the only action that
opens `platform.links.events`; unsubscribing cancels that stream. The wrapper
does not maintain a page stack, collect links in the background, choose an
application, or choose a route. A page surface may call `systemUi.set` from
its own current-route effect when it needs that behavior.

Unsupported optional platform features are not converted into success values.
Use `isUnsupportedPlatformError(error)` to recognize host codes such as
`unconfigured`, `capability_denied`, and `capability_unavailable` while
preserving the original host error and message.

## Verification

The deterministic host-wire tests run without a Flutter device:

```sh
bun test sdk/packages/pocket_ui/test/streams.test.ts \
  sdk/packages/pocket_ui/test/platform_experience.test.ts
```

For a built native QuickJS probe, the same envelope can be exercised by
installing a real QuickJS event receiver, injecting `stream.data` followed by
`stream.end`, and having that receiver emit an observable test event. The
command below is intentionally a wire smoke test; it does not claim a host
capability is configured:

```sh
printf '%s\n' \
  '{"op":"create"}' \
  '{"op":"eval","source":"globalThis.__seen=[];globalThis.__pocketEvent=(line)=>{const p=JSON.parse(line);if(p.name===\"stream.data\")globalThis.__seen.push(p.payload.data);if(p.name===\"stream.end\")pocket._emit(JSON.stringify({type:\"event\",name:\"test.stream.done\",payload:{count:globalThis.__seen.length}}));}"}' \
  '{"op":"send","message":{"type":"event","name":"stream.data","payload":{"streamId":"host-stream-1","data":{"value":1}}}}' \
  '{"op":"send","message":{"type":"event","name":"stream.end","payload":{"streamId":"host-stream-1"}}}' \
  '{"op":"frame","deltaMs":16}' \
  | sdk/native/target/release/pocket_probe
```

The final frame contains `test.stream.done` with `count:1`, proving that the
QuickJS guest received data and then end through the native event route.

Run that only against a locally built `pocket_probe`; no device build is
required for the Bun tests above. A real capability provider must register its
stream with the Dart `PocketHostRegistry`; JS cannot manufacture a successful
hardware result.
