# Visual novel rollback and persistent-meta acceptance

## Latest v5 recheck, 2026-11-08

The same actual route passed again against the isolated Lantern v5 Guest `f40f9d690e6621f98ac69ce0d505fa8c6ae741cc984fec612361ef9342d3167a` / PAK `339305235efc0b42f98853f6f046a343929533fd30bbea83b738c6817eb8e47f`. Unlike the historical v4 run below, v5 declares persistent collection flags: this route carries `record_seal: true` from the manual save through ending unlock, older-slot load, rollback, and replay. The regression now checks that every previously present persistent key remains present and equal, in addition to the existing monotonic metadata and replay write-isolation checks. The previous assertion requiring an empty persistent-variable map was removed because it described the v4 fixture, not an engine invariant.

The rollback/meta and replay tests both passed (2 tests, 0 failures); log `/tmp/pocket-lantern-v5-native-regression-20261108.log`. The replay test now reveals the Gallery action by real pointer scrolling in the clipped title menu and honors explicitly supplied Guest artifact paths. This remains actual QuickJS/Core execution with injected process-local storage, not Flutter disk-durability acceptance. The v4 values and source hashes below describe the historical run only.


## Source-first reuse

The retained `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` tree was inspected with `pocket_host/` excluded. Its closest gameplay example is `mini_apps/app_game_detail/main.js`: JavaScript owns mutable hero/boss state and updates it from `onUpdate(dt)`, while the file does not define a narrative save, read-history set, or dialogue rollback checkpoint. A targeted search across the retained `mini_apps/`, `lib/`, and `docs/` sources found no VN save/load/checkpoint implementation. The older `pocket_syslib_ota.js` rollback applies to system-library versions, not gameplay state. There was no narrative persistence behavior to port.

The acceptance therefore exercises the existing Pocket VN path through the compiled Lantern app. `demo/js/apps/lantern/app.tsx` reads and writes slots through `createNovelSlotManager` and the existing `platform.storage` boundary, encodes saves as V4, and creates replay with `createNovelReplayEngine`. No Dart persistence state or second story runner is involved.

## What the regression proves

`demo/js/tests/novel_rollback_meta_native.test.ts` drives the real Lantern title, dialogue, choices, save/load panel, rollback control, ending screen, and gallery replay through `NativeSession`. It follows the existing `readNativeArtifacts("POCKET_LANTERN")` default paths and `NativeSession` probe resolver, so it works with the normal Lantern build. An explicit `POCKET_LANTERN_GUEST_*` environment can select a frozen candidate for reproducible acceptance; the final run below selected the isolated PMS1 candidate and did not consume or replace `demo/assets/apps/lantern`.

The sequence first creates a manual save at the real `signal_window` choice after the `check_seal` route. That save has `letter_seen: true`, `mira_trust: 1`, a `roof` stage, and `roof_gust` ambience. It then completes the actual `last_train` ending, returns to the title, and loads the older manual slot. The test compares restored variables, complete stage, and audio intents against the decoded manual save. It presses the real rollback toolbar control and compares variables, stage, and audio intents against the latest decoded dialogue checkpoint in that saved history. It then continues through the choice and reaches the ending again.

The same run checks that the older load and subsequent rollback retain all previously accumulated `readLineIds`, `endingIds`, `cgIds`, `musicIds`, and explicit `persistentVariables`. Lantern has no declared persistent variables, so `persistentVariables` is `{}` at every checkpoint; this route proves persistent progress metadata monotonicity, not a nonempty persistent-variable value. The variable-lifetime unit tests separately cover nonempty persistent values through load, rollback, and `newGame()`.

After the second ending, the test opens the actual title gallery, scrolls its clipped title menu with pointer input, and plays the unlocked train-ending replay. It compares the main autosave as deep JSON before and after replay, and verifies that `NativeSession` saw no additional `platform.storage.set` or batch write for `lantern.slot.auto`. The JSON comparison is structural, not a byte-for-byte serialization claim.

## Observed values

| Capture | Read IDs | Endings | CGs | Music IDs | Persistent variables |
| --- | ---: | --- | --- | --- | --- |
| Before the ending | 32 | `[]` | `[]` | `[music_storm]` | `{}` |
| After first ending | 41 | `[last_train]` | `[dawn_departure]` | `[music_storm, music_dawn]` | `{}` |
| After loading the older slot | 41 | `[last_train]` | `[dawn_departure]` | `[music_storm, music_dawn]` | `{}` |
| After rollback | 41 | `[last_train]` | `[dawn_departure]` | `[music_storm, music_dawn]` | `{}` |
| After reaching the ending again | 41 | `[last_train]` | `[dawn_departure]` | `[music_storm, music_dawn]` | `{}` |

