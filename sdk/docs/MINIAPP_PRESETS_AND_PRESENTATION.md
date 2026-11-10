# MiniApp System Presets & Presentation Styles

## Source-First Provenance

Before implementing and verifying System UI preset propagation and dual MiniApp presentation styles (`"sheet"` vs `"page"`), the retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` (excluding `pocket_host/`) and existing SDK presentation docs (`sdk/docs/MINI_APP_PRESENTATION.md`) were inspected:

- `pocketjs_flutter_demo/lib/ui/mini_app_host_page.dart`: Synchronized host `ThemeMode` and `SystemUiOverlayStyle` across embedded views while keeping overlays outside child layout constraints.
- `pocketjs_flutter_demo/lib/render/pocket_ui_components.dart` (`PocketPageTransitionCompositor`) & `pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart`: Separated retained guest content from push (`translateX`) and modal (`translateY`) transition transforms and managed stack push/pop lifecycles.
- `pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_flutter_ui.js`, `mini_apps/app_login/app.json`, `mini_apps/app_game_detail/app.json`: Provided guest `Scaffold` / `AppBar` vocabulary and per-package JSON metadata.

### Retained Behavior & Thin-Host Adaptation

- **JS-owned policy and rendering**: No Dart state machine, Flutter `Navigator`, or native animation controller was added. Flutter remains strictly the surface/compositor and transport host.
- **Single timeline & dismissal barrier**: `SystemAppSurfaces` (`presentation="mini-app"`) retains its single virtual-clock timeline (`420ms` cubic entry, `360ms` quadratic exit) and `kernel.onBeforeDismiss` barrier for both `"sheet"` and `"page"` modes.
- **No duplicate child chrome**: Child MiniApps (`demo/js/apps/profile/app.tsx`, `demo/js/apps/lobby/app.tsx`) use `<MobileThemeProvider>` and `<SafeAreaScaffold reservedActions="mini-app">` without manual `<Button debugName="Back">` controls in `MobileAppBar.leading`, avoiding collisions with the host-rendered `mini-app-back` (`"page"`) or `mini-app-close` (`"sheet"`) affordance while keeping explicit in-body result-return actions (`"Return to Showcase"`, `"Return visits to caller"`).

---

## System Presets Synchronization

System UI presets share the canonical `PocketSystemPresets` contract (`sdk/packages/pocket_ui/src/host.ts`):

```ts
export interface PocketSystemPresets {
  darkMode: boolean;
  colorScheme: "light" | "dark";
  accentColor: string;
  density: "auto" | "touch" | "desktop";
  presentationStyle: "sheet" | "page";
}
```

### End-to-End Flow

1. **Kernel ownership (`sdk/packages/pocket_ui/src/system.ts`)**:
   - `installPocketSystem(manifest, { presets })` initializes global presets (using `manifest.applications.presentation.style` as the fallback `presentationStyle`, defaulting to `"sheet"`).
   - `kernel.setPresets(partial)` updates global presets (if not disposed), notifies `SystemAppSurfaces` subscribers when changed, and broadcasts per-app resolved `platform.presets` events to resident child runtimes when changed (or when `record.presetsPending` is set).
   - During `openApp`, `prewarmApp`, and `handleGenerationChange`, `emitPresets(target)` posts `platform.presets` **before** `onInit` / `onLoad` / `onWillAppear`. If the host returns `{ accepted: false }` (e.g., while a child runtime has not yet completed `firstFrameReady`), `record.presetsPending` is marked `true` and `lifecycle()` queues subsequent lifecycle events behind it; `flushLifecycle` / `flushForegroundWork` / `flushPendingLaunches` re-send `platform.presets` before flushing `lifecycleQueue` (`onInit`, `onLoad`, `onWillAppear`), `platform.launch`, and `onDidAppear`.
   - **True first-frame zero-delta delivery (`initialEvents`)**: `PocketSystemKernel` attaches `initialEvents: [{ method: "platform.presets", params }]` (resolved with the 4-tier `presentationStyle` priority, including `launchOptions.presentationStyle`) on `system.runtime.create` and `system.runtime.prepareOpen`. `PocketSystemHost` (`sdk/lib/src/pocket_system_host.dart`) validates and forwards the opaque `initialEvents` list through `PocketSession.initialEvents` (`sdk/lib/src/pocket_session.dart`) and `PocketGuestSession` (`sdk/lib/src/pocket_app.dart`) into the child `PocketView` (`sdk/packages/pocket_flutter/lib/src/pocket_view.dart`). During `_PocketViewState._start()`, `_sendInitialEvents()` dispatches those opaque events directly to the native runtime alongside `_reportSafeArea()` (`display.viewport`) and evaluates the zero-elapsed-time frame (`delta = 0`) **before** `onReady` (`_onFirstFrame`) admits the first frame—even when the child surface starts Offstage (`active: false`). The JS `presetsPending` retry remains as an idempotent fallback.
   - `platform.presets.get` / `platform.requestPresets()` was ablated; presets are delivered strictly via the single event-push (`platform.presets` + `platform.launch`) and `HostBridge.getLatestSystemPresets()` ingress snapshot contract (matching `display.viewport`).
2. **HostBridge ingress & guest reactivity (`sdk/packages/pocket_ui/src/host.ts`, `display.ts`, `platform.ts`, `mobile.tsx`, `sdk/packages/pocket_vn/src/view.tsx`)**:
   - `HostBridge` caches the latest merged `HostSystemPresetsSnapshot` at ingress (`getLatestSystemPresets()`) on both `platform.presets` and `platform.launch` events (via the shared `isSystemPresetsEvent` predicate)—mirroring `getLatestDisplayViewport()` without general event replay overhead.
   - `createSystemPresets()` (`useSystemPresets`) reads the ingress snapshot synchronously before mount without mutating `lastAppliedEvent` (so `onMount` still syncs `setPresets` and invokes `options.onChange`) and updates reactively on `platform.presets` / `platform.launch`.
   - `<MobileThemeProvider>` automatically subscribes to `createSystemPresets()` whenever explicit `theme` or `density` props are omitted, memoizing `createMobileTheme(presets.darkMode, presets.accentColor)` and providing `presets.density` to the entire child guest tree.
   - `NovelView` (`sdk/packages/pocket_vn/src/view.tsx`) subscribes to `createSystemPresets()` and applies `MINI_APP_HOST_ACTION_RESERVE` (`60px`) on the left in `"page"` mode (clearing `mini-app-back`) and on the right in `"sheet"` mode (clearing `mini-app-close`).

---

## 4-Tier Presentation Style Priority

For any child MiniApp instance, `PocketSystemKernel` resolves `presentationStyle` strictly in the following order:

1. **Per-launch override (`launchOptions.presentationStyle`)**: Passed to `platform.openApp(appId, args, { presentationStyle })` or `platform.launchApp(...)`. Stored on the runtime record for that open session and cleared if a subsequent open omits an override.
2. **Per-MiniApp manifest / catalog config (`pocket.json` / `pocket.system.json` catalog `presentation.style`)**: Declared under `app.presentation.style` (or top-level `presentation.style`) in the MiniApp's `pocket.json` or in `applications.catalog[i].presentation.style`.
3. **Global System UI presets (`kernel.presets().presentationStyle`)**: Initialized from `applications.presentation.style` / `InstallPocketSystemOptions.presets` and dynamically updated via `kernel.setPresets({ presentationStyle })`.
4. **Built-in fallback**: `"sheet"`.

Supported input spellings (`normalizePresentationStyle`):
- `"sheet"`, `"modal"`, `"bottom-sheet"` -> `"sheet"`
- `"page"`, `"push"` -> `"page"`

### Build-Time Validation (`sdk/scripts/build_system.ts`)

`validateSystemDocument` validates `applications.presentation.style`, `applications.catalog[i].presentation.style`, and child `pocket.json` `presentation.style` / `app.presentation.style` against `["sheet", "page", "modal", "bottom-sheet", "push"]` (trimming/lowercasing input, emitting `system.invalidPresentationStyle` on invalid values and `system.invalidPresentation` on unknown fields), strips the SDK extension fields before invoking the pinned upstream `PocketSystemV1` / `PocketManifestV2` schema validators, and preserves the normalized `presentation` metadata on both `ValidatedSystemContract.contract` and `ResolvedSystemPlanWithMemory`.

---

## Surface Transitions & AppBar Action Reservation

| Aspect | `"sheet"` (Bottom-Up) | `"page"` (Push) |
| :--- | :--- | :--- |
| **Surface transform (`MiniAppSurface`)** | `translateX: 0`, `translateY: (height - 1) * (1 - timeline)` | `translateX: (width - 1) * (1 - timeline)`, `translateY: 0` |
| **Host floating affordance** | Top-right `mini-app-close` (`44x44` hit target at `right: 8, top: 8`, occlusion-aware) | Top-left `mini-app-back` chevron (`44x44` hit target at `left: 8, top: 8`, occlusion-aware) |
| **Guest `SafeAreaScaffold(reservedActions="mini-app")`** | `reservedLeadingActions = 0`, `reservedActions = 60` | `reservedLeadingActions = 60`, `reservedActions = 0` |
| **Guest `MobileAppBar` padding** | `paddingR >= 60` (clears top-right close button); `paddingL = 16` | `paddingL >= 60` (clears top-left back button); `paddingR = 16` |
| **Guest `NovelView` (`headerBounds`)** | `right` reserves `60px` (`MINI_APP_HOST_ACTION_RESERVE`); `left` uses `20px` | `left` reserves `60px` (`MINI_APP_HOST_ACTION_RESERVE`); `right` uses `20px` |

When `presentationStyle` changes dynamically on a mounted `MobileAppBar`, `appliedLeftNonZero` / `appliedRightNonZero` track prior action reservations so inline `paddingL` / `paddingR` reset cleanly back to `16px`. `MiniAppSurface` latches `presentationStyle` while `phase() === "entering" || phase() === "closing"` so mid-flight animations never swap axes, and aligns `closeStyle` / `backStyle` with `SafeAreaScaffoldBody` on local side occlusions (`hasLocalLeftOcclusionInset` / `hasLocalRightOcclusionInset`).

### Showcase Interactive Controls (`demo/js/`)

- `demo/js/apps/profile/pocket.json` sets `"presentation": { "style": "page" }`, merged into the Showcase catalog by `buildShowcaseSystemConfiguration()` (`demo/js/system.ts`). `demo/js/apps/lobby/pocket.json` and `demo/js/apps/lantern/pocket.json` omit per-app overrides and inherit the global setting.
- `DemoState.miniAppPresentationStyle` (`demo/js/state.ts`) persists alongside appearance preferences (`demo/js/settings.tsx`) and syncs live into `system.setPresets({ darkMode, accentColor, density, presentationStyle })` (`demo/js/app.tsx`).
- Both `PlatformAppsCard` (Home) and `SettingsPage` expose interactive controls to toggle the **Global default presentation** (`Sheet (Bottom-Up)` vs `Page (Push)`), select a **Launch override** (`Default` / `Force Sheet` / `Force Page`), or tap per-MiniApp quick-launch buttons (`Profile · Sheet`, `Profile · Page`, `Lobby · Sheet`, `Lobby · Page`, `VN · Sheet`, `VN · Page`).

---

## Validation

- **`sdk/packages/pocket_ui/test/miniapp_presets_presentation.test.ts`**:
  - Preset normalization, alias parsing, ARGB accent normalization, `isSystemPresetsEvent`, and `HostBridge` ingress caching.
  - Isolated pinned-Solid runtime verification of `PocketSystemKernel` (`setPresets`, realistic `{ accepted: false }` pre-first-frame `platform.presets` pending retry via `flushLifecycle`, `platform.launch`, `prewarmApp`, `handleGenerationChange`, disposed kernel/client guards, pre-mount `createSystemPresets({ onChange })`) -> `createSystemPresets()` + `createPocketPlatformClient` and full 4-tier priority resolution.
  - `validateSystemDocument` and `resolveSystemDocument` contract/plan preservation, case/whitespace normalization, and invalid style / unknown field rejection.
  - Real `buildGuest` + `pocket_probe` QuickJS bytecode execution verifying `"sheet"` (`translateY` + top-right `mini-app-close` hitbox + trailing 60px `MobileAppBar` reserve) vs `"page"` (`ready: false` 1px admission at `x = width - 1`, `translateX` entry & left-to-right `onBeforeDismiss` exit, top-left `mini-app-back` hitbox, leading 60px `MobileAppBar` reserve, `"page" -> "sheet"` reserve reset back to `16px`, mid-side occlusion alignment, `NovelView` left reserve in `"page"` mode, and live dark theme canvas flip).
- **`sdk/packages/pocket_flutter/test/pocket_view_first_frame_test.dart` & `sdk/test/pocket_system_host_test.dart`**:
  - Widget tests proving `PocketView(initialEvents: ...)` dispatches `platform.presets` at `delta = 0` before `onReady` admits the first frame (including when `active: false` during Offstage startup) and that `PocketSystemHost` forwards `initialEvents` from `system.runtime.create` and `system.runtime.prepareOpen` into the child `PocketView`.
- **Current Profile and staged Lobby package probes**:
  - The current local Profile QJBC (`demo/assets/apps/profile/app.qjbc` + `app.pak`) was run in pinned `pocket_probe` at 390×844. With `platform.presets=page`, title and subtitle start at x=60 and the Guest A badge at x=318; tapping Lin at (195,456) updates the selection and status. Switching to sheet returns title x=16/badge x=274; switching back to page restores x=60/x=318.
  - Lobby's exact staged phone package `0.1.0-test.8-8-f3a6f56b76cc070e5d1759e6ecc18774c28d09fd442074bda7b0949c9d5b817d` was copied read-only from its cached `entry.js` and `package.pak` and executed by the same pinned native probe. Page frames place title/subtitle at x=60; a `platform.launch` sheet fact moves them to x=16; a page preset moves them back to x=60. Tapping “Increment lobby counter” at (195,416) changed its rendered count from 0 to 1.
  - The host action itself is in the integrated `miniapp_presets_presentation.test.ts` fixture: the page-mode top-left `mini-app-back` tap requests the existing kernel dismissal and its `onBeforeDismiss` exit protocol completes. Safe-area/occlusion avoidance and page-to-sheet reserve reset pass there as well; this host-fixture result is distinct from the direct child-package frame probes above.
  - Phone cache evidence recorded Profile `test.2` and Lobby `test.2` as active before reopen, with Profile `test.7` and Lobby `test.8` already staged. After reopen, the active markers show Profile `0.1.0-test.7-7-e7248cd0f08833d075f72d2515d9f86a988c6bd2f59672a57cce54e3d0b1c1f4` and Lobby `0.1.0-test.8-8-f3a6f56b76cc070e5d1759e6ecc18774c28d09fd442074bda7b0949c9d5b817d`; the user visually confirmed both now align with the page back action. This is the user's on-device visual confirmation, separate from native-probe output. The stale active package explained the earlier phone report, so no second navigation or reserve layer was added.
- **`sdk/packages/pocket_ui/test/glass_surface.test.ts`**: Updated isolated `src/` fixture with `host.ts`, `display.ts`, and `reservedLeadingActions: 0` stub; passes against pinned Solid runtime.
- **Showcase & Architecture checks**:
  - `demo/js/tests/system_capabilities.test.ts`, `official_demo_catalog.test.ts`, `guest_state.test.ts`, `guest_ablation.ts`, `native_guest_probe.ts`, `settings_native.test.ts`, `navigation_native.test.ts`, `mini_app_loading_native.test.ts`, `system_surface_compiler.test.ts`, `python3 sdk/scripts/check_architecture.py`, and rebuilt Demo bundles (`demo/assets/app.qjbc` + `demo/assets/apps/{profile,lobby,lantern}/app.qjbc`).
