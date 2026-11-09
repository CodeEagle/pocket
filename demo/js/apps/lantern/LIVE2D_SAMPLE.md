# Local Hiyori Live2D audition sample

This is a local-development staging path for the official Hiyori sample already present in the ignored Cubism SDK cache. It is not a public sample asset or a statement that the Lantern app, Pocket runtime, or any publication is licensed for distribution.

## Source-first result and reused path

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was searched outside `pocket_host/` for Live2D, Cubism, `model3.json`, and skeletal-model integration. It contains no Live2D/VN gallery implementation to migrate. Its nearest reusable host groundwork is `lib/core/ffi_bridge.dart`, `lib/core/pocketjs_bundle_runner.dart`, and `lib/render/pocket_ui_components.dart`; its generic game example is `mini_apps/app_game_detail/main.js` and is not a model renderer.

The Pocket integration originally reused the official-cache fixture workflow in [`sdk/packages/pocket_live2d/scripts/build_hiyori_guest_fixture.ts`](../../../../sdk/packages/pocket_live2d/scripts/build_hiyori_guest_fixture.ts): it reads the model's own `FileReferences`, keeps the original MOC and JSON, and uses macOS `sips` to scale only the two referenced 2048×2048 texture pages to the existing 512×512 image-PAK bound. The compiled Hiyori QJBC/Core tests use this same conversion. The Lantern staging script now retains the original 2048×2048 PNG bytes instead of that fixture’s 512 conversion. It copies only model3-referenced inputs into the ignored project-local build directory; it does not build bytecode, edit manifests, or change source assets. This requires the matching high-resolution static PAK IMG compiler/Core adaptation; staging alone does not establish that a host can run these images.

The current app integration uses [`novel.assets.json`](novel.assets.json) `models.hiyori_sample` and its `source`/`textures` entries. The source is staged under the app root so the ordinary project-contained buildGuest resource path can resolve it. The SDK remains independent of Demo code.

## Run locally

With the official Cubism Native R5 cache already present, run from the repository root:

```sh
bun run demo/js/apps/lantern/scripts/prepare_live2d.ts
```

The output is `demo/js/apps/lantern/.pocket-build/live2d/Hiyori/`. Both resulting texture pages must remain exactly 2048×2048 and retain their pinned source hashes. PNG dimensions are read from IHDR without a macOS image-conversion subprocess. Set `CUBISM_SDK_ROOT` only when the already-present cache lives elsewhere. The script performs no download and does not ask for or record license acceptance.

It pins SHA-256 for each of the 18 source files referenced by `Hiyori.model3.json`, rejects a changed reference set or any hash mismatch, copies those files without altering model/MOC/motion/physics data, preserves both texture PNGs byte-for-byte, then writes `NOTICE.txt`. The source model design and UVs are not edited. The 2026-11-07 original-atlas staging run verified all 18 source files, both textures at 2048×2048, and the notice (log `/tmp/pocket-hiyori-original-atlases-stage.log`); the output directory is ignored and must not be committed.

| Relative source file | SHA-256 |
| --- | --- |
| `Hiyori.model3.json` | `973cb3392f7b01f5f73e9d3fedc495a81a0f3ee8014e5df72ef943311c56ee12` |
| `Hiyori.moc3` | `0323f5f377b9afef54318be09e9b4eea2a8cb266190ff9d2f843f95ecb77716c` |
| `Hiyori.2048/texture_00.png` | `560aea0d910dc04950d669640b2ef17c0d817969e9909f477f166bb5cbd8ffbe` |
| `Hiyori.2048/texture_01.png` | `87fe9ab7db81ab3025e0407229e449233581e00fa92c8e911923bc6c7d98ce84` |
| `Hiyori.physics3.json` | `c7a6d641893519c0bbc615545887f03f6c5b8031b4096873740b618370452fc1` |
| `Hiyori.pose3.json` | `ff1cc242790f196c87a7379dc1340b608723db60af1b2825e00da8f351ffc1bf` |
| `Hiyori.userdata3.json` | `75fe50a89ea695b46c98dce8991c2f3d67e3d7a479786e6310460289b552d29b` |
| `Hiyori.cdi3.json` | `0fc3fc76b7a68136056c8832c930c8af9f93899f359eded7349b481ea2342d03` |
| `motions/Hiyori_m01.motion3.json` | `c4f0d982c685b81c1af0ced96c8f6bd5118b8a3fa972c3a12a46652b8d78461d` |
| `motions/Hiyori_m02.motion3.json` | `858c582874a0c4badfec38d4caf19e232fea5ba714f5a2ac6a282c617910c154` |
| `motions/Hiyori_m03.motion3.json` | `de33a8ce78226a5ff80cfa941fb5a4c50b6c1c4b346031ed44b384f772b62cf9` |
| `motions/Hiyori_m04.motion3.json` | `54ddb94d0494772e10355429c547bb7e29601f38d663087804b0c793b29cc51f` |
| `motions/Hiyori_m05.motion3.json` | `7f71061c9207ac1da6e06098ede9318307a7e75715a3ef97c82646acd9ee8620` |
| `motions/Hiyori_m06.motion3.json` | `55c007646febe4cb76d20cbb0623086986dbb55c7ef82212693a5e26636a32ef` |
| `motions/Hiyori_m07.motion3.json` | `3f06cb70f5654eed3389978885e4dff151b6cf9e8d59248680addcd267ff793a` |
| `motions/Hiyori_m08.motion3.json` | `66022fff5cff3c30b7fc1295bf92e4975e3ab9980d5cb296b5e24a2a8acc6daf` |
| `motions/Hiyori_m09.motion3.json` | `9edbd6a88e977221fa90625b5f94c9fd27212e1183288105584be8272543ade7` |
| `motions/Hiyori_m10.motion3.json` | `ba0ba6764a80459432ffd48d6bd5ba261fd25f196208ade3016be74efb9d3dfc` |

## Sample and runtime terms

Live2D identifies Hiyori Momose as a Live2D Original Character. The sample-data page requires both the [Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html) and [Terms of Use for Live2D Cubism Sample Data](https://www.live2d.com/eula/live2d-sample-model-terms_en.html); the Hiyori-specific term prohibits changes to the character design. The sample terms also require the applicable copyright notice, which the generated `NOTICE.txt` carries verbatim. The long notice is appropriate for an app description or other long-description field; use the short form in a surface that cannot display a long description.

The Free Material License Agreement distinguishes General Users and Small-Scale Enterprises (latest sales under ¥10 million) from other users. The former may use Live2D Original Characters for commercial or non-commercial purposes under its conditions; others are limited to Internal or Supervision use unless Live2D gives prior written approval for a specific promotion. This repo cannot determine the user's or organization's qualification. Keep the staged sample private and local unless the applicable terms have been reviewed and the project qualifies for its intended use.

Cubism Core runtime terms are separate: review the [Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) and [Open Software License Agreement](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html). This local staging does not grant runtime publication, redistribution, or expandable-application approval. No SDK/runtime license acceptance is automated here. Refer to [`sdk/docs/VISUAL_NOVEL_LIVE2D.md`](../../../../sdk/docs/VISUAL_NOVEL_LIVE2D.md) for the Pocket runtime source, platform limits, and separately recorded native validation.