Before the ending, read IDs comprise `arrival_01`–`arrival_05`, `add_start_01`–`add_start_10`, `arrival_seal_01`, `add_seal_01`–`add_seal_06`, `arrival_seal_02`, `hub_01`, `window_01`, `window_02`, `add_signal_01`–`add_signal_05`, and `v3_signal_letter_noted`. Completing the ending adds `train_01`–`train_04` and `add_train_01`–`add_train_05`. The full captured arrays are in the run log.

The saved and loaded pre-ending state has `background: roof`, a stationary camera at `{x: 0, y: 0, scale: 1}`, Mira and Ren in their worried poses, and channel intents `music_storm`, `roof_gust`, and one-shot `station_bell`. The completed ending changes the background to `dawn`, music to `music_dawn`, and SFX intent to `train_depart`. Loading the older slot restores the former state. Rollback restores the exact saved checkpoint at `v3_signal_letter_noted`, including its roof composition, camera motion at `elapsedMs: 800.0000000000003`, and pre-ending channel intents. The variable object is equal at each tested load/rollback boundary; the route explicitly sets `letter_seen: true` and `mira_trust: 1`.

## Runtime paths and existing coverage

- `sdk/packages/pocket_vn/src/engine.ts:187` unions read, ending, CG, and music IDs during meta merge; explicit persistent-variable values in the current engine take precedence over values from an older save.
- `sdk/packages/pocket_vn/src/engine.ts:1211` records music unlocks and requested channel intents when authored audio instructions execute. `engine.ts:1278` records ending and CG unlocks, and `engine.ts:1294` marks a line read when it is committed to backlog.
- `sdk/packages/pocket_vn/src/engine.ts:1307` stores completed-dialogue rollback state, including regular variables, stage, and audio intents. `engine.ts:1428`–`1478` validates a loaded save and merges its meta with the engine's current meta. `engine.ts:1708`–`1723` restores checkpoint state while leaving meta intact.
- `sdk/packages/pocket_vn/src/replay.ts:16` constructs an ordinary replay engine from copied source variables/meta/preferences and checks its unlock condition. Lantern's `app.tsx:193` starts that isolated engine; `app.tsx:233` keeps autosave work bound to the main engine.
- Existing `demo/js/tests/novel_native.test.ts` covers real route completion and a basic UI rollback. `novel_save_codec_native.test.ts` covers the V4 save boundary and a loaded rollback in QuickJS. `novel_replay_native.test.ts` covers unlocked replay and unchanged main autosave. The new test supplies the missing cross-operation proof: ending unlock → old-slot load → rollback → repeated unlock → replay on the same native Guest session.

## Validation and limits

The test passed with pinned Bun 1.4.4 and the pinned `retina-native-tools-20261108/bin/pocket_probe`:

```sh
POCKET_NATIVE_PROBE=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/retina-native-tools-20261108/bin/pocket_probe \
POCKET_LANTERN_GUEST_BYTECODE=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/pms1-production-ab-20261108/candidate/app.qjbc \
POCKET_LANTERN_GUEST_PAK=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/pms1-production-ab-20261108/candidate/app.pak \
POCKET_LANTERN_GUEST_METADATA=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/pms1-production-ab-20261108/candidate/app.bytecode.json \
  /Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun \
  test --timeout 260000 demo/js/tests/novel_rollback_meta_native.test.ts
```

Result: **1 passed, 0 failed**. The final log is `/tmp/pocket-vn-rollback-meta-native-final-20261108.log`; it contains exact metadata/state snapshots and the passing result. The test source checks no additional autosave-write request and first requires a nonzero pre-replay write count to avoid a vacuous no-write pass. Log SHA-256 is `db0ce07ae952658666cfd2fc0e43d04451eeebc526ae982fc82efceff1d1f0e5`. Final test source SHA-256 is `c83af3b6f67ba4b8a08cf74d2340eaeebbc106c11613c790752fcc49cb9fc236`. The selected Guest SHA-256 is `396b07fcebbfc2c74915b220fd685f3fa276fb4f2b3ec900d51a5987158b6329`; matching PAK SHA-256 is `3d775a1fc3e773d17d73d3d45e73618adbd2a2fa52d5d4785e839fc7bcf48876`; runtime ABI is `quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021`. The top-level test source does not lock these artifact hashes; it records the hashes used by each run.

`NativeSession` executes the actual pinned Guest and real Pocket VN/UI code, but its `platform.storage` response uses a process-local injected map. This test establishes guest storage-protocol behavior and engine semantics; it does not establish disk durability or a Flutter host integration result. The tested engine behavior matched the save/load/rollback invariants; no production defect was found. No engine or Lantern story source was changed, and no Flutter command was run.
