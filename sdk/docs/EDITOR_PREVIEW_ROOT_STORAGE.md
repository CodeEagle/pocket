# Editor preview root storage startup regression

## Failure and request path

The Editor preview could fail with `SystemUI did not respond to platform.storage.get` during Showcase startup. The Showcase calls `platform.storage.get("appearance")` from `restorePreferences()` in `demo/js/app.tsx` as soon as it mounts. The request still belongs to Pocket's JavaScript SystemUI kernel: `sdk/packages/pocket_ui/src/system.ts` serializes `system.request`, authorizes the source and namespace, calls `system.storage.get`, then returns the result through `system.runtime.respond`.

The Editor adapter in `sdk/editor/preview.ts` previously deferred a request only when its source was a child runtime and the root was pumping. A request from the root itself therefore re-entered the root QuickJS realm from inside its active frame. SystemUI's serialized queue could not advance to the queued storage request, and the adapter exhausted its 48 nested pumps. The source check was the defect: root-owned startup I/O hit the same reentrancy boundary as child I/O.

## Change

- Defer every SystemUI request while the root runtime is pumping, regardless of whether the request source is the root or a child.
- After the outer frame unwinds, send deferred requests and pump the root through the existing `system.request` and `system.runtime.respond` contract.
- Keep a 48-pump response limit for a non-continuous root with no outstanding external boundary. Child runtime loads, browser presentations and continuous root demand yield to their existing completion/ticker paths instead of consuming that failure budget.
- Keep the SystemUI kernel's queue, permission checks, storage namespace policy and result validation in JavaScript. The Editor adapter does not fabricate a storage result or bypass the kernel.

The regression test at `sdk/editor/test/preview_root_storage_startup.test.ts` runs a real QJBC package through `pocket_probe`, observes the real `platform.storage.get` host response and waits for the Showcase frame. It wraps the existing response method only to observe the result, then forwards it unchanged.

## Retained source review

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was searched outside its excluded `pocket_host/` directory for `platform.storage`, `system.storage` and `storage.get`. No retained Flutter or web-preview implementation handled this capability; `lib/ui/mini_app_host_page.dart` and `web_wasm_preview/index.html` also contain no storage request path. There was no parent implementation to port. The existing Pocket JS kernel remains the source of truth, and this change adapts only the Editor's transport scheduling.

## Validation and ablation

With the current Editor candidate QJBC and pinned Pocket native probe:

- `preview_root_storage_startup.test.ts` passed: the native preview stayed ready, returned the real SystemUI-authorized storage response, and published `POCKET SHOWCASE`.
- `preview_failure.test.ts` passed: a fake SystemUI that never answers still returns the bounded `SystemUI did not respond to platform.apps.list` failure without an unhandled rejection.
- `preview_storage.test.ts` and `preview_idle_mini_app.test.ts` passed. The latter covers an idle preview, child runtime loading and browser presentation acknowledgements.
- In an isolated temporary copy of `preview.ts`, restoring only the old `source !== root` gate made the same native QJBC regression return HTTP 400 with `SystemUI did not respond to platform.storage.get`. The full change passes against that same artifact. The repository source was not reverted for the ablation.

For the native run in this workspace, the QJBC and PAK were the already-built candidate under `.pocket-build/back-phone-20261110/interactive-candidate/`, and `pocket_probe` came from `.pocket-build/rich-inline-native-tools-20261109-final/`. The default local `node_modules/@pocket/tools-darwin-arm64` manifest reports SDK version `0.1.1`, while `scripts/prebuilt_tools.mjs` requires `0.1.4`; the mismatch was left unchanged. The test supports `POCKET_STORAGE_TEST_BYTECODE` and `POCKET_STORAGE_TEST_PAK` so a known QJBC can be tested without changing or rebuilding the pinned toolchain.
