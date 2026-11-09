# Live2D viewport / DPR evidence, 2026-11-08

## Current v4 scaled candidate

The current candidate uses Lantern story v4 source SHA-256
`aa21d89ce244df20346d55a06afa3664f0a8a511157bd71b02479328d1ce97e9` and the
same 69,193,344-byte PAK as its unscaled control (SHA-256
`8126d148c8f71d573dbae11927647150d8d96922f88bab48074d018299369c08`). The
candidate QJBC SHA-256 is
`e03750c154c8fcaa4ef8b05f37f314a09e2e754ed628a249360c9c406b3bc176` (1,073,341
bytes). The unscaled control is `956171bafcf69da674d340f848b78ca5d68e2837350f5341215ca3204422bda3`
(1,073,161 bytes). The story, app source and PAK match; the candidate contains
the SDK canonical-frame `artScale` transform. The 72 MiB PAK allowance is
Lantern-specific in both its JS system catalog and trusted Dart policy; it is
not a general SDK/native limit or a resident-memory result.

All four macOS arm64 Profile test-view runs passed with the real Live2D Core.
Each captures both a full-body and closeup pose; measured width is the
conservative connected visible-skin component in the closeup:

| Logical viewport | DPR | PNG pixels | Visible-skin width | Run | Log |
| --- | ---: | --- | ---: | --- | --- |
| 390×844 | 1 | 390×844 | 114 logical px | Passed, 50 s | `/tmp/pocket-model-v4-scaled-390-dpr1.log` |
| 390×844 | 2 | 780×1688 | 115 logical px | Passed, 50 s | `/tmp/pocket-model-v4-scaled-390-dpr2.log` |
| 1920×1080 | 1 | 1920×1080 | 142 logical px | Passed, 51 s | `/tmp/pocket-model-v4-scaled-1920-dpr1.log` |
| 1920×1080 | 2 | 3840×2160 | 142.5 logical px | Passed, 54 s | `/tmp/pocket-model-v4-scaled-1920-dpr2.log` |

The measured phone values exceed the ≥70 logical-pixel target and desktop values
exceed ≥100 for this candidate. The same-story, same-PAK unscaled control
measured 106 logical pixels at desktop DPR1, versus 142 with the canonical
viewport transform. This is a framing comparison: animated poses are not
pixel-registered and the connected-skin metric is not a whole-head detector.
The DPR2 closeups were visually checked; Hiyori remains an identified official
sample, not original Lantern character art. The full-body images were captured,
but full-body composition quality, all model states, Windows, physical devices,
20-cycle stabilized memory, whole-game performance and cold start remain open.

The exact QJBC/PAK metadata (`release-artifacts.json`), eight PNG hashes
(`captures.json`), four face measurements, and per-run log/pixel acceptance
checks (`acceptance.json`) are preserved in
`sdk/.pocket-build/lantern-v4-scaled-20261108/`; the central frozen acceptance
record is [Lantern v4 acceptance](LANTERN_V4_ACCEPTANCE.md). The test uses
Flutter test-view metric overrides. It does not establish physical-phone
behavior, OS window resize/rotation or monitor DPI.

## Historical v3 Gallery Guest artifact

The existing `demo/integration_test/novel_model_showcase_test.dart` now accepts
`POCKET_MODEL_WIDTH`, `POCKET_MODEL_HEIGHT`, and `POCKET_MODEL_DPR` and captures
at the actual test-view DPR. It logs the logical viewport, physical PNG size,
actual model canvas dimensions, and bundled bytecode metadata as
`POCKET_MODEL_CAPTURE`. It continues to exercise the real Cubism Core,
2048-square PAK decoding, masked animated geometry, pause/resume, handle
release, and isolated persistent storage. No alternate renderer is used.

All four runs use macOS arm64 Profile with the same frozen Gallery Guest:

