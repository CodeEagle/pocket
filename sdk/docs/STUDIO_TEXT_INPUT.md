# Studio text input: multi-line field, raw text mode, modifiers, text cache

Approved SDK changes from `studio/docs/M0_REPORT.md` sections 3.1 and 3.2 (owner decision 4).
Everything here is additive: a guest and a host that do not use these features behave as before.

## Source-first note

The parent repo `pocketjs_flutter_demo` is not available in this environment, so nothing was
ported from it. Reused SDK code:

- `InputField` and the `textInput.open/update/close` protocol (`packages/pocket_ui/src/ui.tsx`),
  the host `TextField` overlay, the line-count parser and the session/stale-event handling in
  `pocket_view.dart` (see `INPUT_REUSE.md`, `INPUT_OVERLAY_DUPLICATE_TEXT.md`).
- `PocketViewController.sendTextEvent` and the native `input.text` admission (`queue_text` in
  `native/src/lib.rs`), which already existed but had no caller.
- `PocketTextLayoutCache` and its counters (already present; only its capacity was not reachable).
- The upstream PocketJS text event and its modifier-in-key-name convention (see below).
- The model of `test/pocket_binary_input_ffi_test.dart` for the real-FFI test.

New code is only the evidenced gaps: the host IME client, raw session methods, modifier mask
folding, `multiline` props and the cache option.

## A. Multi-line `InputField`

`InputField` takes optional `multiline`, `maxLines`, `minLines`.

| Props | `keyboardType` | `action` | `maxLines` | `minLines` |
| --- | --- | --- | --- | --- |
| none, or `multiline: false` | `"text"` | `"done"` | `1` | absent (byte-identical to before) |
| `multiline: true` | `"multiline"` | `"newline"` | `null` (unbounded) | absent |
| `multiline: true, maxLines: 6, minLines: 3` | same | same | `6` | `3` |

`maxLines` invalid (< 1, NaN) means unbounded; `minLines` is clamped to `maxLines`. Line
configuration is sent with `textInput.open`; later `textInput.update` messages do not repeat it.

Host fix: `maxLines: null` was previously indistinguishable from "absent" (the fallback applied).
An explicit `null` `maxLines` now means unbounded, and `minLines > maxLines` is clamped so a guest
cannot trip Flutter's assertion. With `action: "newline"` the platform inserts the line break as
text; the host does not emit `textInput.submit`.

## B. Configurable text layout cache

`PocketView(textLayoutCacheCapacity: 256)` (default 256, asserted > 0, fixed for the view's
lifetime; changing it on a mounted view throws like the other "remount to change" options).
`PocketViewController.textLayoutCacheStats` returns a read-only snapshot
(`capacity, length, hitCount, layoutCount, evictionCount`) or `null` when no view is attached.
Spike B should compare 256 with about 2048.

## C. Modifiers on key text events

Upstream finding (`.cache/pocketjs`): the `TextEvent` type, the `PocketTextEvent` ABI record and the
guest bindings have no modifier field, but `framework/src/text-input.ts` and `drivers/abi.rs`
document the convention "a held modifier comes first, as in `Control+z` or `Alt+ArrowLeft`".
Changing the ABI would touch the C ABI struct, two guest bindings and the framework type, so no
upstream patch was added. The host implements the documented convention instead.

Wire (`input.text`, key events): optional integer `modifiers`, bitmask shift=1, control=2, alt=4,
meta=8. Absent, `null` or 0 means none. Values above 15 or non-integers are rejected (whole batch,
as with other malformed input). Rust folds the mask into the key name in the fixed order
`Control`, `Alt`, `Shift`, `Meta`, so the guest sees `Control+Shift+z` in the existing
`onTextEvent` `key` field. A modifier key never prefixes itself (`Shift` with shift held stays
`Shift`). The folded name is still limited to 128 bytes. Caps lock is not carried.

Consequence for guests: Shift+letter arrives as `Shift+A` plus a separate `commit` of `A`; a guest
editor should treat named keys and chords from `key`, and typed text from `commit`.

## D. Raw text-input mode (guest-requested)

Host opt-in: `PocketView(rawTextInputEnabled: true)`. Without it the host answers a raw request with
`textInput.rawDismiss {reason: "unavailable"}` and nothing is attached. The session itself is
requested by the guest, so policy stays in JS.

Guest -> host events:

```json
{"name":"textInput.rawOpen","payload":{"id":"editor","rect":{"x":120,"y":340,"w":2,"h":16}}}
{"name":"textInput.rawUpdate","payload":{"id":"editor","rect":{"x":128,"y":340,"w":2,"h":16}}}
{"name":"textInput.rawClose","payload":{"id":"editor"}}
```

