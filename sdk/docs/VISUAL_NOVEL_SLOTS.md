# Pocket VN save slots

## Retained source and existing save contract

The retained parent demo outside `pocket_host/` does not contain a VN save or slot manager. Its `lib/render/pocket_ui_components.dart:1774` `<Gallery>` is a horizontal visual carousel with static labels; it does not read story progress or persistent save data. Pocket VN therefore builds on the current SDK engine save contract rather than migrating a parent implementation.

`NovelSaveData` remains the engine's v1 record. It contains the active instruction and stage, typed variables, call stack, backlog, rollback checkpoints, meta progress, audio intents, preferences, and counters. `NovelEngine.load()` remains the single validation and restore boundary; slot operations do not parse or rewrite engine state.

The Lantern adapter already stores records under `lantern.slot.auto`, `lantern.slot.1`, `lantern.slot.2`, and `lantern.slot.3`. It rebases locale-specific story text when a save is loaded or written. These keys and save values remain unchanged. Slot-to-slot operations work on raw values so copying or moving a save does not pass it through the locale rebase path.

## JS slot manager

`createNovelSlotManager(storage, { prefix })` in `packages/pocket_vn/src/slots.ts` is a thin JS manager over an existing app-scoped key-value store. The store provides `get`, `set`, `remove`, and `keys`; it may provide `batch` with the shared platform operation shape:

```ts
type NovelSlotStorageOperation =
  | { type: "set"; key: string; value: JsonValue }
  | { type: "remove"; key: string };
```

The manager maps each slot directly to `<prefix><slotId>`. `list()` filters the storage key list by that prefix and returns valid suffixes in lexical order. There is no separate catalog or index that can drift from the save records. `read()` returns the raw JSON value; `write()` replaces the slot; `delete()` is idempotent. All operations through one manager instance share a serial queue. The app should use the same manager instance for autosave and manual slot actions so its own writes cannot race a move or swap.

`copy(source, destination)` writes the source's raw record once to the destination. `move()` writes the destination and removes the source in one atomic batch. `swap()` writes the two records in one atomic batch. Copy and move refuse to overwrite an occupied destination unless the caller passes `{ overwrite: true }`. Move and swap require an atomic batch implementation; if the host does not provide one, the manager rejects before reading or writing. It never falls back to sequential writes that could lose a slot if the host closes midway through the operation. Both slots must exist for swap, and a source and destination must be different.

The storage API validates and snapshots JSON at the host boundary. The manager treats records as opaque and performs no `JSON.stringify`/parse round-trip, engine validation, locale transformation, or hidden backup staging. A stored JSON `null` remains distinguishable from a missing slot through `keys()` during copy/move/swap; the platform `get()` result alone uses `null` for both cases.

Slot IDs and the prefix follow Pocket storage's key restrictions: non-empty, not `.` or `..`, no slash, backslash, C0 control or DEL characters, well-formed UTF-16, and at most 256 UTF-8 bytes for the final key. The prefix must leave at least one UTF-8 byte available for a slot ID. The default flow passes the unchanged `lantern.slot.` prefix.

## Persistence and restore

Native `platform.storage` is an app-private JSON key-value store persisted by the Flutter System host under its application-support directory. Existing `get/set/remove/keys` operations use the same store; the generic storage batch operation supplies the atomic multi-key boundary needed for move and swap. Slot management adds no Dart slot state machine.

The current title screen has an explicit Resume action that loads `auto` through `NovelEngine.load()`. On app boot, Lantern validates the autosave and seeds meta progress for New Game, while keeping the player on the title screen; the full save location, stage, and variables are restored when the player selects Resume. `demo/integration_test/novel_storage_restart_test.dart` exercises this with the shipped QJBC and the actual application-support JSON file: story input increments Ren trust to 1, the test observes the persisted autosave, disposes the entire System host, mounts a new host without injecting state, and selects Resume. It saves again through the restored game's UI and compares variables, location and station stage in the native file. macOS, iOS 27.2 simulator and Android API 35 emulator all passed on 2026-11-07. This is host disposal/recreation in one test process, not a claim of process-kill or power-loss recovery.

