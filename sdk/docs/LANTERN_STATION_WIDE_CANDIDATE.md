# Lantern panoramic station candidate

## Status and source boundary

This is a **candidate only**. The generated master and all candidate build
outputs are separate from the production runtime art, story, `novel.assets.json`,
`app.tsx`, and staged `demo/assets/apps/lantern` bundle. A real native-probe
Guest smoke is recorded below; no Flutter platform image-pixel or memory
acceptance has been run. The candidate remains for a later visual and memory
comparison before anyone decides whether to adopt it.

The source master is
[`station-wide-v1.png`](../../demo/js/apps/lantern/art/masters/station-wide-v1.png),
an exact copy of the built-in `image_gen` output at
`/Users/lincoln.law/.codex/generated_images/01a1b110-c27f-7ca2-8fca-9fda16ae1a72/exec-fe02808a-d898-4740-9901-f3180b239c9a.png`.
It is 1672×941, 2,598,834 bytes, SHA-256
`f48344c53c8f14e40a810efc197b8fe26abbe14230ba4ce96a56e97a676fe196`.
The complete generation prompt and edit-target provenance are preserved in
[`station-wide-v1.prompt.txt`](../../demo/js/apps/lantern/art/masters/station-wide-v1.prompt.txt).

The existing station master remains unchanged at 1024×1536, SHA-256
`3116e8a40c54f180a406de5dda4c9f3a75bd46f60f0d8c66fe365c5a757d3eaa`; the
existing runtime `art/station.png` remains 512×512, SHA-256
`dae9b6ece69c394794661e1cad130f28ba2728a6f9a281e2d1a211ce555be31b`.

## Retained preparation path

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was searched outside `pocket_host/`. It contains general SVG and UI art, but no
Lantern background resizing or crop pipeline to adapt. The relevant current
consumer path is `demo/js/apps/lantern/scripts/prepare_textures.ts`: it reads
`images.json`, and its ordinary raster path uses `sips -z 512 512`, which
would square this image. Its separate `sourceSize` branch pads to legal
power-of-two dimensions and is not a cover-crop operation. The candidate
therefore uses a one-off aspect-preserving crop, then the existing `buildGuest`
and PAK image path. No second renderer, asset registry, or production image
pipeline was added.

The full game story distinguishes the station wall clock, ticket clock, and
wristwatch (`story.json` lines around `clock_01` and `add_clock_05`). The new
art depicts a wall clock near midnight; it is not asserted to show the exact
23:14 ticket-clock clue. The visible dial and its story association still need
review in the target scenes.

## Candidate transform and project delta

The candidate runtime image was made from the unchanged 1672×941 master with
this operation:

```sh
cd /Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/lantern-station-wide-20261108/project
ffmpeg -hide_banner -loglevel error -y \
  -i art/masters/station-wide-v1.png \
  -vf 'scale=1024:576:flags=lanczos,crop=1024:512:0:32,format=rgba,setsar=1' \
  -frames:v 1 -c:v png -pix_fmt rgba art/station.png
```

The 16:9 source is scaled proportionally to 1024×576, then cropped 32px from
both the top and bottom to 1024×512 (2:1). It is not stretched. The crop keeps
the clock, lighthouse, signal desk, and low-contrast floor in frame in the
candidate image inspected for this task. The runtime PNG is RGBA8, 1,054,044
bytes, SHA-256
`88a70ecaccd30da989b5b6c25e481ea54fffd5a310bf8798d99dcb4b98c78328`.

Only the isolated project mirror
`sdk/.pocket-build/lantern-station-wide-20261108/project` differs from the
current consumer source:

- `art/station.png` is replaced by the candidate 1024×512 crop;
- the candidate `app.tsx` `imageDimensions` entry for `art/station.png` is
  changed from 512×512 to 1024×512. All other image-dimension entries are
  retained;
- `novel.assets.json` remains unchanged, so both `station` and
  `parallax_station` resolve to the same logical `art/station.png` resource.

## Pinned build and byte comparison

The parent buildGuest defaults to the installed packaged compiler, which in
this checkout still applies the generic 512 limit to PNG images. The first
candidate invocation failed when it reached the existing 2048×2048 Live2D
page; that was a tool-path mismatch, not a station candidate failure. The
successful runs used the already prepared high-resolution pinned tools at
`sdk/.pocket-build/highres-native-tools-20261107`, with the pinned Bun 1.4.4
binary at `sdk/.pocket-build/browser-test-bun-1.4.4/.../bin/bun`. No production
tool package was rebuilt.

For an isolated comparison, the `control/project` mirror restores the exact
current production `app.tsx` and 512×512 station PNG. Control and candidate
were compiled with the same high-resolution tool package, Bun, Guest source,
and asset set. The control PAK is byte-identical to the strict V4 PAK. The
candidate changes only the station raster and its intrinsic-dimension map.

