# Pocket visual novel engine

## Source review and migration boundary

The retained parent project has an interactive game loop, but no visual novel script, dialogue system, branching story, or save format to migrate. The closest gameplay source is [`mini_apps/app_game_detail/main.js`](../../../pocketjs_flutter_demo/mini_apps/app_game_detail/main.js): it updates the world from `onUpdate(dt)`, reads BLE input, checks collisions, and draws through the existing game surface. The package keeps that explicit update model while replacing game-specific world state with serializable story data and an explicit `tick(ms)` input.

The parent renderer source is [`lib/render/pocket_ui_components.dart`](../../../pocketjs_flutter_demo/lib/render/pocket_ui_components.dart), with interaction and screenshot coverage in [`test/pocket_38_components_screenshot_test.dart`](../../../pocketjs_flutter_demo/test/pocket_38_components_screenshot_test.dart). Those files provide the retained component and interaction precedent, but they do not contain a narrative runtime. Pocket's existing JS-owned component and storage boundary in [`sdk/packages/pocket_ui/src/platform.ts`](../packages/pocket_ui/src/platform.ts) remains the integration path. The VN package does not add a Flutter business-state machine or a second layout/runtime system.

`@pocket/vn` is an adaptation for the missing narrative capability. `src/engine.ts` is a pure TypeScript interpreter; `src/view.tsx` renders snapshots with the existing Pocket component compiler; `src/clock.ts` consumes the guest virtual clock; and `src/audio.ts` sends cue requests to the registered Pocket audio capability. Save data is passed to a host storage implementation through `NovelStorage`.

## Story and execution model

`StoryDefinition` is versioned data with a stable `id`, `version`, a start label, and arrays of instructions keyed by label. The interpreter validates labels, targets, instruction data, conditions, and save addresses before use. It never evaluates script text or JavaScript. Conditions use a typed AST over literals and variables; `set` accepts a JSON literal and `inc` changes a numeric variable. Optional inventory catalogs use declared save variables; `trade` atomically buys, sells or consumes items, with an authored failure label and no separate state. See [inventory and trading](VISUAL_NOVEL_INVENTORY.md).

The core supports dialogue with stable read IDs and `{{variable}}` interpolation; background, character expression, visibility, and position updates; cut/fade/dissolve transitions; host audio cues; waits; conditional branches; jumps; calls and returns; filtered choices; timed choices with a timeout label; typed player input; and endings with optional CG IDs. Instruction execution stops at dialogue, choice, input, wait, or ending boundaries. A configurable instruction budget aborts automatic loops atomically.

Player text, number and boolean inputs keep their uncommitted draft in the same engine snapshot. Only a valid explicit submission writes the typed variable; cancellation follows an authored label without committing that input. Auto, skip and debug stepping cannot bypass input. The existing native `InputField` handles text and IME; `NovelView` can subscribe to the consumer's existing HostBridge through its `host` prop. See [input schema and migration](VISUAL_NOVEL_INPUT.md).

All time is supplied by `tick(deltaMs)`. Typewriter reveal counts Unicode code points, and zero characters per second displays text immediately. Auto mode waits the configured delay after a line is fully revealed. Seen-only skip moves through previously committed dialogue and stops at unread dialogue. Timed choices and stage transitions advance from the same guest time delta. Pause stops progression; the core does not create timers or consult wall-clock time.

The engine publishes complete immutable snapshots and transaction-local events. Persistent audio channel intent is part of the snapshot so the host adapter can reconcile after save load or rollback. One-shot cues are events. A cue event means that playback was requested; only the host adapter can report whether the capability actually played it.

## Save, rollback, and persistent progress

Save format `pocket-vn-save` version 1 records story identity/version, current instruction address, JSON variables, stage, active instruction, call stack, one bounded canonical backlog, preferences, audio intent, and compact rollback checkpoints. Load rejects unknown formats, story mismatches, invalid instruction addresses, inconsistent active state, invalid variables, or malformed history before changing the live engine.

