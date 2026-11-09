# Pocket VN data collections

This SDK slice defines a shared, static collection catalog and pure lookup helpers for the Editor and Guest to consume. It does not add a second progress store, interpreter, save format, or project data file. Catalog definitions belong in the existing `novel.assets.json`; unlock progress belongs in the existing story variable projection and persistent metadata.

## SDK schema

`NovelCollections` is a map of stable collection IDs to a title and stable entry IDs. An entry contains a title and body, may refer to a registered character expression by key, and may name one story variable that gates visibility:

```json
{
  "people": {
    "title": "人物档案",
    "entries": {
      "mira": {
        "title": "Mira",
        "body": "Keeper of the harbor light.",
        "portrait": { "character": "mira", "expression": "neutral" },
        "unlockVariable": "codex.mira"
      }
    }
  }
}
```

Portraits contain asset registry keys, never disk paths. `resolveNovelCollectionPortrait` resolves that key through the same `characters` map used to render the story stage. The catalog validator rejects unrecognized fields and applies bounded IDs, text, and collection sizes before consumers render it.

`validateNovelCollections(value)` checks only the structural schema. Passing `story` additionally requires every gate to refer to a declared `persistent` variable with `defaultValue: false`; passing `characters` additionally requires every portrait key to exist. Consumers may pass either context independently. `isNovelCollectionEntryUnlocked(entry, snapshot.variables)` treats an entry without a gate as public and opens a gated entry only when the effective variable value is exactly `true`.

## Persistence contract

The story owns all mutable progress. Authors declare a boolean unlock variable in `StoryDefinition.variableDefinitions` with `lifetime: "persistent"` and `defaultValue: false`, then set it through an ordinary story `set` instruction at the authored unlock moment. The engine's existing `snapshot.variables` is the read projection; its canonical persistent value is `snapshot.meta.persistentVariables`. The existing save codec, new-game retention, rollback behavior, and legacy migration continue to own persistence as described in [variable lifetimes](VISUAL_NOVEL_VARIABLE_LIFETIMES.md). This collection module adds no fields to `NovelMetaState`.

The retained parent project has only a generic image carousel (`mini_apps/syslib/pocket_syslib_flutter_ui.js` and `lib/render/pocket_ui_components.dart`); it has no VN catalog, profile schema, or unlock persistence to migrate. Pocket VN's existing `NovelView` gallery is the closest reusable consumer pattern: it joins registered CG entries to monotonic `meta.cgIds`. The catalog design preserves that one-provider approach while using persistent variables for general dictionary/profile gates.

## Source and validation

- Shared SDK schema and lookups: `packages/pocket_vn/src/collections.ts`, exported from the package root and the `@pocket/vn/collections` subpath.
- Existing variable lifetime and persistence owner: `packages/pocket_vn/src/variables.ts`, `packages/pocket_vn/src/engine.ts`, and `packages/pocket_vn/src/types.ts`.
- Focused pure tests: `packages/pocket_vn/test/collections.test.ts`.

## Shared Editor and Guest integration

The canonical optional `collections` property now lives in `novel.assets.json`. The Editor asset panel supports collection/entry creation, deletion, text, registered portrait expressions, and declared unlock variables through its existing draft/history/save lifecycle. Asset and story writes validate cross-references before writing; removing an unlock declaration cannot silently invalidate the catalog. Legacy projects retain their existing shape without an empty collections property. `buildGuest` applies the same validator before compilation, including direct builds outside the Editor.

`NovelView` exposes the image-skinned Journey records panel from the title and journal. Locked entries expose their title and lock message; their body and portrait are not mounted. Opening the panel uses the existing game pause path. Pagination mounts at most eight list entries; only the selected detail mounts its registered portrait. Flattening the catalog is deferred until this panel opens. These bounds reduce avoidable UI work; they are not a measured whole-game performance improvement.

Collection titles and entry title/body source messages come from this same registry through `novelSourceUiMessages` and `novelCollectionTextKey`. Existing locale catalogs and the Editor translation fields provide overrides. Dotted IDs are escaped to avoid message-key collisions. Bodies display plain text; this feature does not implement runtime variable interpolation in collection prose.

Lantern v5 includes Mira/Ren character records and two evidence records. Three existing arrival branches set their corresponding persistent flags; the station record is public. The original registered artwork is reused. Four revision maps preserve v1–v4 saves; see [v5 migration evidence](LANTERN_V5_COLLECTIONS_MIGRATION.md).