| Build | PAK bytes | PAK SHA-256 | QJBC bytes | QJBC SHA-256 |
| --- | ---: | --- | ---: | --- |
| Strict V4 reference | 69,193,344 | `8126d148c8f71d573dbae11927647150d8d96922f88bab48074d018299369c08` | 1,073,374 | `8defe742d93c066cabbaf7e2c8f665f854c05c8ee03c40e706f1578cae9cb962` |
| Same-toolchain control | 69,193,344 | `8126d148c8f71d573dbae11927647150d8d96922f88bab48074d018299369c08` | 1,053,187 | `60668db077ebdf3f110bac8bbdfd7cf0c8847a26cfc1509ce10b5e81eb31faca` |
| Wide station candidate | 70,241,920 | `bcecc47e47c01ac4ef4f07be7d5586b6c9baf721c42f2085c40c984574ca7c1a` | 1,053,207 | `af59281dae0b4c6574324e95df37aa7f0969d382294478165379a7b976dabe2f` |

Against the strict V4 PAK, the candidate adds exactly 1,048,576 bytes. It stays
below the unchanged 72 MiB (`75,497,472` byte) Lantern cap with 5,255,552 bytes
of headroom. In the paired build, the isolated station and dimensions change
adds 20 bytes to QJBC.

The strict V4 and fresh paired-control QJBCs are **not** a one-variable
comparison: their metadata reports different generated-source hashes
(`54ad660d…` versus `028caf64…`) despite the same runtime ABI and 60 Hz tick.
The strict artifact does not retain enough build provenance to attribute that
20,187-byte QJBC difference to a specific compiler or SDK change. Do not
attribute that difference to the station image. Use the paired control for
the isolated candidate delta. Full logs and files are retained under the
ignored path `sdk/.pocket-build/lantern-station-wide-20261108/`, including
`build.log`, `control/build.log`, `compiled/`, `guest/`, and `control/`.

The successful candidate build invocation was:

```sh
cd /Volumes/ORICO/Development/Github/pocket
env \
  POCKET_TOOLS_PACKAGE=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/highres-native-tools-20261107 \
  POCKET_BUN=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun \
  POCKET_NATIVE_PROBE=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/highres-native-tools-20261107/bin/pocket_probe \
  /Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun \
  sdk/scripts/build_guest.ts \
  --project-root=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/lantern-station-wide-20261108/project \
  --outdir=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/lantern-station-wide-20261108/compiled \
  --copy-assets-to=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/lantern-station-wide-20261108/guest
```

The paired control used the identical environment and command, substituting
`.../control/project`, `.../control/compiled`, and `.../control/guest` for the
candidate paths.

## Native Guest smoke

The candidate source image and runtime crop were visually inspected, and
`buildGuest` accepted the 1024×512 image alongside the existing 2048 Live2D
textures. NativeSession executed each frozen Guest at 390×844 and 1920×1080.
All four boots reached the title, used a real pointer to start the story, opened
the journal, and returned to the title. Each active stage emitted an
`art/station.png` image DrawOp clipped to the complete viewport. The PAK entry
was parsed with the pinned compiler's `unpack()` implementation: control is
512×512 RGBA8888 (1,048,584 entry bytes) and candidate is 1024×512 RGBA8888
(2,097,160 entry bytes); both have nonempty, fully opaque RGBA payloads. Their
payload SHA-256 values are recorded in the native smoke report.

The frame protocol reports the clipped image DrawOp (the visible rectangle),
not its unclipped child bounds. Therefore the reported full-viewport DrawOp is
not by itself proof of the source image aspect ratio. The same run fed the
dimensions parsed from each real PAK entry into the production
`novelImageCoverBounds` helper and confirmed the resulting cover rectangle
preserves the source ratio and covers the viewport:

| Guest / viewport | PAK ratio | Pre-clip cover bounds (`insetL`, `insetT`, `width`, `height`) | Native image DrawOp / clip |
| --- | ---: | --- | --- |
| Control, 390×844 | 1:1 | `(-227, 0, 844, 844)` | `(0, 0, 390, 844)` |
| Candidate, 390×844 | 2:1 | `(-649, 0, 1688, 844)` | `(0, 0, 390, 844)` |
| Control, 1920×1080 | 1:1 | `(0, -420, 1920, 1920)` | `(0, 0, 1920, 1080)` |
| Candidate, 1920×1080 | 2:1 | `(-120, 0, 2160, 1080)` | `(0, 0, 1920, 1080)` |

The detailed report and runnable harness are retained under the ignored path
`sdk/.pocket-build/lantern-station-wide-20261108/native-smoke.json` and
`native-smoke.ts`. The harness used the real candidate/control QJBC and PAK
paths in that cache with the pinned high-resolution `pocket_probe`; it did not
use staged production assets or inject game state. Reproduce it from the repo
root with:

```sh
env \
  POCKET_TOOLS_PACKAGE=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/highres-native-tools-20261107 \
  POCKET_NATIVE_PROBE=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/highres-native-tools-20261107/bin/pocket_probe \
  /Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun \
  sdk/.pocket-build/lantern-station-wide-20261108/native-smoke.ts
```

This protocol smoke does not prove Flutter texture decode/pixel composition,
that the generated image's story props read correctly at both sizes, resident
memory, decode/cold-start costs, or any real platform result. Those pixel and
memory comparisons must use the same view, story, host, and 72 MiB limit for
the strict V4 baseline and candidate before adoption.
