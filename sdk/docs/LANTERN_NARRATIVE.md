# Lantern narrative and source review

## 2026-11-08 v3 choice consequences and reachability repair

The canonical story is now `story.version: 3`. The v3 follow-up adds two facts, `roof_log_read` and `memory_recorded`, and consumes existing `storm_pressure`, `relay_locked`, `letter_seen`, `letter_protected`, and `ren_trust` at later narrative points. It adds no third copy of a clue, trust, or ending state. Old v1/v2 saves can lack the two new facts; absent values are treated as false, with no attempt to infer a player's earlier intent from active location or dialogue history. Revision migration uses separate direct v1→v3 and v2→v3 address maps; no intermediate story is retained.

### Source-first basis and verification

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding `pocket_host/`, contains no visual-novel interpreter or Lantern story source. The reusable UI precedents are generic: `lib/render/pocket_ui_components.dart` renders text, dispatches `Focusable` and `View.ActionButton` input, and uses `ListView.separated`; `mini_apps/app_ui_showcase/main.js` demonstrates JS-authored composition and action dispatch, not VN labels, replay state, dialogue history, or branching. The single canonical `demo/js/apps/lantern/story.json` and the existing `pocket_vn` engine remain the implementation.

The v2 source had six `add_memory_*` dialogue instructions after an unconditional `return`, so those lines could never display. V3 moved the two existing follow-up lines before the return in each of `memory_trust`, `memory_protect`, and `memory_record`. Their IDs and exact text are unchanged; this is the only old-instruction reordering, allowed explicitly for those three labels by the revision-map generator. The original `dial_check` branch, 7–1–4 requirements, ending IDs, and timed choice instruction remain unchanged.

Pinned Bun 1.4.4 verification:

```sh
cd demo/js
../../sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test \
  apps/lantern/story.test.ts apps/lantern/localization.test.ts
```

Result: **22 tests passed, 0 failed, 1,410 assertions**. The real engine walks the lens-only route through a later relay log read, verifies the Ren trust and storm-pressure echoes, carries envelope protection and memory-record facts to the timed decision, exercises the six formerly unreachable lines, checks the 714 success and second-failure lockout paths, and retains all three endings and the 16,000 ms timeout path. English catalog diagnostics found no missing say lines or mismatched placeholders. That source-validation subtask did not build a Guest/QJBC or run Flutter; the integrated release evidence follows below.

The current story source SHA-256 is `b7c1dfb56b9d94d3b111901d0a6d8840a1a2d65b3364639a0118e6298b4b080b`; the English locale source SHA-256 is `99f4ba6975b7fa4d4b3b6d617594329f5ab82d81eb5b81744282448f7db9a449`.

### Integrated v3 release evidence

The final pinned Guest is QJBC `57ba6efd…` / PAK `bcbe0d4c…`; exact hashes and source identity are in `sdk/.pocket-build/lantern-v3-causal-20261108/release-artifacts.json`. Actual bytecode inputs pass the full three-ending/timeout/save/load/rollback route (`/tmp/pocket-lantern-v3-route.log`, maximum observed slot 58,885 B), both real v1/v2 save migrations (`/tmp/pocket-lantern-v3-migration.log`), and three layout/choice/input cases (`/tmp/pocket-lantern-v3-input-layout.log`). The ordinary macOS Profile Demo was rebuilt from the same Guest and started as PID 39223 without the Editor backend; Metal/VM readiness and activation request are verified, foreground pixels were not independently captured. These results do not complete physical-device, Windows, media-playback or full performance acceptance.

### Current source counts

Counts follow the static label closure from `script.start`, following `jump`, `call`, both `branch` arms, every choice target, and `timeoutTarget`. They include alternatives in the reachable route graph, not just a single playthrough. The optional `archive_reel_entry` is excluded from the main-story target; the isolated `feature_tour*` and `model_showcase*` labels are not reachable from `start`.

| Portion | Reachable labels | `say` | Chinese Han characters |
| --- | ---: | ---: | ---: |
| Main story, excluding the optional `archive_reel_entry` reel | 71 | 218 | 9,961 |
| Full `start` closure, including that reel | 72 | 220 | 10,064 |

The 12 stable decision IDs in the mainline acceptance table have 40 options. The story also contains the separate `dial_retry` control choice, with three options; it resets, revisits clues, or abandons the dial. Thus the reachable mainline currently has 13 authored choice instructions and 43 options total. The reachable source totals exceed the target of 200 `say` instructions and 8,000 Chinese narrative characters. These are source counts, not a claim of Guest or platform acceptance.

### Decision, puzzle, and ending audit

Each of the 12 tracked decision nodes now has at least two options with later state consumption or a distinguishable scripted consequence. The table records what the route actually does; some alternatives still converge deliberately on the same puzzle result or ending gate.

