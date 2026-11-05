# Showcase with the shared UI library

The only Showcase consumer remains `demo/`, with its single guest project in
`demo/js/`. Its pages use the public `@pocket/ui` mobile components. Flutter
continues to handle rendering, input/IME, lifecycle, resources and capability
transport. No appearance or navigation policy was added to Dart.

## Source and retained behavior

The source-first review used the retained parent at
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding
`pocket_host/`:

| Retained source | Behavior retained in this adaptation |
| --- | --- |
| `mini_apps/pocketjs_uikit.js` | Component composition, focus, modal interaction and guest-owned state |
| `mini_apps/app_ui_showcase/main.js` | Interactive counter, modal, keyboard and component exploration scenarios |
| `mini_apps/app_nav/main.js` | Navigation and the independent lobby experience |
| `mini_apps/app_login/main.js` | Profile selection and identity passed between applications |
| `lib/render/pocket_ui_components.dart` | Native input/render boundary, without migrating business state into Flutter |

The existing `demo/js/state.ts`, `system.ts`, `capability-panels.tsx`, video
intent model, and recording transport remain the behavior sources. Component
routes, camera, sensors, permissions, package updates, recording/replay and
Profile → Lobby communication retain their existing capability contracts.
Unimplemented or unavailable host capabilities still render real errors.

## Product navigation and appearance

The four primary tabs are Home, UI, Host and Settings. The compatibility route
name `gallery` still identifies UI. Primary navigation resets the route stack;
secondary navigation pushes onto it. The root app renders the only fixed
`MobileAppBar`, with a centered title and an icon-only `MobileBackButton` on
secondary routes. Its two primitive strokes preserve the retained parent
`lib/render/pocket_ui_components.dart` AppBar arrow behavior without relying on
a font glyph. The 44×44 focusable target pops
to the actual caller, including a device experience opened from Settings.

`NavigationBar` accepts `visible`, custom `items`, `dark` and `accentColor`.
`visible={false}` removes the whole bar, including its bottom safe-area extent.
The SDK does not decide which consumer routes are secondary. `TabBar` and
`BottomNavigationBar` remain aliases of the same implementation. Existing
consumers retain the default three-item set. `MobileAppBar.centered` is optional;
secondary pages enable it with equal action slots so the title stays centered
while the back arrow remains a real focusable SDK button.

Settings is the only appearance-control surface. It owns light/dark theme,
blue/violet/teal/rose accents and automatic/comfortable/compact density through
the existing JS reducer. One root `MobileThemeProvider` supplies all Showcase
routes. `createMobileTheme` supplies numeric accent tokens through the official
style ABI. `toMobileColor` converts the public ARGB palette tokens to official
hex style colors (numeric style values use a different byte ordering), so
changing an accent reaches actual draw operations. Semantic error/success
colors stay semantic.

Preferences are versioned, validated and saved as `appearance` using the
existing app-scoped `platform.storage` API. JS awaits initial hydration before
showing appearance controls. Saves are serialized, and only the newest save
reports its status. A storage error leaves the current appearance usable and
reports that it applies to the current session. Reset requires confirmation
and changes only appearance preferences.

## Ablation

- Remove local page theme providers and local density state from Showcase.
- Remove per-page navigation bars in favor of the fixed root bar.
- Remove appearance controls and implementation badges from secondary bars.
- Replace old `ActionButton`, `Card`, `Badge`, `ViewText`, `MetricCard`, `List`
  and empty-state compositions in the main consumer with shared mobile UI.
- Remove copied card skins where the default library theme is sufficient.
- Replace non-interactive nested setting tiles with simple labels. Reset is one
  reducer action and one persisted preference value, instead of three saves.
- Derive bottom-bar visibility from the route; do not add a second nav state.
- Remove unused responsive panel calculations and the old Host tab strip.
- Reuse scoped storage, compiler, engine and native transport without adding
  another native state machine or a fallback runtime.

Profile and Lobby remain independent guests with their own existing providers;
Showcase preferences govern the resident Showcase routes.

## Validation

