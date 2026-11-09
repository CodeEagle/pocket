# Prebuilt Toolchain Package Refresh for Inline Fonts

## Background & Root Cause

`sdk/packages/pocket_ui/src/inline-text.tsx` imports `@pocketjs/framework/inline-fonts`.
While the durable upstream patch `sdk/native/patches/inline-text-core.patch` (applied by `sdk/scripts/prepare_upstream.py` onto pinned revision `99924de47c62fa36f526a8791055d91cbbdb3836`) adds:
- `framework/compiler/subpaths.ts` (`"inline-fonts"` subpath entry)
- `framework/src/inline-fonts.ts` (`inlineFontSlot`)
- `tools/inline-text-slots.ts` (`addInlineTextFontSlots`)
- Core RIT1 ops (`setInlineText`, `setInlineReveal`, `getInlineTextLayout`)

the default prebuilt toolchain package installed at `sdk/node_modules/@pocket/tools-darwin-arm64` (and cached at `sdk/.pocket-build/toolchain-package` / `sdk/.pocket-build/pocket-tools-darwin-arm64-0.1.1.tgz`) had been packaged on `2026-11-06` prior to `inline-text-core.patch`.

Consequently, any default `buildGuest` invocation (which uses `resolvePrebuiltTools(root).compiler` when `POCKET_SOURCE_BUILD !== "1"`, or when `POCKET_COMPILER_PATH` is not overridden) resolved the stale prebuilt compiler lacking `@pocketjs/framework/inline-fonts`, failing guest builds whenever `@pocket/ui` was preloaded.

## Source-First Check

- Retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` (excluding `pocket_host/`) has no `@pocketjs/framework/inline-fonts` or rich inline text module (`sdk/docs/INLINE_TEXT_IMPLEMENTATION.md`).
- `sdk/native/patches/inline-text-core.patch` and `sdk/scripts/prepare_upstream.py` are authoritative. No UI source workarounds, mock exports, or unpinned compiler fallbacks were added.

## Toolchain Validation & Packaging Hardening

1. **`sdk/scripts/prebuilt_tools.mjs`**:
   - Added `compiler/framework/compiler/subpaths.ts`, `compiler/framework/src/inline-fonts.ts`, and `compiler/tools/inline-text-slots.ts` to the required manifest file list in `validateToolsPackage()`. Any pre-inline-text prebuilt package is immediately rejected as outdated rather than failing mid-build on `@pocketjs/framework/inline-fonts`.
2. **`sdk/scripts/package_toolchain.ts`**:
   - Added pre-packaging assertions verifying that `framework/compiler/subpaths.ts` (with `"inline-fonts"`), `framework/src/inline-fonts.ts`, and `tools/inline-text-slots.ts` exist in `.cache/pocketjs` before assembling `@pocket/tools-<platform>-<arch>`.
3. **`sdk/scripts/toolchain.mjs`**:
   - Updated `setupPrebuilt()` so that if the currently installed `@pocket/tools-<platform>-<arch>` fails `resolvePrebuiltTools()` validation and a local `.tgz` archive (`prebuilt/` or `.pocket-build/`) is present, `npm run setup` / `npm run bootstrap` refreshes the installed package from the local archive.

## Reproducible Refresh Commands & Paths

Reusing the existing ABI-compatible release binaries in `sdk/native/target/release/` (`bytecodeAbi`: `quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021`) and prepared upstream cache `sdk/.cache/pocketjs`:

```sh
# 1. Verify upstream cache has all 19 patches applied (including inline-text-core.patch)
python3 sdk/scripts/prepare_upstream.py

# 2. Assemble the platform toolchain package and manifest at sdk/.pocket-build/toolchain-package
bun sdk/scripts/package_toolchain.ts --force

# 3. Pack the local prebuilt archive and update its SHA-256 record
npm pack ./sdk/.pocket-build/toolchain-package --ignore-scripts --pack-destination ./sdk/.pocket-build/
shasum -a 256 sdk/.pocket-build/pocket-tools-darwin-arm64-0.1.1.tgz | sed 's|sdk/.pocket-build/||' > sdk/.pocket-build/pocket-tools-darwin-arm64-0.1.1.tgz.sha256

# 4. Sync the installed prebuilt package in sdk/node_modules/@pocket/tools-darwin-arm64 and verify
rm -rf sdk/node_modules/@pocket/tools-darwin-arm64
cp -R sdk/.pocket-build/toolchain-package sdk/node_modules/@pocket/tools-darwin-arm64
npm --prefix sdk run doctor
```

## Refreshed Artifact Summary

- Installed package: `/Volumes/ORICO/Development/Github/pocket/sdk/node_modules/@pocket/tools-darwin-arm64`
- Assembled directory: `/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/toolchain-package`
- Local tarball: `/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/pocket-tools-darwin-arm64-0.1.1.tgz` (`sha256: f58f02b4b7840ffc5b8a993cdc31943b7dc2dfc176f851d9abf9e3e72faac7dc`)
- `bin/pocket_probe`: `6093328` bytes (`sha256: aba3caadccb151e66f4e1eea9e81ed05072c59be2d80cdb5bd7a397c208502bc`, includes RIT1 ops 64–66)
- `bin/pocketjs_bytecode`: `1765440` bytes (`sha256: 6a70b2a9c7d6157aab1620bd30ae1cf64633d927a497a219917bba9b2ecc7ea4`, ABI `quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021`)
- Total validated manifest files: `706` (including `compiler/framework/src/inline-fonts.ts`, `compiler/tools/inline-text-slots.ts`, Web engine, and Noble prebuild)

## Validation

1. `npm --prefix sdk run doctor`:
   - Passed manifest schema, revision, ABI, and SHA-256 integrity checks across all 706 files.
2. Default `buildGuest` (without `POCKET_SOURCE_BUILD=1` or `POCKET_COMPILER_PATH` overrides) on `/Volumes/ORICO/Development/Github/pocket/demo/js`:
   - Command: `npm --prefix sdk run build:guest -- --project-root=/Volumes/ORICO/Development/Github/pocket/demo/js --outdir=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/inline-fonts-toolchain-verify/demo-js`
   - Output: `app.qjbc` (`703,324` bytes), `app.pak` (`1,067,408` bytes, 17 entries), `app.bytecode.json`, `guest-manifest.json`.
3. Default `buildGuest` on small guest `/Volumes/ORICO/Development/Github/pocket/sdk/templates/app`:
   - Command: `npm --prefix sdk run build:guest -- --project-root=/Volumes/ORICO/Development/Github/pocket/sdk/templates/app --outdir=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/inline-fonts-toolchain-verify/template-app`
   - Output: `app.qjbc` (`197,888` bytes), `app.pak` (`906,176` bytes, 14 entries), `app.bytecode.json`, `guest-manifest.json`.
4. Unit tests:
   - `bun test sdk/scripts/tests/prebuilt_tools.test.ts sdk/scripts/tests/package_toolchain.test.ts sdk/scripts/tests/build_guest_rich_text.test.ts`: 10 passed, 0 failed.
