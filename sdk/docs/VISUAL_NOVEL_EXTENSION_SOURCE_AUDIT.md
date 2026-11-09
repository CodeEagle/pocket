# Visual novel extension source audit

This is a read-only source review for X01/X02. It records the existing runtime, build, and Editor boundaries and proposes a small command-extension slice that can be proved end to end. No production implementation or test changes are included in this audit. X01 and X02 remain pending.

## Source-first findings

### Retained parent plugin files describe host method metadata, not VN execution

The retained parent project has three relevant files:

- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/pocket_plugins.json:47-70` stores custom plugin name/version/enabled/size/channel/method strings. `geolocator` is enabled and `legacy_unused_analytics` is disabled.
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/pocket_flutter_plugins.d.ts:39-44` turns the geolocator method strings into TypeScript namespace declarations. It contains no provider implementation or reducer.
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/tools/sync_pocket_plugins.py:108-113,132-148,157-232,256-278` reads top-level `mini_apps/*.js`, merges custom metadata into an effective registry, uses string containment for method pruning, then writes a `.d.ts`. The declared Dart registrant path is not used to establish that a method can execute.

The current reuse note already captures the limits: `sdk/docs/LEGACY_SDK_REUSE.md:54,71` says to reuse the schema/type-generation idea, but not the old fixed size estimates, string-based tree shaking, or pseudo ABI evidence. These parent files are useful precedent for versioned JSON metadata and generated declarations. They are not evidence that a runtime command exists.

### The VN engine currently has one closed instruction union and one closed executor

- `sdk/packages/pocket_vn/src/types.ts:366-431` defines `StoryInstruction` as a discriminated union of built-in commands. `NovelEngineOptions` at `:449-456` has variables, metadata, preferences, and limits, but no extension provider registry.
- `sdk/packages/pocket_vn/src/engine.ts:335-365` copies and validates the story, then passes every instruction through `validateInstruction`. At `:367-505`, its `switch` validates the built-ins and rejects any other `type` with `failStory(`${path}.type is unsupported`)`.
- `sdk/packages/pocket_vn/src/engine.ts:1510-1516` records the executed instruction type in trace entries; `:1517-1618` executes a second closed `switch`. Adding a type to a declaration alone cannot make it run.
- `StoryValidationError` and `failStory` are at `sdk/packages/pocket_vn/src/engine.ts:108-110,202-203`. Validation already receives a label/index-derived `path` (`:358-360`), so extension errors can remain precise if the extension validator receives `script.<label>[<index>]` and appends `.extension`, `.command`, or `.config.<field>`.

`NovelEngineOptions` and the executor should remain the authority for runtime support. Unknown extension IDs, descriptor versions, command names, malformed configs, and missing provider registrations must fail there. They should not be accepted because a story file or generated TypeScript declaration names them.

### Existing variable, transaction, event, trace, and rollback behavior is reusable

- Variable writes already route through `writeVariable` and `incrementVariable` in `engine.ts:1127-1152`. The helper honors each variable's declared `save`/`session`/`persistent` lifetime.
- Engine mutations are wrapped by `transact` at `engine.ts:1211-1244`. A throw restores the previous state and does not publish the pending update or events. Trace batches are queued only after the transaction returns successfully.
- The existing `trade` branch at `engine.ts:1585-1595` is a useful plan/apply precedent: a pure planner returns bounded variable updates; the engine applies them via `writeVariable` inside the transaction.
- Current event types are the closed `EngineEvent` union at `types.ts:652-688`; events are part of `EngineUpdate` and are documented as transaction-local at `:690-700`. A command may add a typed extension event only if the engine sequences and publishes it after commit. Providers must not dispatch side effects directly.
- Rollback checkpoints capture runtime variables and the active state at `engine.ts:1652-1667`; `rollback` restores variables and stage while retaining metadata/persistent progress at `:2194-2209`. An extension whose only state changes are ordinary `set`/`inc` effects inherits these rules without a second state store.

The initial example should use only those existing variable effects. A synchronous reducer should receive immutable JSON/config and an allowed read-only variable view, and return a validated plan containing `set`/`inc` effects plus optional typed, JSON-only transaction events. It must not mutate engine internals, perform IO, retain state, or run asynchronously. A provider failure should throw a location-bearing engine error; `transact` then supplies atomic rollback.

### Save compatibility has a real existing boundary; extension-owned state does not

- `NovelSaveData` in `types.ts:715-738` is canonical format v1 and stores story ID/version, ordinary variables, metadata, and rollback checkpoints. Compact format v4 is `:872-885`.
- `save-codec.ts:514-604` encodes v4. `:643-655` decodes v1/v2/v3/v4. `engine.ts:1830-1840` rejects a save whose story ID or story version does not exactly match the loaded story.
- Persistent variables already live under `NovelMetaState.persistentVariables`; save and rollback behavior is therefore available to a reducer that only returns supported variable effects.

For this first slice, do not invent an extension-private save bag or bump the save codec. Exercise save/load and rollback using the extension's `set`/`inc` output and the existing `story.version` compatibility gate. The descriptor/provider API version must match exactly at runtime; changing command semantics that alter a story's saved outcomes requires a story version bump. If a later extension owns private state, that is a separate feature: add explicit state migrations and a new save codec version while preserving v1-v4 decoding. A metadata-only `saveVersion` field with no extension state would not provide useful migration semantics and should not be advertised as such.

### BuildGuest validates stories with the real engine, with one current skip condition

`sdk/scripts/build_guest.ts:628-666` reads `story.json`, checks for the `@pocket/vn` dependency and selected VN features, and calls `createNovelEngine(story).dispose()` as the authoritative structural/runtime validator at `:653`. Asset references are then checked with the shared `validateNovelAssetReferences` helper at `:653-666`. A story that uses `@pocket/vn` always takes this path. A story without that dependency can return early at `:645-646` unless it contains inventory, trade, scene objects, or rich say data; a new extension instruction must be added to this feature detection or, preferably, require `@pocket/vn` and fail if its package/provider is absent.

The actual compiler path is still the pinned `buildGuest` pipeline (`build_guest.ts:817-846`); validation should remain in that pipeline and the actual emitted Guest must execute the provider through the real Core. Static typechecks, a generated declaration, or an engine-only unit test are not proof of Guest execution.

### Editor currently duplicates instruction checks and bundles only the shared SDK runtime

- `sdk/editor/novel.ts:760-823` has a separate `isStoryInstruction` switch that rejects unknown types; `:866-979` builds pathful diagnostics, and `:980+` performs the rest of story validation. These checks currently duplicate the engine's closed union.
- `sdk/editor/novel.ts:1171-1188` builds one browser ESM bundle from `sdk/packages/pocket_vn/src/editor-runtime.ts`; `runtimeBundlePromise` is process-global. The `runtime.js` route serves that cached bundle at `:1561-1566`.
- `sdk/packages/pocket_vn/src/editor-runtime.ts:1-36` re-exports the engine and shared VN helpers, but no project-specific extension package.
- `sdk/editor/client/novel.js:6886-6910,6942` loads the shared bundle and calls `module.createNovelEngine(previewStory)` without an extension registry.
- The instruction editor is also static: `client/novel.js:800-855` has a hard-coded factory/type picker, `:866+` switches over known instructions, and the unknown fallback preserves raw JSON. The dialogue/instruction table at `:6184-6374` has a separate field map and renders unsupported operations read-only.

For X02, the Editor must obtain the same validated descriptors as the runtime and build path. Its dynamic Inspector should derive field widgets, enum options, and resource pickers from that descriptor; its local validation should call the same shared extension validator rather than implement a second config schema. The same registered provider must be present in the runtime module used by preview.

## Minimal complete command slice

### Data and provider boundary

Use one JSON descriptor as the source for a command's ID/version, strict config schema, Inspector field metadata, declared resource references, and allowed effects/events. Generate TypeScript config/command types from that JSON, and load the exact same JSON descriptor at runtime for config validation and Inspector metadata. Reuse the bounded, strict schema-generation pattern in `sdk/scripts/plugin_types.ts:25-35,152-220` and `sdk/docs/PLUGIN_TYPES.md:75-114`; do not reuse its HostBridge client or pretend the host capability registry is a VN reducer registry.

JSON cannot contain the reducer implementation. Bind each descriptor ID/version to a statically imported JS/TS provider in a trusted registry. A story instruction should carry only data, for example:

```json
{
  "type": "extension",
  "extension": "sample.reward",
  "command": "grant",
  "config": { "variable": "coins", "amount": 2 }
}
```

The story header should lock the required extension ID and exact descriptor/API version. The engine resolves that requirement against its provider registry before execution. Do not resolve module paths from story JSON, evaluate source strings, or trust a declaration without an implementation. For the first complete slice, keep the example provider statically included in `@pocket/vn` and its Editor runtime export. This makes buildGuest, Preview, and native Guest use one registry. External provider loading can follow only after a shared, pinned provider-package resolver exists for all three paths.

### Runtime contract

The new `extension` instruction is the only new dispatch surface. The provider is synchronous and pure: it receives validated config and a read-only snapshot of declared inputs, and returns a bounded plan of existing variable writes plus optional descriptor-declared events. The engine checks provider identity/version and validates every returned effect, target variable, event name, and event payload before applying anything. Apply effects through `writeVariable`/`incrementVariable` in the current `transact`; assign event sequence/location and emit through the current `EngineUpdate`; trace the actual `extension` operation with its stable instruction ID. Provider exceptions should be wrapped with the authored address so errors point to `script.<label>[<index>].extension`.

This preserves the current semantics: no direct provider mutation; no event before commit; failed plans leave state, trace, and event listeners unchanged; rollback and save operate on existing variables; absence or version mismatch of a provider is a real runtime error.

### Descriptor and compatibility shape

The descriptor should be versioned and strict. Suggested minimum fields:

- `id`, `version`, and a protocol/schema version;
- commands keyed by stable command name;
- each command's config JSON schema with unknown keys rejected;
- Inspector field descriptions generated from that schema (including control type, title, optionality, enum values, numeric bounds, and resource role);
- allowed variable reads/writes and typed event schemas;
- declared asset/resource keys, if the sample uses any.

Keep provider state out of the first contract. Existing `story.version` already rejects incompatible saves. State that any change to a command's saved outcome requires a story version bump, and test that rejection. Reserve extension-owned `saveVersion` and migration callbacks until an extension can own persisted state and a save format/version migration is implemented.

`validateNovelAssetReferences` in `sdk/packages/pocket_vn/src/asset-references.ts:30-62,104-172` is the shared resource-reference boundary. If descriptor resource declarations are part of the example, extend that helper with descriptor-provided field paths instead of creating an Editor-only asset checker. If the first example has no resources, keep that helper unchanged.

## Files and integration seams for a later implementation

The narrow implementation can be staged as follows; this audit does not make these changes.

1. **Types and shared descriptor/provider contract** — `sdk/packages/pocket_vn/src/types.ts` (extension instruction, story requirements, engine registry option, event and trace types), a new `src/extensions.ts` (strict descriptor loading, registry construction, config and effect validation), and `src/index.ts` / `src/editor-runtime.ts` / `package.json` exports. Add the one example descriptor JSON and statically imported provider in the package.
2. **Core behavior** — `sdk/packages/pocket_vn/src/engine.ts`: accept the registry during validation, reject absent/mismatched providers with a path, execute the provider plan in `runUntilBlocking`, validate event payloads, and include extension execution in trace. Use the existing transaction and variable helpers.
3. **BuildGuest proof** — `sdk/scripts/build_guest.ts`: ensure extension usage cannot take the existing early return; pass the same registered provider set to `createNovelEngine`; validate descriptor resources through the shared asset helper. Add one positive and one negative build fixture. The missing-provider fixture must fail before output is accepted.
4. **Editor parity** — `sdk/editor/novel.ts`: remove the extension-specific duplicate switch logic by delegating to shared validation and return field-level diagnostics. `sdk/editor/client/novel.js`: add the generic extension opcode/factory and render config fields from the runtime descriptor; route the all-instruction table through the same descriptor metadata. Keep unknown extensions read-only and visibly invalid.
5. **Authoring/interchange** — `sdk/packages/pocket_vn/src/authoring.ts:45-47,281-303` currently has a closed known-opcode list but can preserve unknown instructions in the generic `json` representation. The first version can continue using that lossless JSON form; only add a friendly textual opcode after its syntax and source mapping are specified. CSV/Markdown interchange should round-trip the instruction payload unchanged.
6. **Regression proof** — add engine tests for valid config, wrong config path, missing/mismatched provider, invalid provider output, committed event/trace, rollback, save/load, and story-version mismatch; add one same-`buildGuest` fixture that executes the command in the actual Core/Probe and asserts the resulting variable/event/frame; add Editor browser coverage that edits the descriptor-defined field, previews the same provider, and shows a pathful error when the provider is omitted.

## Safe acceptance boundary and unresolved risks

- A generated `.d.ts` or JSON descriptor is not executable support. Do not let Editor or buildGuest accept a command until the exact ID/version is found in the same statically linked provider registry used by the engine.
- The initial Editor runtime is one process-cached SDK-only bundle. Supporting third-party provider packages will require a project-specific, pinned bundling contract and cache key; otherwise a Preview may appear to validate a provider that the built Guest does not contain. Until that exists, only SDK-registered providers are supported.
- Provider code is executable JS. A registry binding is not a sandbox. The first sample should be trusted package code with a narrow pure reducer interface; JSON validation can bound config/effects but cannot make arbitrary provider code safe. Do not expose engine internals, IO handles, raw source, or `eval`.
- The first slice does not complete every X01 item (generic extension methods, settings, hooks, or slots) and does not complete external extension installation (X04). It proves one typed custom command and shared Inspector metadata only. Keep those tracker rows pending until their own runtime contracts and lifecycle tests exist.
- The extension command should not be added to the TS union while buildGuest and Editor validation still use independent closed switches. The shared descriptor/provider registry must be wired first or in the same change; otherwise the system can typecheck a story that Preview/Guest rejects.
