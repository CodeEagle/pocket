# Whole-project WeChat browser verification

The Editor's **Run WeChat** launches the selected local project as one complete App. A System project starts its SystemUI (Home / Gallery / Host in Showcase); opening mini apps creates the catalog Guests inside that running App. There is no Profile/Lobby target picker.

The existing Pocket Canvas preview remains available. The WeChat target runs the project's actual pinned QuickJS bytecode in WebAssembly inside `@open-wxa/wxa-runner-core` **0.12.3**, using base library 3.7.0.

## Usage

Refresh the Editor, press **Run WeChat**, then **Open** when ready. **Stop WeChat** terminates only this Editor-owned runner/build process. Source changes require stop/start to rebuild. Loading the Editor does not automatically launch the compiler. During a build, project/SDK write requests are rejected to avoid mixed source snapshots; the running preview serves its isolated generated copy.

```sh
cd sdk
bun run preview:wechat --project-root=/absolute/path/to/project --outdir=/tmp/new-pocket-wechat-preview
```

To run an already built package without recompiling:

```sh
bun sdk/scripts/preview_wechat.ts --miniprogram-root=/absolute/path/to/wechat-build --outdir=/tmp/new-pocket-wechat-preview
```

The command prints `POCKET_WECHAT_PREVIEW_URL=http://127.0.0.1:<port>`. The local server uses an ephemeral port by default. Ctrl-C closes it. These pages execute trusted local project code.

## Reuse, provenance and ablation

Sources inspected:

- Retained parent `pocketjs_flutter_demo/wechat_host/`: the older WXML/setData facade does not execute the current Pocket engine, so it is not used as a substitute runtime.
- `sdk/scripts/build_wechat.ts`, `sdk/targets/wechat/src/wechat_guest.rs` and existing WeChat host: retain pinned engine/compiler, admitted QJBC envelopes, native PAK/glyph resources, input, lifecycle and demand scheduler.
- `sdk/editor/preview.ts`: retain its official `system.runtime.*`, `system.request` and `system.storage.*` transport semantics. System policy continues to execute in `sdk/packages/pocket_ui/src/system.ts`; the new host does not implement a second app stack or LRU.
- Pinned engine `programs/web/wasm/src/lib.rs`: reuse `web_compositor_frames`, `web_upload_surface` and `web_capture(..., mode=3)`. The existing Rust compositor preserves native paint order, clipping and SystemUI overlays. Child pixels are captured from actual independent WASM/QuickJS runtimes; unchanged child rasters are not uploaded every animation frame.
- Upstream <https://github.com/open-wxa/wxa-runner>, inspected revision `82b6b734da88f466a85e988a30edb63b2c354864`, package 0.12.3: reuse its official WeChat base-library browser environment and `DevServer`.

The canonical builder validates the project catalog and builds SystemUI plus installed catalog Guests with the same `buildGuest` pipeline. One WASM module embeds all admitted bytecode/PAKs. Each runtime selects its app index, keeps a separate QuickJS realm and shares the immutable module bytes. Only SystemUI receives the trusted compositor registry; child requests cannot invoke System runtime controls.

`wechat-system.js` carries runtime creation/destruction, first native raster admission, host responses and storage IO. It forwards platform app/message/storage requests into the real JS SystemUI kernel. Native hit testing decides whether input belongs to a child surface or to an overlaid root control; pointer capture preserves the target until release. Background runtime state remains resident until the JS kernel chooses to destroy it.

WeChat window safe-area/capsule geometry is delivered through the existing `display.viewport` event. Native hardware capability requests remain explicit unsupported/unconfigured errors unless a real host handler is registered.

The previous split-Guest target picker, catalog-selection state and separate per-Guest runner entry have been removed. Single-Guest projects still run through the same whole-project command.

## Browser-only adaptation and boundaries

The runner does not implement `WXWebAssembly`; its service realm also hides `WebAssembly`. `preview_wechat.ts` creates a separate browser staging copy, validates compressed/raw engine hashes against `build-info.json`, decompresses that same engine and prepends a narrow `wx.WXWebAssembly.instantiate` adapter using the same-origin browser parent realm. The consumer's `App` definition and original canonical mini-program package are preserved. No source-eval fallback, second renderer or placeholder UI is introduced.

