# Visual novel save revision maps

Lantern story version 2 inserted authored instructions into existing labels. Version 3 adds causal follow-up scenes and repairs six dialogue lines placed after `return`. Old saves store instruction addresses, so loading an unchanged version 1 address could land on the wrong instruction or skip newly added dialogue. The SDK migration changes only those known script addresses; it does not keep a second story or rewrite user variables.

## Source and map

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was searched outside `pocket_host/`. It has generic app storage and hardware examples, but no visual-novel script-address migration behavior to reuse. The necessary adaptation is a small map over Pocket VN’s existing save locations.

The old canonical story was extracted from the generated `story_default` object in:

`sdk/.pocket-build/novel-highres-20261107/final-y70-guest/app.js`

The generator records both source fingerprints in `demo/js/apps/lantern/revision-map.json`:

- old `app.js` SHA-256: `5ed028c0a1adc70f2153797c6e68216817e204f265cae6b69eed5623423f3a76`
- extracted story data SHA-256: `4826aefe13592a6d6d6936e695fc7b6494f46a5a2ebd5f2d21698479e67397f8`
- old Guest QJBC SHA-256: `748913c419272953f049637630705f5d12c61ac07f8f6877372395faa1ae07fc`
- old Guest PAK SHA-256: `9fcc419358ed70f2a83ca4ef2f8808a8d1c795ff6fb2b8165e438907a2d1a1d1`

`demo/js/apps/lantern/scripts/generate_revision_map.ts` extracts and reads only that static story data literal. It does not execute the old app bundle. It requires every old instruction to match exactly and in order in the new same-named label by default. The explicit `--reordered-labels` option permits exact, one-to-one matches in a different order only for named labels. The output contains 70 label index arrays, not a second copy of the script. Each array’s final entry is an explicit end-of-label address sentinel, because a saved next-instruction cursor or caller return address can equal the old label length.

Regenerate from the retained artifact and the current story by running this from `demo/js/apps/lantern`:

```sh
bun scripts/generate_revision_map.ts --reordered-labels memory_trust,memory_protect,memory_record
bun scripts/generate_revision_map.ts --legacy-app ../../../../sdk/.pocket-build/lantern-v2-v4-final-20261107/app.js --out revision-map-v2.json --reordered-labels memory_trust,memory_protect,memory_record
```

The generator rejects a changed story identity, a non-upgrade version pair, a missing label, any unmatched old instruction, duplicate/unknown reordered label names, or a reordering outside the explicit allowlist. Version 3 only reorders the three memory labels: their two old `add_memory_*` lines move before `return` instead of remaining unreachable. It keeps their IDs and text and does not copy them into a second runtime script.

`revision-map.json` maps all 70 old v1 labels directly to v3. `revision-map-v2.json` maps all 78 v2 labels directly to v3. The v2 source is the frozen release `app.js` (SHA-256 `9d07c142410058295bc88b9367803ec5da7b0c8e9b35427b260bcb463c60865e`); its canonical extracted story digest is `db616b917644168486e7922607dd9d6db09f6ee9b183a6cf1c9e4661b8303d35`. The consumer selects the source map from the stored story version; it does not load or retain an intermediate story. Current-version saves follow the existing no-migration path.

## Runtime behavior

`migrateNovelSaveRevision(value, revisionMap, targetStory)` accepts expanded V1 and compact V2, V3, and V4 saves. V4 shares rendered text between backlog and rollback records; the codec expands that representation before the same address migration runs. It checks the story ID, source/target versions, every mapped label/index, unique target addresses and the final end sentinel. Target indexes need not increase: explicit reordering is needed to repair the old unreachable dialogue. Duplicate targets, out-of-range indexes and an early end sentinel still fail. It remaps only `state.location`, active instruction locations, call/return addresses, backlog locations, and the corresponding rollback-checkpoint addresses. A save with an active instruction gets `state.location = active.location + 1` after mapping; this preserves a newly inserted line between the active instruction and its former successor.

The function validates the migrated record by loading it into the same target story engine, then disposes that validator. It returns the migrated in-memory save without writing the source slot. Invalid or unsupported versions fail explicitly and leave the stored save untouched. Lantern applies the migration before locale rebasing in its existing `storage.read` adapter; the normal engine load remains the authoritative validation when a save is restored.

