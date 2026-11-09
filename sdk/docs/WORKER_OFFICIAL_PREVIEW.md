# Official Worker HTTP preview

The Showcase's Worker HTTP entry is the pinned upstream
`apps/worker-http` package.  The source-first check of the retained parent
checkout (`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding
`pocket_host/`) found no independent Worker realm or HTTP capability to reuse;
its old duplex example is not used as a fallback.

## Retained behavior and host adaptation

- `sdk/.cache/pocketjs/apps/worker-http/pocket.json` declares one `http` Worker
  node and the `request`/`progress` channels.
- `worker.ts` performs the real `io.http("http")` request to
  `https://example.com/` and reports progress through the pinned channel
  contract.  `main.tsx` keeps the same request and progress behavior.
- The pinned build produces a Worker descriptor in
  `app.bytecode.json`.  Its `worker.bytecode.path` is `app.worker.qjbc`, so the
  staged Flutter catalog resolves it relative to the main metadata asset:
  `assets/apps/official/worker-http/app.worker.qjbc`.
- `demo/lib/official_demo_catalog.dart` grants the exact origin only when the
  canonical `worker-http` entry contains an HTTP Worker node.  The grant is
  passed through the existing `PocketAppConfig.workerHttpOrigins` field; no
  Dart UI, business state, or second scheduler is introduced.  Other Worker
  entries receive no HTTP origins.

The host does not treat a Worker declaration as a network grant.  The signed
manifest/descriptor still supplies the capability declaration, while the
Flutter host supplies the explicit origin allowlist at Session admission.

## Validation

The catalog unit tests pass with:

```sh
cd demo
flutter test --no-pub test/official_demo_catalog_test.dart
```

They cover safe relative Worker paths, metadata-relative asset resolution,
the canonical `https://example.com` grant, denial for another Worker entry,
and loading every staged Worker bytecode asset when present.  Device HTTP,
TLS, and power measurements remain outside this preview's evidence.

`sdk/editor/test/preview_worker.test.ts` executes a real compiled UI and Worker
through `pocket_probe`, starts a Worker HTTP request, and verifies an HTTP
response from a local server through the Worker progress channel.
The official staging sweep now compiles both QJBC artifacts and runs a
Worker-aware `pocket_bench` with Worker configuration attached before UI
evaluation. The resulting benchmark is startup/frame evidence, not an HTTP
completion or device FPS measurement. The Showcase adds a pointer Request
control while retaining the upstream button trigger and Worker IO behavior.
The disposable Worker source also corrects the completion fallback: if closing
the resource ends observation before its final end fact is consumed, an
`ok` completion is reported as Complete rather than Request failed. The pinned
cache source is preserved; the same adaptation is exercised by the HTTP test.