Each checkpoint stores its reversible state and a `backlogSequence` cursor. It does not copy the dialogue log. Save data therefore serializes the bounded backlog once instead of repeating it in every checkpoint. Backlog and rollback limits are configurable. Loading into a smaller backlog limit keeps only the newest entries; a checkpoint can still restore gameplay state after older log entries have been pruned, while the remaining log is filtered to the checkpoint cursor.

### Resuming after a dialogue copy edit

The retained parent Flutter demo has no VN save engine or dialogue-state migration to reuse. The existing SDK locale rebase in `src/localization.ts` already preserves partial typewriter progress by its Unicode code-point fraction; save loading now uses the same rule for an active `say` when its text has changed. The save's own text, visible prefix, reveal count, and completion flag must first agree. The current instruction must still be a `say` at the saved location with the same stable ID, speaker, and portrait. Story ID/version, instruction kind/address, and all other instruction-state checks remain strict. If the text is unchanged, its saved progress is preserved exactly.

For a changed active line, the engine interpolates the current instruction with the loaded variables and maps the old reveal fraction to that text, counting Unicode code points rather than UTF-16 units. A completed line stays complete. Rollback checkpoints use their checkpoint variable snapshot for ordinary variables, so earlier copy is rendered with the value that belonged to that checkpoint. A checkpoint whose text depends on a persistent variable keeps its historically saved rendered text because persistent values intentionally are not rewound. Backlog entries remain historical log records and are not rewritten. This compatibility is limited to dialogue copy updates under the same story identity/version and stable instruction binding; it does not relax validation for changed instruction structure or other active kinds.

`test/say_restore.test.ts` covers an old partial save loaded after a same-ID copy edit, unchanged-text compatibility, Unicode code-point progress, preserved backlog, edited-text rollback with checkpoint variables, the persistent-variable history exception, malformed saved prefixes, and changed say identity/kind rejection.

Read-line, ending, and CG metadata are meta progress. Rollback leaves it intact, and load merges saved metadata with the engine's current metadata so loading an older slot does not erase unlocked items. `engine.newGame()` reuses the engine: it resets save-lifetime values and story state while preserving session values, meta and preferences. Persistent variables have their single mutable source in meta; explicit current persistent values win over older save values. Defaults remain derived fallbacks. See [variable lifetimes](VISUAL_NOVEL_VARIABLE_LIFETIMES.md).

## Editor controls

The editor can use the same `createNovelEngine` runtime. `engine.debug.pause`, `resume`, `step`, `setBreakpoints`, and `jump` are controls on that runtime, not another execution implementation. A breakpoint stops before its instruction. `step` runs to the next blocking story instruction and pauses. `jump` validates the destination, clears the call stack and rollback checkpoints, and preserves variables, stage, meta, and backlog. Variable inspection is read-only through the immutable snapshot.

## Known limits

- Stable-ID localization tables and runtime locale switching are supported; plural rules and AI translation remain unimplemented.
- Stories cannot register custom instruction handlers or execute arbitrary expressions. Extend the typed instruction schema and validator when a concrete feature requires it.
- Transitions support cut, fade, and dissolve with a duration. Authorable tween curves, layered motion tracks, and reusable animation timelines are not included.
- Audio cues and token-associated voice completion control automatic progression. Subtitle timing derived from voice assets and cross-track fades remain unimplemented.
- The core records CG IDs and exposes declarative asset keys. It does not preload, decode, or guarantee availability of media; the host/view asset boundary owns that work.
- The editor operates on the same `StoryDefinition`; collaborative editing, hot reload during playback, visual graph auto-layout, and cloud save synchronization are outside this package.

## Verification

Core and audio tests cover instruction execution, branch and call behavior, saves and load validation, rollback with persistent meta, bounded-log pruning, seen-only skip, auto reveal, timed choice, pause/resume, debug controls, audio request semantics, and step-budget recovery.

```sh
bun test sdk/packages/pocket_vn/test/engine.test.ts sdk/packages/pocket_vn/test/audio.test.ts
sdk/node_modules/.bin/tsc --noEmit --strict --allowImportingTsExtensions --target ES2022 --moduleResolution bundler --module ESNext sdk/packages/pocket_vn/src/index.ts sdk/packages/pocket_vn/src/engine.ts sdk/packages/pocket_vn/src/types.ts
```
