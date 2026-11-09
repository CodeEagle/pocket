# Lantern parallax Flutter pixel acceptance

Date: 2026-11-08.

Follow-up: the strict JSX candidate `8defe742…` with the identical
`8126d148…` PAK passed this same actual Profile test in 22 seconds. Log:
`/tmp/pocket-lantern-v4-strict-parallax-flutter.log`. The three PNGs were
compared byte-for-byte with the original e037 screenshots and are identical;
copies and bundle fingerprints are preserved under
`sdk/.pocket-build/lantern-v4-strict-jsx-20261108/parallax-captures/` and
`parallax-acceptance.json`. A later pixel analysis of the footer's four
characters (`已读跳过`) used the physical screenshot ROI `[648,1624,744,1654]`.
All three captures have identical four-glyph binary masks (0 differing mask
pixels) and per-cell ink counts `[102,156,189,135]`; the independent 16-bit
top-down pass counted `[94,144,172,130]` ink pixels in those same four cells.
Evidence is in
`sdk/.pocket-build/lantern-v4-strict-jsx-20261108/footer-pixel-analysis.json`
and `inspect_footer.swift`. The temporary detailed Flutter capture logger was
archived before removal at
`sdk/.pocket-build/lantern-v4-strict-jsx-20261108/novel_parallax_test.footer-diagnostic.dart`
(SHA-256 `46e7fc7d6d18e9fa1065b84786beb8bf59465358b860117c66437a333ecedb95`).
This rules out the suspected missing-glyph defect; it does not establish
general toolbar correctness or whole-UI acceptance.

This test exercises the shipped Lantern Guest through `pocketHostApp` and the
real Flutter `PocketView`/`PocketCanvasPainter`; it is not a NativeSession
DrawOp-only check. The test sets Flutter's test view to 390×844 logical pixels
at DPR 2, producing 780×1688 screenshots. Those are constrained macOS test-view
renders, not a physical phone, OS rotation, or a device resize claim.

## What the test drives

[`demo/integration_test/novel_parallax_test.dart`](../../demo/integration_test/novel_parallax_test.dart)
reuses `IsolatedNovelSupportDirectory` and `guest_interaction_test.dart`'s real
pointer helpers. It opens Lantern, starts the actual main story until the disk
auto-save reaches `arrival_01`, opens the journal and returns to the title,
scrolls the actual gallery, and launches the independent parallax replay.
Gallery scrolling is a guest pointer drag; the replay target moved from
`(156.5, 528.5)` to `(156.5, 412.3)` before settling at `(156.5, 311.6)`.

The test then uses the visible menu actions to pan, zoom, clear the layers,
restore them, and exit to the gallery. It waits for stable image geometry and
checks actual renderer output. The lamp is decoded as a 2048×1024 Flutter
`ui.Image`; both decoded overlays contain fully transparent and visible
pixels. It saves three real `RenderRepaintBoundary` screenshots, and compares
the initial and cleared screenshots inside the projected alpha bounds of each
decoded layer. The region calculation uses each actual image op's UV crop and
clip, plus its Flutter canvas placement.

The main save is read from the isolated app-support platform store immediately
before and after replay. Its serialized value is unchanged, the isolated
platform-data file exists, and the normal app-support file's bytes remain
unchanged. The replay exit also returns to the gallery that launched it.

## Result and fingerprints

Command, from `demo/`:

```sh
env -u POCKET_NATIVE_LIBRARY /Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter drive --profile --driver=test_driver/integration_test.dart --target=integration_test/novel_parallax_test.dart -d macos --no-pub
```

Result: **1 test passed**. Log: `/tmp/pocket-lantern-parallax-flutter-final2.log`.
The initial harness attempt used an unbundled loose-PNG path; Lantern images
are carried inside the Guest PAK and decoded by Flutter, so the final test
fingerprints the actual decoded renderer pixels instead. The first run also
showed the replay title was already visible in this gallery state; the final
driver performs and measures a real list drag instead of requiring the item to
start offscreen.

Frozen bundled QJBC SHA-256:
`e03750c154c8fcaa4ef8b05f37f314a09e2e754ed628a249360c9c406b3bc176`.
Bytecode metadata SHA-256:
`29872b72407b2b8687a08fcf5f6e583fe3b0e8dd150bf03886055dfff414eb17`.
Metadata source SHA-256:
`423f53544a2c6a683a658a856437486ef7593aea3b94df1c147be50cbc295799`.
Metadata payload SHA-256:
`213df1f279d77dceb3552172329350d8ab061b7d496a0c9d64decb39e3afcf24`.
The frozen PAK SHA-256 remains
`8126d148c8f71d573dbae11927647150d8d96922f88bab48074d018299369c08` as
recorded in [`LANTERN_V4_ACCEPTANCE.md`](LANTERN_V4_ACCEPTANCE.md).

Decoded raw-RGBA fingerprints from the real renderer:

- 2048×1024 lantern: `72bbc595660a004bd6d919541f03cb815ac67c3485f59936c79d74483de857f8`
- 512×512 sea mist: `14415e7518b4608fb9dacf75122b413abfe6b19c34ccc7779ea7eeb97be4ed20`

Transparent/visible decoded pixels: lantern 1,926,776 / 77,588; mist 204,615 /
39,737. Clearing changed 196,515 pixels in the projected lamp-alpha region
and 136,057 pixels in the mist-alpha region at per-pixel RGBA delta threshold
32. The draw ops for both overlays were absent after clear, remained present
after restore, and base station art stayed present.

Preserved screenshots (all 780×1688 PNGs):

| State | Temp path | SHA-256 |
| --- | --- | --- |
| Layers visible at the initial camera | `/Users/lincoln.law/Library/Containers/com.example.pocketHost/Data/tmp/pocket-lantern-parallax-p2gjRX/layers-visible.png` | `956d1dc37e1ded1f075fb5fd54c2744a221464127c85c0c7f525857bf4e373b23` |
| Camera zoom with lamp and mist still visible | `/Users/lincoln.law/Library/Containers/com.example.pocketHost/Data/tmp/pocket-lantern-parallax-p2gjRX/camera-zoom.png` | `a02446ae2136340eecc1123f1f075e8bfa7a296002ce2fe637572a420124d786` |
| Overlays cleared, station background retained | `/Users/lincoln.law/Library/Containers/com.example.pocketHost/Data/tmp/pocket-lantern-parallax-p2gjRX/layers-cleared.png` | `81da41ca587719b296b4d3cea918eaff3ac2abb72d758671e807f4f1b7c5f4d7` |

An initial visual review suspected that the bottom `已读跳过` control lost
three characters in the zoom and cleared captures. The later ROI pixel analysis
above disproves that reading: all four glyph masks are present and identical in
all three captures. Background pixels vary, so this is a glyph-mask result,
not a claim that the full screenshot regions are byte-identical. Layer pixels
pass; general toolbar/layout and whole-UI acceptance remain separate.

This validates the selected macOS Flutter renderer path and these rendered
assets. It does not measure frame rate, prove physical-device behavior, or
replace the separate native UV/geometry tests.
