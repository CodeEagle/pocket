# WeChat host lifecycle remediation

## Source and retained behavior

The retained parent host was inspected at
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/wechat_host/core/wx_pocket_host.js`
and its page entry point. Those files retain the original page/tree host, while
the current `PocketWechatHost` owns the WASM canvas, host capability bridge,
timer scheduling, and IME lifecycle in
`sdk/targets/wechat/template/wechat-host.js`.

## Change

Disposal closes admission with the existing `disposed` flag before cancelling pending requests; a second teardown state is unnecessary.
Requests emitted synchronously by abort hooks are
dropped instead of being added to `pending` after the host has begun teardown.
Abort hooks are isolated per request, so a provider exception cannot prevent
the remaining requests from being cancelled or prevent the native WASM host
from reaching the `finally` cleanup. Repeated disposal remains idempotent.

The existing scale-preserving resize and delayed idle-frame scheduling are
retained. `hide()` still cancels requests and `show()` can wake a live host.

## Verification

`TMPDIR=/tmp bun test scripts/tests/wechat_lifecycle.test.ts` passes 5 tests:

- abort/response reentrancy leaves no pending request and destroys once;
- one throwing abort hook does not stop later cancellation;
- resize preserves startup scale and hide/show remains reusable;
- native destroy failure still releases references;
- disposal during WASM initialization prevents late allocation.

The earlier Bun mock probe in `/tmp/pocket-remediation-logs/wechat_host_mock_probe.ts`
also remains the reference for schedule/resize timing. These checks do not
replace WeChat DevTools or a physical-device run.

Ablation: removed the duplicated `disposing` latch, per-request id/abort aliases,
and overloaded response signature. All responses use the original request object.
Cancellation during hide still reports the original request id and capability;
disposal does not reenter a guest that is being destroyed.