`NovelView` keeps Resume tied to `auto`, which remains reserved for continuous autosaves. Its explicit Quick Save writes the separate `quick` ID, and Quick Load reads that same checkpoint. Manual save/load retains the legacy `1`, `2`, and `3` IDs and adds manager-listed IDs without adding an index or second catalog. Rows are paged four at a time and the player UI caps the displayed list at 512 IDs; additional raw IDs remain in storage and are not removed. Consumers that only implement the original `read` and `write` methods keep the legacy three manual slots and quick save/load, with management controls hidden.

When the existing manager methods are available, the Save and Load pages open a JS-owned management subpage. It uses the existing `@pocket/ui` `InputField` and the caller's existing `HostBridge` event subscription to enter an ID; this adds no native editor state or input protocol. A source slot can be copied, moved, swapped, or deleted through the manager methods. `auto` is excluded from destructive management and cannot be a destination. Replacing a manual save or occupied copy/move destination, deleting, and swapping require a visible confirmation. Copy/move/swap preserve manager semantics: the view never reads and rewrites records itself, and atomic moves/swaps still fail if the storage host does not provide `batch`.

Player summaries come from the consumer's existing `storage.read()` adapter, so Lantern continues to decode and rebase canonical V2 saves for the selected locale before the view displays the current dialogue. The slot manager's copy/move/swap path still operates on the raw stored JSON; the UI does not create a second decoded save catalog.

The player reuses `ScrollablePage` for the Save, Load, and slot-management body. Its existing implementation in `packages/pocket_ui/src/ui.tsx` (around lines 1652 and 2000) provides a clipped viewport with one translated content canvas and the established scroll gesture. The VN had passed `class="flex-1 w-full"`, which replaced the component's default `overflow-hidden`; the content could paint and receive taps beneath the fixed pagination row. On Lantern QJBC `732327B` / PAK `19440480B`, the native driver measured the delete label at `(237,536)` and the next-page label at `(258,556)`. Tapping the delete text center advanced to page 2 and issued another `platform.storage.keys`/read instead of opening confirmation. The focused fix restores the viewport contract with `min-h-[0] overflow-hidden` on only the Save/Load and slot-management scroll bodies. It keeps the existing scroller and fixed pager, with no second layout or scroll state. The acceptance driver now computes text tap points from the intersection with each draw op's clip so a partly clipped label cannot direct a test tap into the pager.

The restart runs used Lantern QJBC `e16b6c4594a0b6631278866b5a50a24f478540584eabe3c020128fec937c1efa`, PAK `e02a1bb382b7d76a7d5e704f08e710eaa76c4f1d8e3c34b7b6e4786af6f72a45`, and System guest QJBC `370ba29335668eb42b563634805778eee96ebf2015c59ace483406a4c6f75ac8`. Logs: `/tmp/pocket-f06-storage-restart-macos.log`, `/tmp/pocket-f06-storage-restart-ios.log`, `/tmp/pocket-f06-storage-restart-android.log`. `sdk/test/platform_data_test.dart` separately verifies closing/reopening the store and atomic batch failure behavior. Those restart tests prove the existing autosave restore path; they do not prove the later player slot-management UI.

Player slot management passed its rebuilt native Guest and macOS host acceptance
on 2026-11-07. The native test `demo/js/tests/novel_slot_controls_native.test.ts`
passed both the complete quick-save/load/manager flow and delayed-list overwrite
protection. After swapping, the delete control could be wholly clipped out of
the emitted frame; the driver now uses real pointer drags within the observed
manager clip to reveal it before tapping. It does not inject a scroll offset or
selection. Log: `/tmp/pocket-f06-scroll-slot-controls-native.log`.

