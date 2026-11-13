# Editor preview root storage startup regression

## Failure and request path

The Editor preview could fail with `SystemUI did not respond to platform.storage.get` during Showcase startup. The Showcase calls `platform.storage.get("appearance")` from `restorePreferences()` in `demo/js/app.tsx` as soon as it mounts. The request still belongs to Pocket's JavaScript SystemUI kernel: `sdk/packages/pocket_ui/src/system.ts` serializes `system.request`, authorizes the source and namespace, calls `system.storage.get`, then returns the result through `system.runtime.respond`.

The Editor adapter in `sdk/editor/preview.ts` previously deferred a request only when its source was a child runtime and the root was pumping. A request from the root itself therefore re-entered the root QuickJS realm from inside its active frame. SystemUI's serialized queue could not advance to the queued storage request, and the adapter exhausted its 48 nested pumps. The source check was the defect: root-owned startup I/O hit the same reentrancy boundary as child I/O.

## Change

- Defer every SystemUI request while the root runtime is pumping, regardless of whether the request source is the root or a child.
- After the outer frame unwinds, send deferred requests and pump the root through the existing `system.request` and `system.runtime.respond` contract.
- Give each outstanding request one wall-clock deadline (`commandTimeoutMs`, or the existing 15-second fallback), correlated to the source and root runtime generations. The 48 inline pumps are a yield budget, not a response timeout; asynchronous SystemUI work can finish on a later normal root turn.
- On expiry, send the original guest a `system_request_timeout` host error and publish the settled frame. A late `system.runtime.respond` is acknowledged as stale without creating a second guest result. Completing, destroying or replacing either runtime clears or rejects the pending request and its timer.
- Keep the SystemUI kernel's queue, permission checks, storage namespace policy and result validation in JavaScript. The Editor adapter does not fabricate a storage result or bypass the kernel.

The regression test at `sdk/editor/test/preview_root_storage_startup.test.ts` runs a real QJBC package through `pocket_probe`, observes the real `platform.storage.get` host response and waits for the Showcase frame. It wraps the existing response method only to observe the result, then forwards it unchanged.

## Retained source review

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was searched outside its excluded `pocket_host/` directory for `platform.storage`, `system.storage` and `storage.get`. No retained Flutter or web-preview implementation handled this capability; `lib/ui/mini_app_host_page.dart` and `web_wasm_preview/index.html` also contain no storage request path. There was no parent implementation to port. The existing Pocket JS kernel remains the source of truth, and this change adapts only the Editor's transport scheduling.

The optional local Preview host adapter is a separate, explicitly configured
development boundary for `funhub.host.config` and `dio.request`. Source-first
inspection of the retained parent `web_wasm_preview/index.html` and searches
outside `pocket_host/` found no host-config or Dio HTTP adapter to reuse. The
Editor therefore reuses its existing PreviewManager and the existing JS-owned
SystemUI request queue, and only adapts the thin local host boundary: one
project-bound private JSON config, one exact origin allowlist, exact GET/POST
routes, bounded request/response bodies, and no automatic redirects. It does
not add a second runtime, storage policy, or guest-side request path.

## Validation and ablation

With the current Editor candidate QJBC and pinned Pocket native probe:

- `preview_root_storage_startup.test.ts` passed: the native preview stayed ready, returned the real SystemUI-authorized storage response, and published `POCKET SHOWCASE`.
- `preview_failure.test.ts` passed: a fake SystemUI that never answers receives one bounded timeout response, and its later response is acknowledged as stale without an unhandled rejection.
- `preview_system_request_pending.test.ts` passed with real delayed responses for root and child request sources; both original request IDs resolve, and completed timers leave no pending entries.
- `preview_host_adapter.test.ts` passed with an actual loopback HTTP server. It verifies project-scoped host config, exact route/origin admission, rejected unlisted routes and a chunked response that exceeds 1 MiB before the server finishes sending.
- `preview_http_async.test.ts` builds a real Guest and pauses its loopback HTTP response. A second native pointer action changes the Guest frame before the response is released; the result then updates the frame once. Disposing the preview aborts a second in-flight request and sends no late response to the stopped Guest.
- `preview_storage.test.ts` and `preview_idle_mini_app.test.ts` passed. The latter covers an idle preview, child runtime loading and browser presentation acknowledgements.
- In an isolated temporary copy of `preview.ts`, restoring only the old `source !== root` gate made the same native QJBC regression return HTTP 400 with `SystemUI did not respond to platform.storage.get`. The full change passes against that same artifact. The repository source was not reverted for the ablation.
- For HTTP response admission, reverting bounded stream reads to `response.text()` makes the hanging chunked-body fixture report `preview HTTP request timed out` instead of the 1 MiB limit; the production code rejects as soon as accumulated bytes cross the cap.

In the latest local validation, `preview_root_storage_startup.test.ts` built the current Demo source into temporary QJBC/PAK files with the prepared pinned PocketJS compiler, then ran them through the release `pocket_probe`. `preview_idle_mini_app.test.ts` exercised the checked-in Demo and child artifacts with that same probe. The local prebuilt `@pocket/tools-darwin-arm64` manifest mismatch was left unchanged; these tests use the source-build path instead. `preview_root_storage_startup.test.ts` also supports `POCKET_STORAGE_TEST_BYTECODE` and `POCKET_STORAGE_TEST_PAK` for checking a known QJBC without changing the pinned toolchain.
