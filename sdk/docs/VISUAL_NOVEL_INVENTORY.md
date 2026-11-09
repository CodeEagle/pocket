# Pocket VN inventory and trading

The canonical `story.json` can now declare an optional `inventory` catalog. Currency and item quantities are declared save-lifetime variables; the catalog contains only authored names, descriptions, prices, variable references and optional carrying limits. The existing story transaction, variable projection, save codec and dialogue checkpoints own every mutation. There is no inventory store, provider, save extension or Dart state machine.

## Source-first decision and retained behavior

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding `pocket_host/`, has no VN inventory, currency or shop implementation. `mini_apps/app_game_detail/main.js:12–30` contains temporary hero/boss state and a shared high score; `mini_apps/app_ui_showcase.js:43` is a component gallery. These do not supply a transaction or save lifecycle to migrate. The implementation adapts the current SDK's `engine.ts` copy-on-write transactions, `variables.ts` save lifetimes, existing `choice`/`call`/`return` routing, and `NovelView` image-skinned controls and scroll pages. Editor changes reuse the existing story document, instruction editor, history mutations and save/reopen paths.

## Authoring contract

```json
{
  "variableDefinitions": {
    "tokens": { "lifetime": "save", "defaultValue": 20 },
    "lamps": { "lifetime": "save", "defaultValue": 0 }
  },
  "inventory": {
    "currency": { "title": "Travel tokens", "variable": "tokens" },
    "items": {
      "lamp": {
        "title": "Storm lamp",
        "body": "A small light for the platform.",
        "quantityVariable": "lamps",
        "buyPrice": 12,
        "sellPrice": 7,
        "maxQuantity": 1
      }
    }
  }
}
```

`validateNovelInventory` checks bounded plain data and, with story context, requires distinct declared save variables with nonnegative safe-integer defaults. Initial quantities cannot exceed an item's carrying limit. Prices are nonnegative safe integers; `maxQuantity`, when present, is positive. Omitting `sellPrice` disables selling that item.

An ordinary story choice can route to a label containing an immediate transaction:

```json
{ "type": "trade", "item": "lamp", "action": "buy", "quantity": 1, "onFailure": "purchase_refused" }
```

The actions are `buy`, `sell`, and `consume`. Quantity must be a positive safe integer. The item and failure label must exist. `planNovelInventoryTrade` computes either all variable updates or a failure reason without mutating its inputs. The engine applies successful updates inside its original transaction; a failed trade writes nothing and jumps to `onFailure`. Insufficient funds, insufficient stock, carrying limits, invalid numeric state, arithmetic overflow and an unavailable resale price are failure paths. The public planner also rejects a currency/quantity variable alias, preventing one planned write from overwriting another.

A purchase is part of story execution, so the existing pause, checkpoint, rollback, load and new-game rules apply. These quantities reset on a new game; persistent profile unlocks from [collections](VISUAL_NOVEL_COLLECTIONS.md) retain their existing separate lifetime. No generic variable setter was added.

## Player, localization and Editor integration

`NovelView` accepts the same `story.inventory` reference through its optional `inventory` prop. The image-skinned Travel bag is available from the title and journal. It reads quantities from the engine snapshot and prices from the authored catalog. Lists mount at most eight item controls per page; details wrap the selected item text inside the existing scroll page. Catalog enumeration is deferred until the panel opens. Invalid runtime balances are displayed as invalid rather than silently as zero. These bounds are implementation limits, not a measured frame-rate improvement.

Existing `locale.ui` catalogs translate currency titles and item title/body through `novelInventoryTextKey`; dotted item IDs are escaped. `novelSourceUiMessages(assets, story)` derives defaults from the canonical project. Translation does not change prices, quantity variables or transaction behavior. Item descriptions are plain text; the shell captions interpolate their explicitly supplied quantities and prices.