- QJBC SHA-256: `9f43216420f00233df74bbf8bbb45ab75d6abc26aa19e679209d98091102bf54` (1,064,243 bytes).
- PAK SHA-256: `6e5c872a953ada2bea145dca7fcabb4dc716522fbb6784fa1adaa32826fe7128` (60,758,640 bytes).
- Bundled source SHA: `3fa0ee2c9cf146d0200ee6709e472225bf85462c12c05f0b73cc0e9cae23845b`.
- Bundled payload SHA: `6ff4c6ce285acf52874c169d065fa70871d37c05d37fe256b29a69d62f8f3e4e`.

These are Flutter test-view metric overrides. They do not establish actual OS
window resize, monitor DPI, physical phone acceptance, or foreground window
position. `flutter drive` can fail its foreground activation request while the
integration driver still attaches and verifies rendered frames.

## Historical v3 matrix

| Logical viewport | DPR | PNG pixels (full + closeup) | Real Core test | Log |
| --- | --- | --- | --- | --- |
| 390×844 | 1 | 390×844 | Passed, 49 s | `/tmp/pocket-model-390-dpr1.log` |
| 390×844 | 2 | 780×1688 | Passed, 50 s | `/tmp/pocket-model-390-dpr2.log` |
| 1920×1080 | 1 | 1920×1080 | Passed, 50 s | `/tmp/pocket-model-1920-dpr1.log` |
| 1920×1080 | 2 | 3840×2160 | Passed, 54 s | `/tmp/pocket-model-1920-dpr2.log` |

Actual model canvases match each logical viewport. PNGs are written under the
macOS app container's `Data/tmp/model-Hiyori-{full,closeup}-{width}x{height}-dpr{dpr}.png`;
the integration log records their full paths. All eight original PNGs are also
preserved with SHA-256 `captures.json` under
`sdk/.pocket-build/novel-model-density-20261108/`; use those immutable copies
after a later run replaces same-named temporary captures. The ordinary playable Demo runs
from its independent cache and is not overwritten by these integration builds.

## Historical findings before v4 scaling

The phone closeups at DPR 1/2 show eye, mouth, hair and translucent edges. The
original 2048-square source textures are retained. Hiyori remains an explicitly
identified official sample, not original Lantern character art.

A manual face ROI followed by the largest four-connected bright-skin component
(sRGB R≥235, G≥210, B≥170) gives a conservative visible-cheek width. This is a
measurement of these captures, not a general face detector or an exact head
bounding box. Phone DPR 1 is 90 logical pixels (ROI 105,300–228,400), phone DPR 2
is 90.5 (ROI 200,600–470,790), and desktop DPR 2 is 90.5 (ROI
1540,650–1810,850); desktop DPR 1 is 90 (ROI 770,325–905,425). The phone lower bound passes ≥70. The desktop measurement
does not establish the required ≥100; the desktop framing gate remains unmet.
The analysis script and JSON are retained in the ignored local evidence cache
`sdk/.pocket-build/novel-model-density-20261108/`; no source PNG was modified.

Visual inspection also finds the full-body pose too small and apparently
floating. Restoring texture resolution alone therefore does not complete the
art-quality gate. Model-fit / composition changes must be reviewed against the
existing canonical transform and save compatibility, then rerun this matrix.
Stable 20-cycle memory, whole-game frame budgets, Windows, and physical mobile
devices remain separate unfinished gates.

## Reproduction

From `demo/`, use the pinned Flutter installation and unset any external native
library override. Repeat serially for each width/height/DPR tuple:

```sh
env -u POCKET_NATIVE_LIBRARY flutter drive --profile --no-pub \
  --dart-define=POCKET_MODEL_WIDTH=390 \
  --dart-define=POCKET_MODEL_HEIGHT=844 \
  --dart-define=POCKET_MODEL_DPR=1 \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/novel_model_showcase_test.dart -d macos
```

Keep the QJBC, PAK, and metadata together and verify hashes before comparing
captures. This functional density matrix is not a performance A/B experiment.