The real host had also exposed missing `platform.storage.batch` target and
`system.storage.batch` System manifest declarations. Both are now declared
through the existing capability negotiation. With the rebuilt System,
`demo/integration_test/novel_slot_management_test.dart` passed on macOS using
painted controls and Flutter IME: custom IDs, overwrite confirmation, raw record
copy, atomic move and swap, delete, a dedicated quick checkpoint, whole-host
disposal/recreation, and loading that checkpoint. Read-only observations of the
actual app-support JSON file verified the operations; no storage state was
injected. Log: `/tmp/pocket-f06-current-slot-management-macos.log`. Lantern QJBC:
`cacde1f90d937d953dcea4d076c29290628d6c2c867f499c3944795a7e9ca601`;
System QJBC:
`57060c146a26f05130172f57de48b46edf6be8d6c308459d48cbfcacc914f019`.
This macOS run precedes image-skin integration. The final image-skinned manager
also passed on Android API 35 (`emulator-5554`), using Lantern QJBC
`ca609bad1a6c1a98a534dfb572a2a725e8ded3b5ec8118ca2c56be7970054a26`
and System QJBC
`9ab6952b2f79700308e00f15de31c3bdb78e999aeed9e0448a7aa9dd14a56813`.
It verified copy/move/swap/delete, the dedicated quick slot and fresh-host load
against the actual OS file through painted input and Flutter IME. Log:
`/tmp/pocket-image-skin-final-slots-android-ready.log` (1 test passed).

The first Android run failed to select a row after observing a disk commit;
that run did not capture the row's enabled state at the tap. A disk commit alone
is not the asynchronous guest list/busy completion barrier. The driver now
waits for the actual row's opaque enabled paint, a visible hit point and
the absence of the loading label before sending one pointer down/up. The final
run recorded a disabled row alpha of 102 becoming 255 and a stable visible tap
point; it does not retry taps, inject selection, or add a fixed delay to conceal
the issue. No production slot state or storage behavior changed for this driver
adaptation. The new manager controls still require iOS and Windows acceptance;
earlier autosave restart results do not cover them. NativeSession uses an
injected process-local map and is not OS-file persistence proof.

The store has a 65,536-byte limit per value and a 1,048,576-byte limit per app-private bucket. Slot operations preserve those limits: copy can fail if it exceeds the app bucket quota; move and swap keep one save value per slot and validate the complete post-operation bucket atomically. `NovelSaveData` remains the engine's v1 payload; optional thumbnail references and the bounded PocketView capture boundary are described in [thumbnail ownership](VISUAL_NOVEL_SLOT_THUMBNAILS.md).

## Real screenshot boundary increment (2026-11-08)

Current three-target save-preview and same-resource resize results are recorded in [slot thumbnail ownership and native evidence](VISUAL_NOVEL_SLOT_THUMBNAILS.md). The earlier [isolated capture evidence](VISUAL_NOVEL_SCENE_CAPTURE.md) remains historical.

## Validation

From `sdk/`:

```sh
bun test packages/pocket_vn/test/slots.test.ts
```

The slot tests cover legacy `auto/1/2/3` keys, prefix filtering without a catalog, opaque-copy preservation, overwrite rules, missing source handling, atomic move and swap operation batches, refusal when batch is unavailable, slot-key validation, null records, and serial ordering through one manager instance.

Validation evidence: the targeted command passed **7 tests, 0 failures, 37 assertions**. Strict source checking passed with:

```sh
node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --skipLibCheck packages/pocket_vn/src/types.ts packages/pocket_vn/src/slots.ts packages/pocket_vn/src/engine.ts packages/pocket_vn/src/input.ts packages/pocket_vn/src/variables.ts packages/pocket_vn/src/replay-schema.ts packages/pocket_vn/src/replay.ts packages/pocket_vn/src/authoring.ts packages/pocket_vn/src/interchange.ts packages/pocket_vn/src/localization.ts packages/pocket_vn/src/editor-runtime.ts packages/pocket_vn/src/index.ts
```

The full `bun test packages/pocket_vn/test` suite also passed **93 tests, 0 failures, 630 assertions**.

The pinned guest integration fixture is `demo/js/tests/novel_slots_native.test.ts` (run from the repository root with `sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test demo/js/tests/novel_slots_native.test.ts`). It builds a temporary guest with `buildGuest`, executes its QJBC through `NativeSession`, and exercises real `@pocket/ui/platform` requests plus `createNovelSlotManager`: raw nested save JSON copy/read, listing and delete, successful atomic swap/move, host rejection when batch is unavailable, and rejection of a malformed batch without changing the store. `NativeSession` uses a process-local injected map for this fixture; it proves guest and host-protocol behavior, not OS-disk persistence. The macOS/iOS/Android host-recreation run above and `sdk/test/platform_data_test.dart` provide the separate real-file persistence evidence. The fixture passed **1 test, 0 failures, 19 assertions** with the pinned Bun 1.4.4 runtime.
