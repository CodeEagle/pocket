# Pocket VN player input

Pocket VN input runs inside the existing JS story engine. It adds one blocking instruction and one typed active state; it does not add another interpreter, clock, Flutter business state, or a second save format.

## Source-first reuse and the remaining gap

The retained parent demo has a native `TextField` in [`pocket_ui_components.dart`](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/render/pocket_ui_components.dart#L3508) and JS-owned text synchronization in [`pocketjs_bundle_runner.dart`](/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart#L1001). The field keeps a `TextEditingController` and `FocusNode`, forwards raw text changes to the runner, and can show or hide the system IME. The runner stores and reflects that text in its existing JS-facing state. This is a useful raw text and host IME reference, but it has no VN instruction, validation, typed variable commit, cancel branch, or save/rollback behavior.

The current renderer and IME reuse boundary is recorded in [`INPUT_REUSE.md`](./INPUT_REUSE.md), with JS ownership decisions in [`DECISIONS.md`](./DECISIONS.md) and the component contract in [`COMPONENTS.md`](./COMPONENTS.md). This implementation reuses the existing Pocket VN story validator, instruction loop, transaction rollback, save/load validation, completed-dialogue checkpoints, and explicit `tick(ms)` clock. Flutter remains responsible for system text editing; the VN engine owns whether a draft is valid and when it becomes a story variable.

## Authoring format

The new `input` opcode carries a JSON payload and round-trips through the existing text authoring parser and formatter:

```text
input {"id":"player-name","variable":"player.name","inputType":"text","prompt":"What should we call {{hero}}?","placeholder":"Name","minLength":1,"maxLength":40,"cancelTarget":"cancel"}
input {"id":"age","variable":"player.age","inputType":"number","prompt":"How old are you?","min":1,"max":130,"integer":true}
input {"id":"confirmed","variable":"player.confirmed","inputType":"boolean","prompt":"Continue?","defaultValue":true}
```

`id` must be non-empty and unique among input instructions. `variable` follows the existing story variable rule: an ASCII letter or underscore, followed by ASCII letters, digits, `_`, `.`, or `-`. `cancelTarget`, when present, must name a story label. `prompt` and text/number `placeholder` use the engine's existing `{{variable}}` interpolation. Boolean inputs reject `placeholder` because they are represented by their two values.

Each branch accepts only its own constraints. Text accepts string `defaultValue`, `minLength`, and `maxLength`; number accepts finite numeric `defaultValue`, `min`, `max`, and boolean `integer`; boolean accepts boolean `defaultValue`. Supplying a known field from another branch is a story validation error. Unknown instruction extension properties remain lossless like other story metadata.

Defaults are static initial drafts. The engine does not read a same-named variable to seed an input. Without a default, text starts as `""`, number starts as an empty string draft, and boolean starts as `false`. A default must itself satisfy its branch constraints.

Text lengths count Unicode code points (so an emoji represented by a surrogate pair counts as one). `minLength` and `maxLength` are safe integers from 0 through 4096; `minLength` cannot exceed `maxLength`. Raw text drafts are capped at 4096 code points even when no `maxLength` is set.

Numbers accept this base-10 grammar, with no surrounding whitespace:

```text
[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?
```

Thus `+12`, `-12.5`, `.5`, `12.`, and `1e+3` are valid forms. Hex, binary, `Infinity`, `NaN`, and incomplete forms such as `.` are rejected. The parsed JS `Number` must be finite, so a syntactically valid overflow such as `1e999` is rejected. Numeric raw drafts are capped at 128 code points. `integer` is checked before inclusive `min`/`max` bounds; both bounds must be finite and `min <= max`.

## Player state and API behavior

An active input snapshot has one consistent shape:

```ts
{
  kind: "input",
  location, id, variable, inputType,
  prompt: string | null,
  placeholder: string | null, // always present; null for boolean/no placeholder
  draft: string | boolean,
  canCancel: boolean,
  error: null | { code, limit? }
}
```

The structured error codes are `required`, `tooShort`, `tooLong`, `number`, `integer`, `min`, and `max`. `limit` carries the expected length or numeric bound for the four bounded errors. An empty number draft is `required`; text uses `minLength` to reject a short value, and an empty text value is otherwise valid. A boolean's API value must be a boolean.

- `updateInput(value)` stores text/number strings without parsing or trimming, stores booleans as booleans, and clears the previous error. A wrong value type or a raw draft over its cap throws `RangeError` and leaves the snapshot unchanged; the engine never silently truncates.
- `submitInput()` validates the current draft. Invalid player input returns an `EngineUpdate` with the input still active and a structured error; it does not throw or change the variable. A valid draft is converted to its typed string/number/boolean, committed to `variables`, then the existing instruction loop runs to the next blocking state.
- `cancelInput()` follows `cancelTarget`, if one exists, and leaves the variable untouched. Without a target it throws `NovelEngineError` and stays at the input.
- Editing, submitting, or cancelling requires a running, unpaused active input. A paused engine or a different active state throws `NovelEngineError`. `advance()` cannot bypass input. Auto/skip ticks stop at input; input has no independent timer. Existing scene transition time may still advance during a tick.
- Debug stepping runs through the existing instruction loop and stops at input; a later debug step cannot cross it.

## Save, load, and rollback

The existing `pocket-vn-save` format version 1 remains in place. An active input save contains its draft and error, not a copy of the instruction's constraints. Load checks the active location against the story instruction, then validates the input id, variable, type, derived prompt/placeholder, cancel capability, draft type, and raw cap. Boolean placeholder is required to be `null`. A draft can be invalid with `error: null` because edits clear errors and need not submit; when an error is present, load verifies that its code and limit exactly match the current draft. Load builds and validates the full replacement before committing it, so malformed input saves leave live state unchanged. Existing saves without input states remain readable.

Input submission does not create a new rollback system. Once a later dialogue line completes, the existing dialogue checkpoint contains the typed variable and stage at that point. Rolling back to that checkpoint restores the typed value and stage together.

## Existing host input transport and ablation

Pass the consumer's existing HostBridge as `<NovelView host={host} ... />`.
The view subscribes to that bridge and forwards `textInput.*` events to the
existing `deliverTextInputEvent`; it does not install another bridge or copy
the draft. Without this connection, the native field could open but edits did
not reach JS. The saved Editor Guest and shipped game now exercise this full
event path.

IME Done closes its editor session and retains the JS draft. It does not submit
the story input. The visible Submit button is the commit action, preserving
composition and avoiding an accidental advance from the keyboard action.
Opening a menu or pausing unmounts the native field and closes its session;
the engine keeps the draft for resume, save and load. An over-cap paste is
rejected without truncation; the controlled field remounts from the unchanged
engine draft and a stale editor session cannot replace it.

The first input panel used its own FocusScope. Real QJBC pointer acceptance
showed that this restricted the header/footer and prevented opening the journal
during input. Removing that redundant modal scope restored menu, save/load and
rollback while keeping the existing field and boolean focus targets. The same
native input test now passes that sequence. There is no performance claim from
this interaction ablation.

## Validation

The input regression suite covers typed submission, invalid stay-on-input behavior, Unicode code points, decimal syntax and bounds, raw draft caps, cancellation, pause rejection, auto/skip/tick/debug stops, save/load tampering and atomicity, legacy saves, authoring round-trip, and dialogue-checkpoint rollback.

From `sdk/`, `bun test packages/pocket_vn/test` passed **61 tests, 0 failures**. Strict TypeScript validation passed with:

```sh
node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --skipLibCheck --jsx preserve packages/pocket_vn/src/types.ts packages/pocket_vn/src/input.ts packages/pocket_vn/src/engine.ts packages/pocket_vn/src/authoring.ts packages/pocket_vn/src/editor-runtime.ts packages/pocket_vn/src/index.ts
```