- The canonical package still enforces the WeChat 2 MiB limit. A project that exceeds it fails explicitly.
- Worker/HTTP offload declarations remain unsupported by this target and fail admission. They are not silently removed to make builds pass.
- Native permissions, Bluetooth, video/platform surfaces and real device update behavior require native/device validation. Upstream emulated/unknown API responses are not evidence of native capability success.
- Desktop mouse input is the verified browser path. Upstream 0.12.3's touchscreen/compatibility-mouse bridge can dispatch duplicate taps in emulated touchscreen mode; touchscreen parity is not claimed.
- The runner wrapper is MIT; the bundled WeChat base library retains Tencent's separate copyright. Consult upstream licensing before redistribution.

## Verification

Boundary regressions cover single-project discovery, child control denial, catalog escapes, request abort/response correlation, simultaneous child retention, lifecycle teardown and editor CSRF/owned-process cleanup. The complete browser probe drives the actual rendered Canvas rather than injecting app-open requests:

```sh
bun sdk/scripts/tests/wechat_system_preview_probe.ts /absolute/path/to/system-wechat-build
```

Executed results are recorded after the full build and interaction acceptance below.

### 2026-11-04 whole-project acceptance

- A clean canonical output at `/tmp/pocket-wxa-whole-app-final-20261104-141124` built SystemUI, Profile and Lobby together. The engine was 3,976,810 bytes raw / 956,744 bytes Brotli, within the enforced canonical package limit.
- Playwright Chromium drove the actual Canvas: Home → Profile → select Lin → Save/open Lobby. Lobby rendered `Lin Mei / USR-LIN-1007`; Profile remained a live independent runtime beneath it.
- One close click produced continuously advancing native compositor positions (Y=0, 1.62, 12.97, 69.53, 269.81, 526.20, 735.34, 810.998), then destroyed only Lobby and restored Profile. Closing Profile returned to Home with zero child runtimes and zero pending requests. No additional input was supplied during either close animation; browser page errors were empty.
- Interaction acceptance exposed and fixed two transport gaps: scheduled frames must retain active contacts until a real release, and transparent compositor surfaces need bounds-based native hit testing. Focused-child IME messages now follow the same child ownership route.
- The focused host/System/editor/staging suite passed 20 tests (0 failures, 112 assertions); the separate build admission suite passed all 4 cases. `check_architecture.py` passed. Browser preview and Editor entry points bundled successfully, and scoped whitespace checks passed.
- Editor acceptance used the actual 8792 UI controls: no target picker was present; clicking Run WeChat built the whole local project, reached Running, and Open loaded SystemUI `pocket.host.demo` with all three catalog apps, a live WASM runtime, empty host error and no browser page errors. The Editor-owned preview was left running for local inspection.
- The durable `wechat_system_preview_probe.ts` then passed against that canonical artifact: `pass=true`, `completeApp=true`, `realWasm=true`, `browserErrors=0`; initial/final child counts were 0 and nested children were Profile + Lobby. Home/Gallery/Host and the Lobby counter produced different native framebuffer hashes. Each close used exactly one click and required multiple distinct positions of that same surface, including its unfocused exit phase.

### Screen density and host metadata remediation

Source reuse: `pocketjs_flutter_demo/wechat_host/pages/index/index.js` and its retained host were inspected for the window/Canvas boundary; `sdk/lib/src/pocket_session.dart` and the current package service define the Guest metadata contract. The existing pinned `programs/web/wasm/src/lib.rs` upload validator and `engine/present/src/compositor.rs` density-aware compositor remain authoritative.

The native WeChat Canvas dimension limit had incorrectly restricted the browser staging surface too: a 375×812 viewport admitted only density 1. Browser staging now explicitly selects its browser Canvas budget while the canonical native package retains its original limit. Child runtimes inherit root density; their actual captured pixels carry logical dimensions and density into the retained compositor. The new WeChat upload export reuses the pinned upload validation instead of adding a renderer.

The builder now packages each Guest's actual bytecode/package metadata. Shared, stateless read-only builtins serve `runtime.info`, `plugins.packageInfo`, `plugins.list`, `updates.status` and the explicit unsupported frame-timing status in both single-Guest and System projects. Guest identity and WeChat container account identity remain separate. Manifest declaration checks, request quota, cancellation and teardown still apply. No permission callback is needed to read admitted local metadata.

Demo reads the active provider instead of assuming Flutter. It renders unavailable timing/recording explicitly, and does not offer update operations when the host reports `configured:false`. It does not synthesize Flutter frame samples, native plugins or an update service.

Final acceptance for this remediation:

