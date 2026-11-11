# Live2D Preview Snapshot Retention

## Retained Source Inspection

Before implementation, `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` (excluding `pocket_host/`) was inspected. No Live2D runtime, `novel.native-assets.json` allowlist, or preview snapshot packaging exists in the retained parent repository. This fix reuses the current pinned SDK `buildGuest` and `createPreviewLive2d` pipeline without introducing a second asset resolver or source fallback.

## Root Cause

1. `sdk/scripts/build_guest.ts` emits `novel.native-assets.json` and hashed `native-models/<sha256>.moc3` binaries into `outDir` when compiling VN packages with Live2D models.
2. When `buildResourceSnapshot` in `sdk/editor/resources.ts` builds catalog subpackages (such as `pocket.demo.lantern`), it compiles each subpackage into a temporary directory (`pocket-editor-subpackage-*`), calls `copyBuiltPackage(built, target)`, and deletes the temporary directory.
3. Previously, `copyBuiltPackage` copied `app.js`, `app.pak`, `app.qjbc`, `app.bytecode.json`, `guest-manifest.json`, and worker bytecode/metadata, but discarded `novel.native-assets.json` and `native-models/*.moc3`. Analogously, `buildProject` and `stageGeneratedPreviewApplications` in `sdk/editor/server.ts` did not stage `novel.native-assets.json` and `native-models/*.moc3` into immutable build snapshots.
4. At runtime, `createPreviewLive2d(bytecodePath)` (`sdk/editor/live2d.ts`) resolves `novel.native-assets.json` and `native-models/<sha256>.moc3` strictly adjacent to the snapshot's `app.qjbc`, causing `ENOENT` when loading Live2D models from an Editor build snapshot.

## Changes

- **`sdk/editor/resources.ts`**:
  - Added `copyBuiltNativeModels(sourceDirectory, destinationDirectory, confinementRoot?)` and wired it into `copyBuiltPackage`.
  - Validates that `novel.native-assets.json` (when present) is a regular non-symlink file inside the confined root with `{ version: 1, assets: Record<string, string> }`.
  - Copies only allowlisted `native-models/<sha256>.moc3` entries after verifying regular-file/no-symlink status, realpath confinement, 32 MiB byte limit, and exact SHA-256 content match. Unlisted files in `native-models/` are never copied.
- **`sdk/editor/server.ts`**:
  - Called `copyBuiltNativeModels(temp, stagingDir)` when staging the root package build and `copyBuiltNativeModels(sourceDirectory, targetDirectory, canonicalRoot)` in `stageGeneratedPreviewApplications` so root and generated preview applications share the same immutable snapshot guarantee.
- **`sdk/editor/test/resources.test.ts` & `sdk/editor/test/live2d_preview_guest.test.ts`**:
  - Added unit coverage for `copyBuiltNativeModels` allowlist filtering, hash mismatch rejection, path traversal rejection, and symlink rejection.
  - Added an integration regression test building a system catalog with a `pocket.demo.lantern` child package through `buildResourceSnapshot`, deleting both the temporary build output and the source `.moc3`, and verifying that `createPreviewLive2d` loads Hiyori (`134` drawables) from `subpackages/pocket.demo.lantern`.

## Validation

Executed with the pinned source-build compiler and release bytecode binary:

```sh
POCKET_SOURCE_BUILD=1 \
POCKET_COMPILER_PATH=/Volumes/ORICO/Development/Github/pocket/sdk/.cache/pocketjs/tools/build.ts \
POCKET_BYTECODE_BIN=/Volumes/ORICO/Development/Github/pocket/sdk/native/target/release/pocketjs_bytecode \
bun test sdk/editor/test/resources.test.ts sdk/editor/test/live2d_preview_guest.test.ts
```


Results: both resource tests and both real-model guest/snapshot tests passed.
`novel_stage_live2d_browser.test.ts` also passed in Playwright Chromium: Hiyori
produced visible meshes and changing pixel hashes during animation. Architecture
checks passed, and the consolidated Argon Medium review found no blocking issues.

The local Studio on port 8791 was restarted and Showcase revision 19 rebuilt.
The deployed child snapshot now contains its catalog and hashed model file;
loading that exact snapshot through the official Web Core returned 134 drawables.
Existing browser tabs must reload to attach to the rebuilt snapshot.