Values with address-like shapes inside player variables are never traversed. The unit tests cover nested such values, active input drafts, call stack, backlog, rollback checkpoints, explicit V3 decoding, V4 shared-text-pool decoding, end-of-label addresses, malformed maps, and resuming at an inserted say after an active input. The Lantern story/localization tests cover current story structure and locale diagnostics.

## Native evidence and release boundary

The real NativeSession migration case passed in `/tmp/pocket-lantern-v2-tour-migration-native.log`. It loaded the captured version 1 save with an active choice, a caller return address, eight backlog entries, and eight rollback checkpoints, then exercised rollback and call return under the version 2 Guest. Root recorded the tested Guest prefixes as QJBC `ff7373d0` and PAK `d499c3e7`. That run's separate tour test still failed because its driver clicked during a scene fade; the driver now waits for the rendered full-screen fade layer to settle and tests the same visible center afterward. This is separate from save migration correctness.

The current feature-tour NativeSession run passed all three cases in `/tmp/pocket-lantern-v2-v4-final-tour.log` with pinned Bun 1.4.4. It used QJBC SHA-256 `06656d13ac04a7ceec9931b79c0933dbe6f2b513d48137ca4ba4cb3c6f3e7694` and PAK SHA-256 `d499c3e7152d42d28bfbcefc1dcc970c62e5f58f36216510fea5d404aa19e323`. On both 390×844 and 1280×900, the test entered the tour, used the painted hotspot center to reach the actual registered relay-dial image, and used the painted `7` center to reach its authored feedback and return to the hub. A touch during the fade was consumed; after the veil settled, the same visible center selected the hotspot. The title-isolation case seeds the captured nonempty version 1 autosave and compares its serialized bytes before and after entering and exiting the tour. The phone feedback wraps across text draw operations, so the driver compares normalized painted text without whitespace rather than requiring one draw operation.

The final v2 release independently re-read the v1 fixture in `/tmp/pocket-lantern-v2-v4-final-migration.log`; its full-route large-save acceptance is separately recorded in `/tmp/pocket-lantern-v2-v4-final-route.log` (maximum 60,295 bytes). The new v3 address-reordering SDK regression passes with the other migration cases: 5 tests / 58 expectations in `/tmp/pocket-v3-save-reorder.log`. It restores an active input before a formerly premature return, reaches the repaired dialogue, returns to its caller and rolls back to that dialogue; duplicate maps fail without changing the original save. The final v3 native dual-fixture and full-route acceptance below supplies separate release evidence.


## Version 3 native release evidence — 2026-11-08

Both real captured saves passed under the same final v3 Guest in
`/tmp/pocket-lantern-v3-migration.log` (2 tests). The v1 active choice moves
from `memory_first_visit:3` to `:8`; the v2 active say moves from
`memory_record:0` to `:1`. Their caller return remains correctly mapped to
`arrival.listen_mira:8`. Actual pointer input resumes, rolls back to
`memory_02`, reaches the original `memory_response` choice, selects
`trust_mira`, then returns to `investigation_hub` with an empty call stack.
The test preserves original variables, read IDs, backlog, rollback history,
audio and ending/CG metadata. Missing new narrative facts in old slots are
not invented from past dialogue or author variable shapes.

The final complete native route also passes in
`/tmp/pocket-lantern-v3-route.log`: save/load, rollback, seen-only skip, all
three endings and timeout. Its maximum observed V4 slot is 58,885 UTF-8
bytes, preserving 48 rollback active tuples; this is an observed route
maximum, not proof of every possible authored save size or physical-device IO.

Final QJBC: `57ba6efd2632292c58c1ff3858b61ee21615e490d5266d8517d5d4e861be511c`; PAK: `bcbe0d4c8c3a32919209c5ffa91980f1a3c7a658955aed7c998c6535196b357b`. The matching artifact facts are preserved in `sdk/.pocket-build/lantern-v3-causal-20261108/release-artifacts.json`. SDK tests passed 148 / 1,294 expectations. These NativeSession results establish pinned JS execution and host-boundary interaction, not physical-device lifecycle or real media playback.
