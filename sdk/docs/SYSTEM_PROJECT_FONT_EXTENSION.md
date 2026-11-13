# System catalog project fonts

## Source-first finding

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` has no portable `pocket.json` font extension or project-local TTF/OTF workflow outside the excluded `pocket_host/` directory. The inspected Flutter renderer uses ordinary `TextStyle` values, and the web demo uses CSS/system font stacks. There is no parent validator or manifest adapter to migrate.

The current SDK already defines the project-font contract in `scripts/build_guest.ts`: optional `pocket.json.fonts.regular` and `.bold` paths must be project-relative TTF/OTF files, nonempty regular files, without absolute/traversal paths or a final-file symlink, and their resolved targets must remain inside the package root. The pinned compiler receives those resolved paths as `--font-regular` and `--font-bold`.

## Shared validation boundary

`scripts/project_fonts.ts` owns that validation for both direct Guest builds and System catalog validation. It returns compiler arguments plus a separate official-schema input. When `fonts` is absent, the input is unchanged. When present and valid, only `fonts` is removed from the detached copy passed to the pinned `PocketManifestV2` validator; the source `pocket.json` is never rewritten. Invalid declarations remain in the input and produce a field-specific SDK diagnostic. All other fields continue through the pinned schema unchanged, so `additionalProperties: false` still rejects unrelated unknown fields.

`build_guest.ts` uses the helper's compiler arguments and preserves the existing compiler path. `build_system.ts` resolves each catalog manifest relative to that package's root, validates its font paths through the same helper, and strips the extension only from the object it hands to the upstream child-manifest validator. This lets System catalog admission recognize the SDK build-time extension without weakening the official manifest contract.

## Validation

`scripts/tests/build_system_fonts.test.ts` covers valid local paths, precise rejection of an escaping path, rejection of an unrelated unknown manifest field, byte-for-byte preservation of each source manifest, and the real Lantern entry in the Demo System catalog. `scripts/tests/build_guest_fonts.test.ts` continues to exercise malformed paths, symlinks and compiler-baked regular/bold font metrics.

By default, `demo/js/apps/lantern/pocket.json` omits `fonts` and uses host-native system fonts; when a consumer package declares `fonts.regular` and/or `fonts.bold`, System validation resolves them relative to that package's directory. The helper does not parse font bytes; the existing pinned compiler remains responsible for font decoding and atlas generation.

## Ablation

Before this change, buildGuest owned the strict font-path rules while System validation handed the same `pocket.json` to the upstream schema unchanged and rejected `fonts` as unknown. The shared helper removes that duplicate boundary: buildGuest consumes compiler flags, and System validation consumes only the validated schema copy.