`rect` is the caret rectangle in guest logical coordinates; the host forwards it (scaled to view
coordinates, with the view's transform) as the platform caret and composing rect so the IME
candidate window opens at the caret. Update it with `rawUpdate` when the caret moves. Opening the
same id again acts as an update.

Host -> guest events: `textInput.rawOpened {id}` after attachment, and
`textInput.rawDismiss {id, reason}` when the host ends the session. Reasons: `unavailable`,
`replaced` (another raw or `InputField` session opened), `blur` (keyboard focus lost),
`platform` (IME connection closed), `inactive`, `focus.lost`, `compositor.focus`,
`runtime.dispose`.

While a session is open (events go through the existing `input.text` path):

1. Key edges: `{"kind":"keyDown"|"keyUp","key":"ArrowLeft","repeat":true,"modifiers":3}`;
   `repeat` and `modifiers` are omitted when false/0. Key names follow `KeyboardEvent.key`
   (`a`, `Enter`, `Backspace`, `ArrowLeft`, `Shift`, ...; left/right modifier variants collapse).
   Modifier keys are forwarded too.
2. IME and printable text use a `DeltaTextInputClient` (`PocketRawTextClient`):
   `{"kind":"composition","text":"ni","selectionStart":2,"selectionEnd":2}` (marked text; offsets
   relative to it, UTF-16 units), `{"kind":"compositionEnd"}`, `{"kind":"commit","text":"你"}`.
   Order: finishing a composition sends `compositionEnd` then `commit`; a cancelled composition
   sends only `compositionEnd`; plain typing sends `commit`; text finalized before a new marked
   region is committed first.
3. The button bitmask path is not fed (held buttons are cleared when the session opens).
4. A `textInput.open` (`InputField`) session and a raw session never coexist; the newer one wins and
   the older gets a dismiss.

Key forwarding policy (assumptions to confirm on macOS): printable keys without Control/Meta are
returned as "ignored" so the platform IME also receives them; other keys are "handled" so focus
traversal and shortcuts cannot take them. While a composition is active only `keyUp` edges are
forwarded: Enter, arrows, Space and Escape belong to the IME then (like DOM `isComposing`).

Limits: `commit` and `composition` text is at most 4096 UTF-8 bytes per event. Larger commits are
split on code point boundaries (never inside a surrogate pair). Marked text over the cap is
truncated. The native queue holds 64 text events per frame, so a single commit above 256 KiB is
rejected by native admission (reported through `FlutterError`/`onError`, not retried). Large paste
belongs to the clipboard plugin. Soft-keyboard Backspace on mobile is not synthesized (no hardware
key edge); this mode targets desktop.

Host state: only the platform client binding (a scratch `TextEditingValue`, emptied after every
commit, plus the session id and caret rect). No policy or text model lives in Dart.

## Verified on Linux

Commands run from `sdk/packages/pocket_flutter` with `PATH=/opt/flutter/bin:$PATH` and
`POCKET_NATIVE_LIBRARY=/home/user/pocket/sdk/native/target/debug/libpocket_flutter.so`:

- `flutter test test/pocket_raw_text_input_test.dart` (8): rawOpen attach, caret rect, key names,
  repeat, modifiers, no `input.buttons`, pinyin composition and candidate commit, cancel, dead key,
  non-BMP offsets, 4096-byte split, keys during composition, TextField replaces raw, gate off,
  rawClose restores button keys. IME updates are injected through the real
  `TextInputClient.updateEditingStateWithDeltas` channel message.
- `flutter test test/pocket_raw_text_input_ffi_test.dart` (1, real library, not skipped): a real
  QuickJS guest requests the session and receives `Control`, `Control+z` keyDown/keyUp,
  `composition ni`, `compositionEnd`, `commit 你`.
- `flutter test test/pocket_view_multiline_input_test.dart` (6) and
  `test/pocket_view_text_cache_test.dart` (5).
- `cargo test --locked --lib key_modifiers_fold` (Rust admission and guest-visible names).
- `bun packages/pocket_ui/test/probe/input_field_multiline.probe.ts` via
  `packages/pocket_ui/test/input_field_multiline.test.ts` (separate process because it installs
  module mocks).

Linux has no Pocket host app and no real IME, so none of this proves platform IME behaviour.

## Spike A: macOS checklist (not done)

Run a guest-drawn editor with `rawTextInputEnabled: true` on macOS (Apple Silicon):

1. Pinyin: type `nihao`, observe `composition` updates, select a candidate with Space/number,
   confirm `compositionEnd` then `commit`, and that the candidate window sits at the guest caret
   (also after `rawUpdate` moves it and after window resize/scroll).
2. Japanese (Kana/Romaji): marked text with clause selection (selection offsets inside the marked
   range), Enter to commit, arrows within the candidate list not leaking as guest key events.
3. Dead keys (Option+E then E): `composition` of the accent, then `compositionEnd` + `commit`.
4. Composition cancel (Escape, and clicking away): only `compositionEnd`, no stray commit, no
   stuck marked text, scratch buffer reset.
5. Selection replace: with a guest selection, committing IME text must replace it (guest policy);
   confirm no host-side selection exists.
6. Key policy: Cmd+S/Cmd+Z/Shift+Arrow arrive with the right `modifiers`; plain letters give both a
   `keyDown` and a `commit` exactly once; held key repeat; Tab/arrows do not move Flutter focus;
   Cmd+C/V are not swallowed by menu shortcuts.
7. Confirm the "ignored"/"handled" return values do not break IME delivery (macOS skips the text
   input plugin for handled events) and that IME text is not duplicated.
8. Open an `InputField` while raw is active and the reverse; check `rawDismiss reason=replaced`.
