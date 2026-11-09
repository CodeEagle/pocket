# Visual novel input: source reuse and acceptance

## Story integration

`《雾港末班信》` adds an optional return-label passage from the existing investigation hub. The option appears after any one of the three clues has been recorded, so the opening, first hub menu, clue routes, 714 puzzle and three endings retain their existing paths. The first opening dialogue remains `start[17]` (`arrival_01`).

The passage asks for a recipient name (1–16 Unicode code points), a return mailbox number (integer from 0 to 999), and permission to publish the player's name in the station history. A successful submission writes only that field to the engine's typed variable map. Text and number drafts stay strings until submit; invalid submissions remain at that field with a structured error. Cancel returns to the investigation hub without committing the current draft. Values committed in earlier fields remain committed. Boolean consent defaults to No and requires the player to select and submit it.

The script is authored in [story.json](../../demo/js/apps/lantern/story.json). Stable line/input IDs, the conditional hub option and all three variable commits live in that source document. English prompt and placeholder translations, the new lines and option, and the input UI strings live in [novel.locales.json](../../demo/js/apps/lantern/novel.locales.json). The game still has one state owner: `NovelEngine`; the Flutter integration test contains no story state or input policy.

## Source-first reuse

The retained parent Demo was inspected before adding the branch. The old `View.Keyboard` implementation in `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart:3507-3682` uses Flutter `TextEditingController` and `FocusNode`, a real Flutter `TextField`, and writes edits back to the parent node. Its showcase entry in `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_pages.js:724-768` demonstrates the system keyboard. Its retained runner sync at `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart:1001-1020` keeps the guest value authoritative. These sources confirm the text editor and state ownership principle; their VDOM node and `typedText` channel are not copied into the current DrawList guest.

The current host contract and regression sequence are inherited from `sdk/docs/INPUT_REUSE.md`, which records the retained PocketJSKit references: `PocketJSKit/packages/pocket_flutter/lib/src/pocket_view.dart:935-1128`, `PocketJSKit/test/pocket_view_test.dart:1318-1487`, `PocketJSKit/integration_test/pocket_poc_test.dart:630-725` and `PocketJSKit/apps/solid-tests/app.tsx:523-588`. The reused behavior is a measured guest input rectangle overlaid with Flutter `TextField`, event-based editing, selection/composing round trips, and submit/close handling. The host still owns the real editor; story state and validation remain in JS.

The necessary adaptation is specific to this product: `NovelView` maps the engine's active text/number input to the existing `@pocket/ui` `InputField`, maps Boolean input to JS-owned Yes/No controls, and routes the existing `HostBridge.onEvent` stream to that same InputField session. Lantern passes its already-created host bridge into `NovelView`; no second bridge, Dart story reducer, independent draft buffer, or synthetic success state is added. The same engine handles the story's rollback, save and load.

## Validation

The source-level story test runs against the real `createNovelEngine` and the authored JSON, without private-state injection. It checks serializable route targets, the preserved opening index, entry after a clue, CJK/emoji text submission, invalid and exponent-form numbers, Boolean consent, cancellation, and that auto/skip/pause time cannot cross an active input. The locale test checks full line/choice/input coverage and runs all three existing endings in Chinese and English.

```sh
cd demo/js
bun test apps/lantern/story.test.ts apps/lantern/localization.test.ts
```

Result: **10 tests passed, 0 failed** (478 assertions).

The compiled-guest acceptance is [novel_input_native.test.ts](../../demo/js/tests/novel_input_native.test.ts). It launches the Lantern QJBC with `NativeSession`, reaches the optional passage through rendered pointer targets, taps the actual `InputField`, captures that `textInput.open` event's `id`, `editingSession`, `revision` and `jsRevision`, then sends `textInput.edit` and `textInput.submit` with those facts. It checks that native Done closes the editor without silently submitting the story field; the player's JS Submit button owns story confirmation. It also checks invalid numeric validation, cancel/no-commit, visible/interpolated CJK+emoji, input-draft manual save/load, rollback from a draft, and explicit Boolean confirmation.

Run after rebuilding Lantern bytecode and assets with the pinned `buildGuest` pipeline:

```sh
cd demo/js
bun test tests/novel_input_native.test.ts
```

The Flutter end-to-end case is [novel_input_test.dart](../../demo/integration_test/novel_input_test.dart). It runs the real bundled guest through `PocketView`, registers `tester.testTextInput`, activates the Flutter text client by tapping the drawn field, edits `林岚🙂`, sends a composing range covering the emoji's UTF-16 surrogate pair, and submits via `TextInputAction.done` before pressing the JS story Submit control. It also rejects `1000` in the number field and accepts `1e2` as `100`.

```sh
cd demo
flutter test integration_test/novel_input_test.dart -d <simulator-or-device>
```

This integration test exercises Flutter's `TextInputClient` and the real PocketView/guest event path. It does **not** exercise a physical key, an operating-system candidate window, hardware keyboard behavior, or a real Chinese IME. Those require a separate device run and are not reported as passed here.

## Observed compiled-guest results

The accepted input build uses the pinned compiler and engine ABI
`quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021`.
Its QJBC SHA-256 is
`400a8060c2d76cb8862f2629dd20595b978972b22489647af0ab72c1323f499e`;
PAK SHA-256 is
`32a680915ee4dc932450354352299173fa40a970ed5f5f2daddb047f7f4a53b3`.
The prepared font subset includes 733 characters from the same pinned Noto
source. These hashes identify this input acceptance build, independent of later
feature work in the source tree.

| Target | Observed result |
| --- | --- |
| Native QuickJS probe | New input acceptance passes (`/tmp/pocket-input-native.log`); the four existing story, viewport, keyboard and voice/locale native tests also pass against this artifact. |
| macOS arm64 Flutter | Real Showcase SystemHost, guest pointers, Flutter TextInputClient, CJK/emoji composing, Done without implicit story submission, invalid numeric stay, corrected typed number and Boolean confirmation pass (`/tmp/pocket-input-flutter-macos.log`, 19 seconds). |
| iOS arm64 simulator | iPhone 18 Pro / iOS 27.2 passes the same real Flutter TextInputClient and guest test (`/tmp/pocket-input-flutter-ios.log`, 20 seconds after build). |
| Android arm64 emulator | API 35 emulator passes the same input test (`/tmp/pocket-input-flutter-android.log`, 23 seconds after APK installation). |
| Windows and physical phones | Not run for this input feature; no result inferred from the other targets. |

The final input-focused core/editor regression passes 74 tests with 439 Bun
assertions (`/tmp/pocket-input-unit-final.log`). The six-file browser editor run
passes 7 tests (`/tmp/pocket-input-editor-all-browser.log`). A strengthened
focused browser→saved Guest run rejects an over-cap paste, closes the old
session, restores the engine draft, rejects stale native edits and submits a
valid number (`/tmp/pocket-input-editor-cap-browser.log`).

The first native game run exposed an unnecessary input-only FocusScope that
blocked the journal. Removing it makes the draft save/load/rollback test pass.
The Flutter test also avoids assuming that a typewriter caption stays unchanged
between reading it and sending a pointer: it uses one observed dialogue target
per action and rechecks the actual next blocking UI. No application policy or
additional state machine was added to Dart to accommodate the test.
