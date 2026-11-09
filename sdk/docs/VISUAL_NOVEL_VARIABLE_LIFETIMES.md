# Pocket VN variable lifetimes

Variable lifetimes extend the same JavaScript story engine and save format. The engine exposes one effective `snapshot.variables` projection to scripts and UI. It does not add a second script interpreter or keep separate mutable value maps for each lifetime.

## Story declaration

Declare a lifetime and optional JSON default in `variableDefinitions`:

```ts
const story = {
  id: "harbor", version: 1, start: "opening",
  variableDefinitions: {
    visitCount: { lifetime: "session", defaultValue: 0 },
    clueCount: { lifetime: "save", defaultValue: 0 },
    chosenName: { lifetime: "persistent", defaultValue: "" },
  },
  script: { /* ... */ },
};
```

Lifetimes are `session`, `save`, and `persistent`. Undeclared variables retain existing behavior and use `save`. A declared default is a static fallback, while `initialVariables` overrides it for that engine instance. Definitions require existing Pocket variable names and JSON defaults; unknown authoring metadata remains in the story data and is ignored by the engine. The shared `novelVariableDefinitionsIssue(value)` helper validates this schema for the editor and runtime.

## Runtime meaning

- `save` values reset to the original `initialVariables` or definition default in `newGame()`.
- `session` values survive `newGame()` with their current value. They are still included in explicit saves, loads, and dialogue rollback checkpoints.
- `persistent` values survive `newGame()` and rollback. Their canonical mutable values live in `snapshot.meta.persistentVariables`; the public `snapshot.variables` is the merged projection used by conditions, interpolation, and UI.
- A persistent definition default (and an `initialVariables` value for that variable) is only a fallback. The engine does not eagerly copy fallback values into persistent metadata. An explicit persistent write or existing metadata wins over a fallback.

`newGame()` is a transaction that resets the current story location, save-lifetime values, stage, backlog, and rollback history, then immediately runs to the next blocking instruction. It keeps preferences, session values, persistent metadata, and monotonic event/voice/transition counters. It emits stop events for currently playing channels before running the new story start so the host can stop old playback.

Rollback restores session/save values and stage from the selected completed-dialogue checkpoint. Persistent metadata is kept. Checkpoints therefore contain only session/save values; a completed line's already displayed text remains the checkpoint text even if it interpolated a persistent value that changed later.

## Save and migration behavior

The existing `pocket-vn-save` version 1 is preserved. `state.variables` serializes session and save values; `state.meta.persistentVariables` stores canonical persistent values. Loading replaces session/save values from the selected save and merges meta progress; explicit persistent values already held by the current engine win over older slot values. A fresh engine loading a save restores that save's persistent values, which take precedence over definition and `initialVariables` fallbacks.

Legacy metadata without `persistentVariables` remains valid. When loading a legacy save whose `state.variables` contains values now declared persistent, the engine migrates those entries into persistent metadata. They are removed from rollback checkpoint values so rollback cannot rewind persistent progress. Save loading validates the entire replacement before commit and leaves current state unchanged on malformed data.

The retained parent Flutter demo provides generic JS-owned component state and explicit save/load boundaries, but it did not define VN variable lifetimes or restart semantics. This change builds on the existing Pocket VN `state.variables`, `NovelMetaState`, save/load, rollback, and transaction paths. It adds only lifetime declarations, a persistent metadata carrier, a public `newGame()` transaction, and the shared editor schema helper. No Dart variable store or persistence policy is introduced.

## Validation coverage

The regression suite checks definition validation, defaults and undeclared-variable compatibility, typed runtime writes, save/load precedence, legacy variable migration, new-game reset and retained state, rollback semantics, persistent interpolation in historical checkpoints, and event/voice/transition counter continuity.

From `sdk/`, `bun test packages/pocket_vn/test` passed **67 tests, 0 failures, 485 assertions**. Strict TypeScript validation passed with:

```sh
node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --skipLibCheck --jsx preserve packages/pocket_vn/src/types.ts packages/pocket_vn/src/input.ts packages/pocket_vn/src/variables.ts packages/pocket_vn/src/engine.ts packages/pocket_vn/src/authoring.ts packages/pocket_vn/src/editor-runtime.ts packages/pocket_vn/src/index.ts
```

The Editor integration was also exercised in real Chromium through variable declaration save, undo, reopen, bundled core execution, and `newGame()` persistent-value retention; the run log is `/tmp/pocket-variables-editor-browser.log`.