Editor authoring uses a visual Inventory and shop panel and the existing instruction form for `trade`. The shared schema checks references on story writes; direct `buildGuest` invokes the runtime story validator for inventory/trade projects before compilation, so the Editor is not the only validation boundary. Legacy projects without an inventory keep their previous document shape.

## Lantern v6 integration and migration

Lantern starts with 12 travel tokens and no weatherproof envelopes or spare wicks. The postal-service route calls the optional supply shop before its original input fields. Its choices buy, return and consume authored goods. A free `inventory_showcase` replay exposes the same shop directly from the title; replay transactions must leave the main autosave unchanged.

Only a `call platform_stall` was inserted at the start of the existing `registry_open` label; all previous instructions and choice definitions remain in their original order. New shop/replay labels were appended. The standard exact-instruction revision-map generator produced v5→v6 from the frozen v5 bundled story; older maps were composed through it while retaining provenance. Existing saves resume at their mapped continuation and are not forced to enter the newly inserted shop call.

`demo/js/tests/fixtures/lantern-v5-native-save.json` was captured by actual frozen v5 QuickJS/Core execution: title start → `listen_mira` → the memory call → `keep_record`. It contains the real `memory_record_01` autosave and one call-stack frame. The capture script/log is retained under `sdk/.pocket-build/lantern-v6-inventory-20261108/` and `/tmp/pocket-v5-fixture-capture-20261108.log`; it was not synthesized from the save schema.

## Validation checkpoint

- Post-guard SDK suite: 184 tests / 1,510 assertions passed.
- Lantern source gameplay tests: 24 tests / 1,478 assertions passed, including actual shop outcomes, refusal without mutation, replay isolation and revision-map generation.
- New localization plus existing localization tests: 12 tests / 62 assertions passed.
- Targeted strict TypeScript check passed for inventory, engine, types, localization and authoring. The text format now recognizes `trade` directly; its catalog/instruction round-trip also executes a real engine purchase in the unit suite.
- Final v6 native regression: 12 tests across eight files passed, including v1–v5 save migrations, actual ending routes, rollback/meta retention, replay, voice/locale, player input and character records. The separate save-codec fixture check builds its own small Guest; it is not a whole-game codec performance claim.
- Actual Lantern supply-shop native test passed against the final tuple: rendered inventory balances/counts were 12/0/0 → 8/1/0 → 10/0/0 → 3/0/1 → 3/0/0; refused buying retained 3/0/0. The test opened the real bag after transactions and retained a nonempty main autosave, with its write count staying 1→1 through the replay and exit.
- Shared fixture native acceptance passed: buy/sell/consume, separate funds/stock/carrying-limit refusals with full variable comparisons, a real older quick-save load, dialogue rollback and new-game defaults. Injected host storage remains an in-memory test boundary.
- Editor route suite: 20 tests passed and client syntax checks passed. Managed Chromium inventory/item CRUD and trade editing, history, Save/reopen and same-project buildGuest→native flow also passed (1 test); browser cleanup uses its `finally` path.

The isolated build at `sdk/.pocket-build/lantern-v6-inventory-20261108/guest/` uses pinned Bun 1.4.4 and `retina-native-tools-20261108`. Current QJBC SHA-256 is `88ef9081fc24e92b9c6081b8a692a6d82f7d212309d8b378f19f9e739634ec9e`; PAK is `b08e3f07f3305c495b6f2f2d13ecb5da42778d24718e1a1d6ab82ceb7414b2fd`; metadata is `157a56f729e7b9a601f71901e22b896b7cc748498544077406efe1e258a6ae1f`. `source-freeze.json` records exact sources. This three-file tuple is now staged under `demo/assets/apps/lantern/`, with the v5 tuple backed up in `original-staged/` and `staged.json` recording both. Staging and ordinary-app status are separate; the running Flutter window has not been updated.

The ordinary Flutter build remains blocked before runtime by external-volume Git read permission errors; the latest `git status --short` and pinned `flutter --version` wrapper rechecks both reproduced `.git/config: Operation not permitted`. NativeSession executes real Core/bytecode but injects host storage in memory. Its JSON reconstruction proves guest persistence semantics, not Flutter disk durability. No new physical-device, Retina, game-pixel or performance acceptance is claimed. The overall engine goal remains incomplete.

