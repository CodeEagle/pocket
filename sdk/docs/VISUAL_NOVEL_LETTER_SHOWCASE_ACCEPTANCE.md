# Lantern letter showcase native acceptance

`demo/js/tests/novel_letter_native.test.ts` drives the authored `letter_showcase`
entry through the real pinned QuickJS Guest and `pocket_probe`. It opens the
title entry with pointer input (scrolling the title list when needed), checks
the full-screen letter, floating passage, and ordinary Mira dialogue, then
uses the visible return control. Each case starts with a parked main autosave
fixture and verifies its serialized value and autosave write count stay fixed.
The matrix covers Chinese and English at 360×640 and 1280×900. It does not use
`goto`, mutate engine state, or treat off-clip text as an actionable control.
The skin check looks for actual `art/ui/harbor-frame-refined.png`
`textureTriangle` operations.

## First native run: d139 candidate

Guest identity:

- QJBC: `d139f62dc4fb3dfd128b8efbc7bd49a068972ece17e91935fc13792ab060c3c4`
- PAK: `3d775a1fc3e773d17d73d3d45e73618adbd2a2fa52d5d4785e839fc7bcf48876`
- bytecode metadata: `7840d13dc1d07078132e5995a862100ad967b6ff9132c75c38e6327341dac540`

The first four-case run produced two passes and two failures. Both wide cases
completed all three authored passages, tapped the visible return control, and
kept the parked autosave unchanged with zero autosave writes. They observed
162 (Chinese) and 165 (English) image-skin triangles in the returned title
frame; each passage also asserted a real skin mesh while open.

Both phone cases reached the full-screen passage and successfully revealed the
complete localized text, but failed the required long-scroll assertion: the
native text operation reported height 180 inside a 424-pixel clip. The full
story text remained present in that operation, but the operation geometry did
not overflow the clip, so the test could not establish that the final paragraph
was reachable by scrolling. These two runs therefore did not continue to the
floating/dialogue/return checks. The source clue is
`pocket_ui/src/mobile.tsx`: `wrapTextLines()` returned any string containing
explicit newlines without wrapping its individual paragraphs. The test keeps
this as a failure rather than weakening its requirement.

The d139 failure exposed that multiline paragraphs were not being soft-wrapped.
The `pocket_ui` owner updated the existing `wrapTextLines()` helper to wrap
paragraphs independently while preserving blank lines. The rebuilt Guest below
was then exercised by the same four cases; the prior d139 failure remains
diagnostic evidence, not the final result.

## Rebuilt native result

The same test passed all four locale/viewport cases against this Guest:

- QJBC: `7fff89a56882c9ec943d1e2e3b3a4e9a8f869a5cc37eaede1d4acaa711381300`
- PAK: `3d775a1fc3e773d17d73d3d45e73618adbd2a2fa52d5d4785e839fc7bcf48876`
- bytecode metadata: `bb6332b2b193c8c73df8a5482fe7fce7fc8bc95a5ca094a70c2d0b14ea7f0496`
- Bun result: 4 passed, 0 failed; log archived at
  `sdk/.pocket-build/novel-letter-native-20261108/bun-test.log`.

On 360×640, the Chinese body operation measured 460 pixels high in a 424-pixel
clip and reached the bottom after one real drag. English measured 700 pixels
high in the same clip and reached the bottom after two real drags. The helper
checks the full localized body remains rendered and the final body bounds reach
the visible clip bottom before tapping the visible Continue label. On 1280×900,
the Chinese and English body heights were 260 and 320 pixels in a 676-pixel
clip, so the complete passage fit without scrolling. In all four cases the
floating line and ordinary Mira dialogue had distinct rendered text geometry,
each passage painted image-backed skin triangles, and the visible return action
restored the title. The parked autosave fixture remained exactly 9,560 JSON
bytes with zero autosave writes during the replay.

This is native Guest execution and pointer-probe evidence. It is not a Flutter
text-layout test or physical-device input result. The ignored archive also
stores the exact test/story/catalog hashes and Guest hashes for this run.

## Final keyed-scroll regression

The final Guest `b4e05229c4b70f17841fe28685a86c1b1d71e92c766416072ab0d7924db1469b`
uses the same PAK `3d775a1f…` and metadata `5451c74c…`. The final native-only
tool package is `sdk/.pocket-build/retina-native-tools-20261108`.
The five native cases passed, including the four locale/viewport combinations
above and an additional 329×600 case that scrolls the full-screen letter before
advancing to the floating passage. Log:
`/tmp/pocket-letter-native-keyed-scroll-final-20261108.log`.

The narrower regression exposed a second production issue: the previous
full-screen passage's scroll offset survived when the same scrollable component
rendered the next say. The existing say ID now keys that body subtree, resetting
its local scroll offset when the passage changes while preserving the subtree
during typewriter updates. This adds no parallel engine state or reveal clock.
At 329×600 the final full-screen sentence was visible at y=402.85, height 20;
the floating passage's first and last lines were visible at y=152 and y=192.
The parked main autosave stayed 9,560 bytes with zero writes. Flutter visual
acceptance is recorded separately; these native results do not establish it.

## Reproduction

From the repository root, use the pinned native probe and Bun:

```sh
POCKET_NATIVE_PROBE=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/retina-native-tools-20261108/bin/pocket_probe \
  /Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun \
  test demo/js/tests/novel_letter_native.test.ts
```

The test defaults to `demo/assets/apps/lantern/app.qjbc`, `.pak`, and
`.bytecode.json`; set `POCKET_LANTERN_GUEST_BYTECODE`, `POCKET_LANTERN_GUEST_PAK`,
and `POCKET_LANTERN_GUEST_METADATA` to test an isolated candidate without
changing staged assets. The probe verifies native Guest execution and pointer
input, not Flutter typography or physical device input.

## Current locale-switch regression and final Showcase

The current Showcase is `9c01ae0d…` / unchanged PAK `3d775a1f…`.
A sixth real-input test creates a new main journey, waits for partial text and
stage motion, returns to title, changes the language, then enters/exits the
letter replay. It checks parked auto-slot bytes and write count after language
change and during/after replay. The old b4e fails before replay entry; the
current candidate and all five original cases pass (6/6, pinned Bun 1.4.4 and
new native probe). See [locale checkpoint ablation](VISUAL_NOVEL_LOCALE_CHECKPOINT_ABLATION.md).
The complete four-layout Flutter route also passed with twenty screenshots;
see [Flutter acceptance](LANTERN_LETTER_SHOWCASE_FLUTTER.md). These results do
not replace physical-device or global performance gates.