| Choice ID | Later state or observable result |
| --- | --- |
| `arrival_approach` | `listen_mira` marks `memory_seen`, which selects first versus repeat memory dialogue; `ask_ren` feeds the later `ren_trust >= 2` relay response; `check_seal` records `letter_seen` and increments `mira_trust`, which enables `send_truth`, then receives an unopened-envelope acknowledgment. |
| `investigation_hub` | Archive, clock, and roof routes supply the three `found_*` facts required before relay; memory branches; the return-address path stores actual typed values; the direct train option bypasses investigation and reaches the timed choice without truth eligibility. |
| `archive_read` | Copying the chart sets `found_route`; asking Mira enters the memory branch and then the route record; leaving returns to the hub; the optional silent reel remains an observable side path without falsely setting evidence. |
| `clock_test` | A single pulse sets `found_clock`; the second pulse increments `storm_pressure`, later acknowledged before the timed choice; asking Ren contributes to the later trust threshold and then runs the single-pulse verification. |
| `roof_inspection` | Reading the log sets `roof_log_read`; lens-only inspection leaves it false, so the later relay explicitly opens and records the tide-log minute before its existing relay explanation. Asking Mira still reaches the memory branch. Both valid evidence routes preserve the same minute clue and relay gate. |
| `memory_response` | Trusting Mira increments `mira_trust`, which gates `send_truth`; protecting the envelope is acknowledged later via `letter_protected`; keeping a record sets `memory_recorded`, which is confirmed before the final choice. The three response labels each display their two authored follow-up lines before returning. |
| `memory_repeat_response` | `affirm_mira` increments the truth-ending trust gate; `return_quiet` records the evidence via `memory_recorded`, then confirms its later use. |
| `relay_open` | Opening starts the dial; revisiting returns to the evidence hub; skipping reaches the timed endings without setting `proof_complete`. |
| `dial_one` | Writes the first player-selected dial value, consumed by the unchanged 7–1–4 check. |
| `dial_two` | Writes the second player-selected dial value, consumed by the unchanged 7–1–4 check. |
| `dial_three` | Writes the third player-selected dial value, consumed by the unchanged 7–1–4 check. |
| `signal_window` | `send_truth` still requires `proof_complete` and Mira's trust; train and shelter retain their distinct endings. The unchanged 16,000 ms timeout evacuates and continues to the train ending. |

The successful puzzle still requires `found_route`, `found_clock`, and `found_lens`, then checks `dial_1 = 7`, `dial_2 = 1`, and `dial_3 = 4`. Failed attempts increment `code_misses`; the second failure locks the relay. `storm_pressure` and `relay_locked` now add a state-specific explanation without extending the 16-second window or changing the three options.

The three ending IDs remain distinct in both cause and outcome: `truth_letter` returns an evidence-backed reply to the past and sends Mira back to her future; `last_train` lets Mira travel to seek her mother and younger self while Ren receives no reply; `keep_the_light` evacuates the station, destroys the relay, and strands Mira in this night. No ending ID, target, or eligibility rule changed.

The current audit still identifies write-only story values: `investigation_count`, `route_digit`, `pulse_digit`, `minute_digit`, and `timed_out` have no later story condition/interpolation reader. They remain untouched in v3 to avoid changing more legacy instructions and the established dial/timeout contracts; they are not claimed as consumed state. `letter_seen`, `letter_protected`, `ren_trust`, `storm_pressure`, `relay_locked`, `roof_log_read`, and `memory_recorded` do have later readers.


## Historical v2 and model-theater notes

The following notes preserve older story snapshots. They predate the v3 choice follow-up above and are not the current source counts or validation results.

## Source and scope