## UI and acceptance corrections discovered during integration

The first final-tuple voice/locale run showed that the new featured replay pushed Resume below the initial narrow title viewport. Resume and Load now precede the experience shortcuts, and the resumed English title/line regression passes. The shop test also exposed that replay's quick-exit header did not expose the journal: an image-skinned bag action now appears inside the existing replay choice list, with its height included in the existing layout calculation. The final test verifies post-trade inventory through pointer input rather than replacing that check with unit values.

Two older tests overwrote explicit `POCKET_LANTERN_GUEST_*` environment paths and could silently consume staged artifacts. They now retain explicit overrides (`??=`). The rollback test reuses one scroll-and-tap title helper for both Load and Gallery. Earlier failed run logs remain in the acceptance cache; only the final passing run describes the final tuple.

Independent read-only review found no blocking transaction, reference, save/rollback or build-validation defect. Two temporary direct-build projects rejected an invalid currency declaration and a trade without inventory before compilation began. Generic `set`/`inc`, `initialVariables` and loaded JSON keep their existing variable semantics: authors can supply invalid inventory values; these display as invalid and cause `trade` to refuse without writes. This feature does not add a new global variable type system.

Acceptance artifacts are retained in `sdk/.pocket-build/lantern-v6-inventory-20261108/acceptance/`. `manifest.json` records the fixture Native/Browser packages, hashes, viewports and limits; `source-freeze.json` and `staged.json` in the parent directory describe the actual Lantern package. The Editor inventory-tab screenshot `inventory-catalog.png` was inspected. It establishes the edited catalog fields, not Flutter game pixels. The fixture native viewport is 360×800, the actual Lantern supply-shop test uses its recorded viewport, and no full device/DPR matrix or maximum-catalog performance result is claimed.

The address-changing postal-service input also has a real compatibility regression: `fixtures/lantern-v5-registry-native-save.json` preserves the native-edited six-character draft `小满平安归港` at v5 `registry_open[1]`. The v6 Guest continued from its title, restored the draft at `registry_open[2]` with no extra call frame or forced shop visit, submitted through actual input, and reached `registry_02`. Fixture SHA-256 is `93bfc22f66e418d55d7abb87b01d27413a3fdc9066c307278586c7ce32965e75`; the capture and continuation logs are `capture-v5-registry-native-attempt2.log` and `novel-inventory-revision-native-attempt3.log` in the acceptance folder. This establishes draft/address compatibility, not absence of Flutter input ghosting.

Final verification with all Guest-path environment overrides unset ran `novel_lantern_inventory_native.test.ts` and `novel_inventory_revision_native.test.ts` against the staged Demo resources: **2 passed, 0 failed** in 1.99 seconds. `acceptance/staged-inventory.log` reports the actual staged paths and final tuple. The original fixture workflow manifest is unchanged; it describes its separate project packages.


## Follow-up ablation: reuse the instruction variable projection

`runUntilBlocking` already computes `variables` before dispatching each instruction.
The trade branch now passes that projection to `planNovelInventoryTrade` instead of
calling `effectiveVariables()` again. No variable writes occur between the projection
and planning, so this removes one redundant full variable clone per trade without
adding cache state or changing transaction semantics. This is not a Live2D FPS fix.

The changed source was compiled through the pinned buildGuest pipeline and passed
`novel_inventory_native.test.ts` (1/1), including successful trades, refusal with all
variables unchanged, load, rollback and new-game defaults. Artifacts:
`sdk/.pocket-build/inventory-projection-trade-reuse-20261108/`; log:
`/tmp/pocket-inventory-projection-fixture-preserved-20261108.log`.
This follow-up was not staged into the ordinary Demo bundle; the v6 staging/source
freeze above describes its earlier immutable checkpoint, not the current engine file.
