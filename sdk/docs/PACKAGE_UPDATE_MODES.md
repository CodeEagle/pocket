# Package Update Modes: One-Shot 7z/ZIP Bundle & Fine-Grained Differential Updates

## 1. Source-First Provenance

Before implementing dual update modes, the retained parent repository (`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding `pocket_host/`) and existing SDK documentation were inspected:

- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart` (lines 370–550, 1850–2355):
  - Inspected bundle extraction (`_extractStandardBundle`, `_extractResourceEntry`, `_resolveExtractedPath`) and mini-app asset resolution.
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/tools/compile_pocket_syslib_aot.py`:
  - Inspected build-time packaging of bytecode and resource entries.
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_ota.js`:
  - Inspected legacy guest OTA API shapes (`checkUpdate`, `downloadPatch`, `verifyPatch`, `applyPatch`, `rollback`). Per `sdk/docs/LEGACY_SDK_REUSE.md` and `sdk/docs/POCKETJS_FEATURE_PARITY_SERVICES.md`, the legacy `.pjc` mock and 64-char SHA length check were not copied; instead, all update modes are built on top of the real Ed25519-signed manifest, content-addressed blob store, and QuickJS ABI verification pipeline.

## 2. Dual Update Modes

### Mode 1: One-Shot 7z / ZIP Bundle (`mode: "zip"`)
- **Publisher (`sdk/scripts/package_update.ts`)**:
  - `packageArtifacts` and `patchPackageArtifacts` generate a deterministic `.7z` archive by default (`bundles/bundle-<sha256>.7z`, with a convenience `bundle.7z` copy; `--bundle-format zip` remains supported for `.zip` archives) containing all content-addressed blobs (`blobs/<sha256>`) for code (`entry` + optional `worker`) and resources (`pak.parts` + external `assets`).
  - `create7zArchive` invokes the host `7zz`/`7z` CLI with deterministic LZMA2 flags (`-t7z -m0=lzma2 -mf=off -ms=on -mhc=on -mtm=off -mtc=off -mta=off -mtr=off`) when available, or falls back to the built-in deterministic LZMA2 `.7z` encoder.
  - The signed payload includes `bundle: { format: "7z" | "zip", sha256, size, url: "bundles/bundle-<sha256>.<ext>" }`, preventing in-place publication races across versions.
  - `sdk/scripts/serve_updates.ts` serves `/bundles/bundle-<sha256>.7z` (`Content-Type: application/x-7z-compressed`) and `/bundles/bundle-<sha256>.zip` (`Content-Type: application/zip`) with `Cache-Control: public, max-age=31536000, immutable` (and `/bundle.7z`, `/bundle.zip` with `Cache-Control: no-store`).
- **Client (`sdk/packages/pocket_ui/src/updates.ts` & `sdk/packages/pocket_services`)**:
  - On a fresh mini-app download (no installed `active` or `lastGood` baseline) or when `mode: "zip"` is explicitly requested, `PocketUpdateCoordinator.prepare` downloads the signed bundle archive in a single HTTP request, verifies `bundle.sha256` and `bundle.size`, performs cross-platform built-in `.7z` (`decodePocket7z` supporting `LZMA2`, `LZMA`, `Copy`, `Deflate`, and `EncodedHeader`) or `.zip` (`decodePocketZip`) extraction via `decodePocketBundle` with strict `maxTotalBytes` enforcement, validates CRC-32, verifies each blob against `signed.payload.files`, populates `_blobs/<sha256>`, and stages the version.

### Mode 2: Fine-Grained Update for Already-Downloaded Mini-Apps (`mode: "granular"`)
- **Named PAK Entry Granularity**:
  - `parsePakLayout` in `sdk/scripts/package_update.ts` and `PocketPakPart` in `sdk/packages/pocket_services/lib/src/pocket_package.dart` record `kind` (`"blob"` | `"metadata"`), `key` (the UTF-8 PAK directory key within `1..65535` bytes), and `dtype` for each PAK slice, rejecting empty entries, duplicate keys, and overlapping or aliased ranges.
  - `PocketPackageStore._assemblePak` verifies the assembled `.pak` binary's directory entries (`key`, `offset`, `size`, `dtype`) against the signed `pak.parts` annotations.
- **Granular Patching (`patchPackageArtifacts` in `sdk/scripts/package_update.ts`)**:
  - Produces a new Ed25519-signed version from an existing package directory by updating:
    1. **Code only** (`jsPath` / `bytecodePath` + optional updated `worker`), reusing the exact PAK and loose assets.
    2. **A single PAK resource entry** (`replacePakEntries: { "<key>": ... }`), unpacking the base PAK, replacing only that entry's bytes/dtype, and repacking so all other PAK entry blobs keep their exact SHA-256.
    3. **A single loose asset** (`replaceAssets: { "<name>": ... }`), reusing code, PAK, and all other loose assets while protecting active worker bytecode assets from unsigned replacement/removal.
- **Baseline Blob Seeding & Granular Target Scope (`sdk/packages/pocket_ui/src/updates.ts` & `sdk/packages/pocket_services`)**:
  - When a mini-app is already downloaded (`active` or `lastGood`), `PocketPackageStore.seedBlobsFromPackage` checks `_blobs/<sha256>` first and streams only missing slices from `entry.js`, `package.pak`, or `loose-assets/*` without allocating whole cached packages in memory.
  - `PocketUpdateTarget.codeOnly()` (`scope: "code"`) verifies that only code (`entry` / canonical `worker` descriptor) changed and downloads only the changed code blob.
  - `PocketUpdateTarget.singleResource(resource)` (`scope: "resource"`, `resource: "<key-or-path>"`) verifies that code (`entry` / `worker`), PAK `dtype`/metadata, and all other resources are unchanged and downloads only the single targeted resource blob (`pak:<key>` or `asset:<name>`).
  - Guest JS applications orchestrate all modes via `createPocketUpdateClient(host)` (`check()`, `checkZip()`, `checkCodeOnly()`, `checkResource(resource)`, `apply()`, `rollback()`) exported from `@pocket/ui` (`sdk/packages/pocket_ui/src/updates.ts`).