Validation uses the pinned buildGuest → QuickJS bytecode → native probe path,
plus Flutter integration tests on the actual renderer. Source checks alone are
not interaction acceptance. The relevant scenarios are native pointer counter
and IME, route Back/tab visibility, settings theme/accent/density, preference
save/restore/reset, video intent/lifecycle and the existing source-to-frame
ablation.

Verified on 2026-11-05:

- `bun run build:system`: rebuilt the resident guest and Profile/Lobby with the
  pinned compiler and bytecode engine.
- Guest reducer, mobile, hardware, capability and video page contracts: 20
  passing tests; Video native fixture and page suite: 4 passing tests.
- `bun tests/settings_native.test.ts`: real pointer changes to dark theme,
  Violet/Teal accent draw colors, touch/desktop button geometry, confirmed reset,
  secondary Back/tab visibility, and storage restore in a fresh native runtime.
- `bun tests/guest_ablation.ts --required`: changing compiled guest bytecode
  changes the actual native first frame.
- SDK/demo architecture boundary check and Dart analysis of the touched app
  and integration files passed; iOS display-name plist validates.
- Native route-lifetime regression passes pointer scroll restoration, local
  input/control state, overlay isolation, pop/reopen and late camera shutdown;
  see `SHOWCASE_ROUTING.md` for the lifetime policy.
- SDK motion, feedback, focus, accent, design-system and safe-area native
  fixtures pass (six test cases plus NavigationBar's existing geometry checks).
  Feedback bounds are checked at 320px and 390px with nested page/card padding.
- iPhone 18 Pro simulator integration passes the mobile/settings/navigation
  flow, including pending toggle completion, rejected-toggle rollback, manual
  increment and the dialog. Captures include
  `demo/artifacts/showcase/04-toggle-loading.png` and `04-toggle-rollback.png`.
- The same simulator's Gallery/Host/Hardware visual flow passes with captured
  real render frames. Sensor acceptance uses the real host result, including
  the simulator's visible error state; it does not synthesize sensor success.

The native probe supplies host capability responses through the existing
transport. It does not establish real camera, BLE, location or decoder behavior
on every device. Physical-device and store submission validation remain
separate from this UI/navigation rewrite.


## Motion and asynchronous controls

The retained `mini_apps/syslib/pocket_syslib_flutter_ui.js` documents the
SwitchListTile/control vocabulary. The existing SDK supplies the actual JS
switch/stepper composition; the retained source has no asynchronous midpoint
switch implementation. The new pending behavior stays in this public SDK.

`MobileSwitch` preserves its controlled `value` / `onChange` API and adds
`onBeforeChange(next): boolean | Promise<boolean>`, optional external `loading`,
`disabled` and `onError`. A pending guard locks repeated input and parks the
white thumb at the center with an animated indicator. A true result commits
through `onChange`; false or rejection returns to the existing controlled
value. An external value change wins over an older pending guard, and an
unmounted switch does not commit a late result. The Showcase's Async toggle
exposes Complete/Reject controls to resolve a real local Promise interactively.

`useAnimatedNumber` now tracks only its target. Its old effect also read the
current animation signal it wrote, which caused repeated reactive convergence
inside one update. The corrected hook advances through official scoped frame
callbacks; the switch uses a 280ms eased transition and manual stepper/progress
changes use 240ms. Times use the pinned simulation rate. Hidden routes suspend
motion and loading frames, and idle controls do not request continuous frames.

The onset regression records native thumb pixels from the release turn. The
former timed smoothstep produced offsets `0, 0, 1, 2, 3, 4, 6, 8`: frame hooks
ran before the press, followed by near-zero ease-in samples rounded to the same
pixel. Timed transitions now publish their first simulation-tick sample in the
target-change turn and ease out toward the endpoint. They reuse the same
animation clock, retain the configured duration, and ignore invalidations that
leave the numeric target unchanged. Native acceptance checks visible movement
in the input turn, reversal while moving, and input after a parked idle period.

Alert and Toast content and actions occupy separate rows so actions can wrap
within their card. Text wraps against the measured text-column width.
