# Pocket Studio LAN access

## Source review and retained behavior

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` has no Editor or Studio implementation outside its excluded `pocket_host/` directory, so no code from that archive was reused. Its root `POCKET_SDK_AUDIT_REPORT.md` records the prior local Editor's missing-Origin CSRF risk; this integration preserves the current SDK's request protections instead of reopening that boundary.

The implementation reuses the current Studio service and UI paths:

- `sdk/scripts/editor_service.mjs` keeps the managed port at `8791` and its health/control checks on `127.0.0.1`, while starting the HTTP listener on `0.0.0.0`. It reports the LAN address selected by `chooseUpdateHost()`.
- `sdk/editor/server.ts` continues to serve the Editor, resource APIs, preview document and preview SSE through one listener. Host validation accepts loopback plus addresses on the current machine's network interfaces. Mutations retain the existing CSRF/editor credential and Fetch Metadata checks; supplied Origin and Referer must match the request Host origin.
- The Editor checks the actual socket peer through `Bun.Server.requestIP()` before routing. Only loopback, RFC1918 IPv4, IPv4 link-local, IPv6 unique-local and IPv6 link-local peers are accepted. IPv4-mapped IPv6 uses the same IPv4 check. Public peers and unknown peers are rejected; Host and forwarded headers cannot override this check.
- `sdk/editor/client/editor.js` builds API and resource requests from same-origin paths. `sdk/editor/client/preview.js` opens its `EventSource` at the same-origin `/api/projects/:id/preview/stream` path, so these transports keep using the address that opened the Editor.
- Published package reads continue through `readPublishedResponse()`, including per-request rebasing of aggregate `host.json` URLs. When the selected local update address and port are covered by the wildcard Editor listener, the version backend advertises that LAN origin and reuses the Editor's published-read routes. A different update port still uses the existing read-only endpoint from `sdk/editor/update_endpoint.ts`.

This keeps the existing Editor UI, preview transport, CSRF token flow, published package format and dedicated read-only endpoint. The only listener change is the managed service bind address; no extra host configuration or duplicate update server is introduced for port `8791`.

## Validation

- `POCKET_SOURCE_BUILD=1 node_modules/.bin/bun test editor/test/editor_server.test.ts editor/test/update_endpoint.test.ts scripts/tests/editor_service.test.ts` (from `sdk/`) — 26 passed, 0 failed: 11 Editor cases, 12 service cases and 3 update/peer-address cases. This covers signed publish through the wildcard listener, LAN pages/resources/preview, valid CSRF writes, forged Host and cross-Origin rejection, private/public peer boundaries, and the independent read-only update endpoint. Log: `sdk/.pocket-build/editor-lan-final-tests.log`.
- Managed-service LAN acceptance at `http://192.168.50.230:8791/` — `lsof` confirmed `*:8791`; the Editor and preview opened on the LAN origin, preview SSE returned `200` and delivered a nonempty frame with `92` ops, resource access and a CSRF-protected write succeeded, and the versions API advertised the LAN origin without an error. Forged Host and cross-Origin requests returned `403`. Log: `sdk/.pocket-build/editor-lan-acceptance.log`.

Start or restart the managed service with:

```sh
cd /Volumes/ORICO/Development/Github/pocket/sdk
npm run editor:restart
```

Open the LAN URL printed by the command; `npm run editor:status` prints it again.