The retained parent at `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding `pocket_host/`, has no Lantern or visual-novel story source. The retained files relevant to the old app shell are `lib/core/pocketjs_bundle_runner.dart`, `lib/ui/mini_app_host_page.dart`, and `mini_apps/app_ui_showcase/main.js`; they demonstrate PocketJS app loading and UI composition, not a story to migrate. The new content therefore stays in the Showcase consumer.

The earlier text-only revision changed dialogue, choice prompts/options, and English catalog text without changing the mainline's 67 dialogue IDs or 13 choices. A later, optional model theater was appended as independent script labels and one public replay entry. The earlier snapshot counts below predate the 2026-11-07 narrative expansion. These statements describe that earlier snapshot; v3 adds story facts and new say IDs, and moves six previously unreachable memory lines before their returns as documented above.

## Earlier model-theater snapshot (historical counts)

Counts are derived from the current `story.json` script. “Instructions” includes every authored instruction, including scene, video, and jump commands.

| Script portion | Labels | Instructions | Dialogue (`say`) | Choices |
| --- | ---: | ---: | ---: | ---: |
| Existing main story | 53 | 213 | 67 | 13 |
| Optional model theater | 11 | 39 | 10 | 3 |
| Story total at that historical checkpoint | 64 | 252 | 77 | 16 |

The gallery's `model_showcase` replay has no ending unlock requirement and starts in its own replay engine. It does not modify the parked main story save. The trial shows the original Mira Spine model and the official Hiyori Live2D sample. Mira has idle, alert, and settle options; Hiyori has Idle:0, Idle:1, and TapBody:0 options. Each of the six action branches sets its model scene, closes any stage video, displays a short localized line, and returns to that model's action choice when the player continues. The model choice overlays are therefore not the only display state: the short say state gives the animation a clear unobstructed moment. Returning to the showcase catalog hides and clears the trial models. The replay header can return to the main journey at any time.

The six action display line IDs are `model_showcase_mira_idle_display`, `model_showcase_mira_alert_display`, `model_showcase_mira_settle_display`, `model_showcase_hiyori_idle_0_display`, `model_showcase_hiyori_idle_1_display`, and `model_showcase_hiyori_tap_body_display`.

The Hiyori sample remains identified as a third-party sample, not a Mist Harbor story character or original asset. The exact Live2D Inc. attribution is stored under `model_showcase_hiyori_attribution` in the story and both locale catalogs.

## Timeline and relationship

| Time | Ren | Ren’s sister | Mira |
| --- | ---: | ---: | ---: |
| T−20 | 8 | 6 | Not born |
| T−4 | 24 | 22 | Born |
| T | 28 | 26 | 4 |
| T+20 | 48 | 46 | 24 |

Ren’s sister is Mira’s mother. The letter is written by the sister at T+20 and addressed to Ren; the sender line is blank. Adult Mira travels from T+20 back to T, where her four-year-old self and twenty-six-year-old mother also exist. `arrival_mira_01` distinguishes the recipient from the sender before `roof_mira_01` reveals the relationship. Ren’s memory now makes him eight at the old storm rather than an implausibly newly hired adult.

## Earlier story revision notes

- **Opening:** At 23:08, the 23:14 ticket clock moves backward even though the relay lens is locked away. The unchanged, voiced `arrival_02` then gives the impossible postmark in Mira’s own words. The following lines establish the last-train deadline and Ren’s denial without explaining away the anomaly.
- **Investigation:** The route chart, bell box, and tide log each provide one independent clue. The text no longer repeats the full 7–1–4 sequence in every setup line. The old route points to the receiving hut; one chime confirms and the second drops the safety gate; the tide log, rather than the stopped clock, supplies the minute check.
- **Dial readability:** The nine dial options now keep the digit and only a short role label (`收信路` / `Mail route`, `单响确认` / `Confirm`, `分钟末位` / `Minute digit`). Their longer explanations remain in the adjacent story line and prompt. Each wheel still has its own meaning—route, pulse, or minute—and the tempting wrong digits remain visible for deduction.
- **Reversal:** Ren remembers ringing twice at age eight and taking the silence for a loss. The records and his sister’s recollection show that the first beam was seen, the second chime closed the line, and his six-year-old sister survived. She did not know the child at the station had rung for her.
- **Endings:** Sending the reply resolves the childhood silence but closes Mira’s route back to this night. Taking the last train lets Mira seek her twenty-six-year-old mother and four-year-old self, while Ren receives no answer from the past. Sounding the alarm saves the station’s passengers but floods the relay, leaving Mira stranded at T and ending the cross-time route.

The line `archive_reel_02` keeps its established “camera drifts toward” / “镜头慢慢靠近” wording. `arrival_02` is unchanged in both Chinese and English, so its existing voice cue still matches the catalog.

## Validation and remaining compatibility boundary

The following results are historical for the earlier text-only story revision; they do not describe v3 or represent platform acceptance of later changes.

Targeted SDK tests passed with:

```sh
cd sdk
npm exec --yes --package=bun@1.4.4 -- bun test --max-concurrency=1 \
  packages/pocket_vn/test/authoring.test.ts \
  packages/pocket_vn/test/localization.test.ts \
  packages/pocket_vn/test/replay.test.ts
```

Result: 16 tests passed. A one-off check also constructed the Lantern engine from the current JSON and ran English locale diagnostics against the current asset registry; the story was accepted and diagnostics were empty. All 67 story dialogue IDs have English lines, and the 13 English choice catalogs match the stable option IDs.

At that earlier snapshot, the Lantern story and locale checks also passed:

```sh
cd demo/js
npm exec --yes --package=bun@1.4.4 -- bun test \
  apps/lantern/story.test.ts \
  apps/lantern/localization.test.ts
```

Result at that earlier snapshot: 12 tests passed (525 assertions). The video integration driver waited for the revised `truth_01` text; the save-capacity driver still waited for the unchanged Chinese ending instruction text. No Flutter build was run for that text-only task.

At the old text-only snapshot, script positions were still unchanged. Subsequent revisions inserted instructions, and v3 also moved the six dead memory lines described above. Current story version and v1/v2 save compatibility are recorded in the v3 section at the top. The same-ID active-dialogue copy-edit behavior remains documented in [Visual Novel Engine](VISUAL_NOVEL_ENGINE.md#resuming-after-a-dialogue-copy-edit): it can rebase Unicode reveal progress after an address resolves, but does not replace the revision maps.
