# InputField host overlay geometry

## Source-first review

The retained parent project `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was inspected outside `pocket_host/`. Its
`lib/render/pocket_ui_components.dart` `_PocketFlutterNativeKeyboardInput`
keeps a normal Flutter `TextField` attached to a stable controller and focus
node while JS owns the surrounding component and value. That behavior is
preserved: the SDK still uses the Flutter text overlay for native editing and
keeps the guest-side value as the source of truth.

## Cause and adaptation

`InputField` previously removed its only text child when `textInput.opened`
acknowledged the Flutter overlay. That child supplied the input shell's
intrinsic line height, so its removal reduced the measured guest rect to the
border and vertical padding. Flutter then positioned its hint and caret inside
that collapsed rect, which made the native outline, placeholder and caret look
vertically misaligned on iOS.

The guest text node now stays mounted after acknowledgement and uses a
transparent color while the Flutter overlay is ready. This preserves the same
intrinsic layout contribution without drawing a second copy of the text. The
existing overlay, input events and guest value lifecycle remain unchanged; no
host-side minimum height or second layout state was added.

## Validation

The compiled guest/native input regression verifies that the opened rect is at
least one guest text line plus its vertical padding, that the same height is
retained in a rect-only viewport update after the host acknowledges the
overlay, and that the guest copy is invisible while Flutter owns visible
editing.

Command run from the Pocket worktree with the pinned compiler, bytecode tool
and native probe:

```sh
POCKET_WIDGET_FIXTURE_OUTDIR=/tmp/pocket-ui-input-green \
POCKET_SOURCE_BUILD=1 \
POCKET_COMPILER_PATH=/Volumes/ORICO/Development/Github/pocket/sdk/.cache/pocketjs/tools/build.ts \
POCKET_BYTECODE_BIN=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/release/pocketjs_bytecode \
POCKET_NATIVE_PROBE=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/release/pocket_probe \
bun sdk/packages/pocket_ui/test/flutter_widgets.test.ts

POCKET_WIDGET_FIXTURE_DIR=/tmp/pocket-ui-input-green \
POCKET_SOURCE_BUILD=1 \
POCKET_COMPILER_PATH=/Volumes/ORICO/Development/Github/pocket/sdk/.cache/pocketjs/tools/build.ts \
POCKET_BYTECODE_BIN=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/release/pocketjs_bytecode \
POCKET_NATIVE_PROBE=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/release/pocket_probe \
bun test --timeout 180000 sdk/packages/pocket_ui/test/flutter_widgets_native.test.ts
```

The script reported `pointer, compiled scroll and IME layout passed` using
`pocket_probe`. The same compiled regression failed against the old conditional
`Show` implementation: a viewport update after overlay acknowledgement changed
the shell rect height from 37 to 20 guest pixels. The always-mounted JSX `Text`
passes with the rect height unchanged. A Flutter-only temporary geometry probe
and its lockfile changes were removed; an iOS simulator/device run was not
completed in this worktree.
