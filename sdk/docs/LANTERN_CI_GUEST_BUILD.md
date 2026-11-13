# Lantern guest build in CI

Lantern is built from its retained JS source in `demo/js/apps/lantern` through
the existing `build_mini_apps.ts` → `buildGuest` pipeline. The generated
Flutter bundle is intentionally ignored at `demo/assets/apps/lantern/`; clean
checkouts must build it before the Flutter catalog test can load its QJBC, PAK,
metadata and manifest. `build_mini_apps.ts --mini-app=lantern` performs only
that build, skips the unrelated upstream-demo benchmark sweep, and reuses the
already tracked runtime images under `demo/js/apps/lantern/art/`.

The model source is the official public
[`Live2D/CubismNativeSamples` `5-r.5` tag](https://github.com/Live2D/CubismNativeSamples/tree/5-r.5/Samples/Resources/Hiyori),
commit `b8024738f108e6003e4925193e8d5ec04cd18196`. Its 18 Hiyori files used by
`prepare_live2d.ts` were checked against the script's SHA-256 allowlist; the
public tag matches all 18 hashes. Point `CUBISM_SDK_ROOT` at the repository
root, whose sparse checkout needs only `Samples/Resources/Hiyori`. The
preparation script copies the referenced files into the app's ignored staging
directory and checks the hashes again. This build does not call
`bootstrap_cubism_core.sh`, download the proprietary Cubism Native SDK/Core, or
record an SDK license acceptance. The separate Hiyori sample-data terms remain
applicable; the build makes no publication or redistribution claim.

The source-first review of the retained parent
`pocketjs_flutter_demo` (excluding `pocket_host/`) found no Live2D/VN gallery or
model renderer to port. The current Lantern JS source, generated-image
pipeline, and `buildGuest` remain the consumer implementation; this CI mode is
only a narrow way to materialize the already declared app bundle. See
[`LIVE2D_SAMPLE.md`](../../demo/js/apps/lantern/LIVE2D_SAMPLE.md) for the
source comparison, asset provenance, sample hash table and local staging
behavior.

After installing the pinned JS dependencies and building the pinned compiler
and bytecode binary, the source build is:

```sh
CUBISM_SDK_ROOT="$PWD/sdk/.cache/cubism-native-samples" \
POCKET_SOURCE_BUILD=1 \
POCKET_COMPILER_PATH="$PWD/sdk/.cache/pocketjs/tools/build.ts" \
POCKET_BYTECODE_BIN="$PWD/sdk/native/target/release/pocketjs_bytecode" \
bun run --cwd demo/js scripts/build_mini_apps.ts --mini-app=lantern
```

CI checks the resulting nonempty `app.qjbc`, `app.pak`, `app.bytecode.json`
and `guest-manifest.json` before passing the generated directory to the Flutter
test job. The Hiyori staging and Lantern bundle are generated artifacts; neither
is committed as a source cache.