## Validation checkpoint, 2026-11-08

- Full Pocket VN SDK suite: 175 tests and 1,439 assertions passed. The shared schema/lookups account for six tests and 24 assertions; targeted strict TypeScript checks also passed.
- Collection localization plus existing localization tests: 12 tests and 58 assertions passed, including fallback, translated prose, placeholder diagnostics, and dotted-ID collisions.
- Editor routes: 18 tests passed; the existing history browser flow passed in managed Chromium.
- Lantern story validation: 23 tests and 1,414 assertions passed. The isolated v5 Guest passed four actual legacy-save migrations, three-ending/input/save/rollback regression, save-codec regression, rollback metadata, replay isolation, and voice/locale interaction tests.
- Dedicated fixture native acceptance passed: real choice and text-input submit reach the authored persistent `set`; locked content stays unmounted; loading the user-created older quick slot, reconstructing a Guest from JSON host storage, and starting a new game preserve the unlock. Detail bounds passed at 360×800 and 800×600.
- Managed Chromium Editor acceptance passed: collection/entry add-delete, title/body/portrait/unlock edits, draft isolation, Save, reload, and undo/redo; the same saved project was compiled through pinned `buildGuest` and passed the native interaction route. The first browser attempt failed in test prompt synchronization; the corrected run passed and both logs remain archived. Browser/server cleanup occurs in `finally`.
- Actual Lantern v5 acceptance also passed: title records show the public station record while gated bodies remain absent; real Mira dialogue/choice/call-return reaches its persistent unlock; the journal then displays her body and registered portrait. This uses pointer input, not an engine jump or synthesized variable write.
- An independent read-only integration review found no blocking data, unlock, pagination, or text-layout defect. Extreme 8,192-entry/65,536-character runtime cost remains unmeasured.

The isolated v5 Guest is `sdk/.pocket-build/lantern-v5-collections-20261108/guest/`: QJBC `f40f9d690e6621f98ac69ce0d505fa8c6ae741cc984fec612361ef9342d3167a`, PAK `339305235efc0b42f98853f6f046a343929533fd30bbea83b738c6817eb8e47f`, metadata `e8bb83c2abc20f39450ce47f2028b05ee956c609d8dc4249ad445cc00f79f7d9`. `source-freeze.json` in the parent cache records source hashes. At the v5 checkpoint, the verified three-file Guest tuple was staged under `demo/assets/apps/lantern/`; it has since been replaced by the v6 tuple documented in [inventory and trading](VISUAL_NOVEL_INVENTORY.md). At that checkpoint, the previous v4 tuple is backed up in the cache's `original-staged/`, with hashes in `staged.json`. The ordinary running Flutter app has not been rebuilt with this Guest: the local build fails before runtime with an external-volume Git permission error. NativeSession uses actual pinned Core/bytecode execution with injected process-local storage; it does not establish Flutter disk persistence or foreground pixels.

## Remaining D01 scope

This implements dictionary/profile catalogs and their existing persistent-variable projection. Inventory quantities, product prices and buy/sell/consume transactions were subsequently added in Lantern v6; their shared story schema and runtime evidence are recorded in [inventory and trading](VISUAL_NOVEL_INVENTORY.md). Current Flutter-window/disk/platform acceptance is still pending. D01 and the overall engine goal remain incomplete. No additional catalog provider, mutable unlock table, native state machine, or duplicated portrait asset was introduced.

Acceptance artifacts are under `sdk/.pocket-build/lantern-v5-collections-20261108/acceptance/`: `native.log`, `native-result.json`, `browser-final.log`, `browser-result.json`, retained fixture Guest packages, and `editor-collections.png`. The screenshot was inspected and shows the saved collection fields; it is Editor evidence, not a Flutter game screenshot.

The final Lantern-specific check also passed using the ordinary artifact resolver with all `POCKET_LANTERN_GUEST_*` overrides unset (1 test, 0 failures, 1.35 seconds). It consumed the staged v5 tuple. Test: `demo/js/tests/novel_lantern_collections_native.test.ts`; log: `acceptance/pocket-lantern-v5-collections-native-staged-20261108.log` in the cache above. Log SHA-256: `8e8190bf466bfba347a6e328e9cbc9fafbd9a408d8e5f15dcc2d0f12564e1103`.