- The pinned compiler now receives the bounded `--density` option through `buildGuest`; ordinary SDK builds retain default 1, and WeChat builds default to 3. This fixes the remaining 1x baked glyph atlas, rather than merely enlarging the Canvas. `pocket.config.js` / `build-info.json` record the resource density.
- Editor Run WeChat rebuilt the complete local project with `rasterDensity=3`. Actual compiler output reported glyph coverage `@3x`. The canonical engine was 11,464,697 bytes raw / 1,180,580 bytes Brotli and passed the unchanged 2 MiB package admission.
- The actual browser host reported window pixelRatio 3, render scale 3, resource density 3 and Canvas backing store 1125×2436 for logical 375×812. Both independent child runtimes retained that scale, using the density-aware compositor upload.
- The durable complete-App probe returned `pass=true`, `realWasm=true`, `browserErrors=0`. Actual declared host requests returned Runtime ABI, version `0.1.0`, build `1`, entryBytes `425174`, Guest package identity, separate WeChat container metadata and disabled update status. Home/Gallery/Host navigation, Profile→Lobby, child input and single-click reverse close were rechecked against the new 3x build.
- Focused host/System/Editor tests: 23 passed, 0 failed, 128 assertions. Density compiler/CLI tests: 2 passed, 0 failed (15 unrelated cases filtered). Demo state/mobile scripts and architecture check exited 0. The browser probe bundles successfully. A later Git whitespace command was blocked by `.git/config: Operation not permitted`; a direct scoped source trailing-whitespace scan passed. No Git permission or repository state was changed to bypass that restriction.
- User inspection instance: `http://127.0.0.1:56074`, owned by Editor 8792. Device/native WeChat retains its existing Canvas dimension admission; the larger browser surface budget is only enabled in the separate browser staging copy.

### Automatic browser density and bottom navigation icons

The navigation bar's `⌂`, `▦`, `☷` depended on fallback glyphs that the baked text font does not contain. The SDK navigation bar now composes Home/grid/menu marks from existing View geometry, preserving the same tab hit targets, equal-width layout and active colours. No consumer-specific asset copies, extra font, dynamic SVG service or duplicate renderer were added. The retained parent Material navigation behaviour and the SDK's existing primitive paint path were the reference.

Browser staging now exposes the actual parent browser `devicePixelRatio`, distinct from WXA's emulated phone ratio. Startup selects an integer sampling density by ceiling that value, capped by the engine's supported 4 and the existing Canvas admission budget. Static resources are compiled at the supported ceiling (4 by default), not at a forced runtime scale; all screens reuse the same resources. An already-live Guest retains its boot density to preserve its JS state; after moving to another screen or changing browser/system scaling, reload the preview to apply the new density. Native WeChat retains its own Canvas admission limit.

Actual Playwright Chromium matrix on the final Editor-owned preview:

| Browser DPR | Render scale | Canvas backing store | Resource density |
| --- | --- | --- | --- |
| 1 | 1 | 375×812 | 4 |
| 1.25 | 2 | 750×1624 | 4 |
| 2 | 2 | 750×1624 | 4 |
| 3 | 3 | 1125×2436 | 4 |
| 4 | 4 | 1500×3248 | 4 |

Every case booted the real WASM Guest without host/page errors. Canvas screenshots of Home and Gallery confirmed all three actual icon shapes and their changed active colours. The 4x-resource canonical engine is 17,838,487 bytes raw / 1,288,269 bytes Brotli, passing the unchanged package-size admission. Focused tests passed 23/23 (134 assertions); Demo state/mobile scripts and architecture checks exited 0. Navigation icon verification used actual compiled Canvas output instead of source-string assertions. Current preview: `http://127.0.0.1:59170`.

### Isolated commit snapshot verification

Shared files were staged by owned changes only, excluding parallel video, native host, scroll/safe-area and other Editor work. The exact staged snapshot was materialized in `/tmp/pocket-wechat-commit-verify`; it passed 23 focused tests (132 assertions), 2 density tests (7 assertions), and all 10 existing Editor server tests (154 assertions, including a real pinned Guest compiler build). Architecture validation, Editor JavaScript syntax and Demo/UI TSX builds passed. A separate Playwright Chromium session created and selected a project through this snapshot's actual Editor server: Run WeChat became enabled, state was Idle, and page errors were empty. The earlier DPR and full-App WASM runs above used the live integration workspace; they are separate from this snapshot check.
