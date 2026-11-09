# Visual novel guest source drift audit

This audit compares the strict v4 guest, its station-control clone, and a direct build from the current Lantern project. It is read-only: none of the artifacts or production sources were rebuilt or changed here.

## Result

The 20,187-byte QJBC difference is present in the generated JavaScript input, not in the PAK or bytecode metadata. A direct build from `demo/js/apps/lantern` with the same high-resolution tools and only the three Hiyori framing values changed from `y: 200` to `y: 130` reproduces the strict guest size exactly. Therefore the story framing edit and asset archive do not explain the smaller station-control result.

The control bundle has a different module output: some framework model code is much smaller and two Spine core modules present in strict are absent. This proves a source/module-graph or compiler-output difference in that build. The artifacts do not record enough build-time provenance to identify one unique cause. The clone's relative `file:` dependency paths are invalid at its nested location and create a concrete source-alias risk, but the surviving artifacts do not prove that risk alone caused the output difference.

## Artifact facts

| Artifact | QJBC bytes / SHA-256 | Bundled JS bytes / SHA-256 | PAK bytes / SHA-256 | Source SHA-256 in bytecode metadata |
| --- | --- | --- | --- | --- |
| Strict v4: [`lantern-v4-strict-jsx-20261108`](../.pocket-build/lantern-v4-strict-jsx-20261108/release-artifacts.json) | 1,073,374 / `8defe742d93c066cabbaf7e2c8f665f854c05c8ee03c40e706f1578cae9cb962` | 1,731,670 / `54ad660d9eab2aff0b655e0c6533d92eadace00083aa863bd928dd9a45469dfa` | 69,193,344 / `8126d148c8f71d573dbae11927647150d8d96922f88bab48074d018299369c08` | `54ad660d9eab2aff0b655e0c6533d92eadace00083aa863bd928dd9a45469dfa` |
| Station control clone: [`lantern-station-wide-20261108/control`](../.pocket-build/lantern-station-wide-20261108/control/compiled/app.bytecode.json) | 1,053,187 / `60668db077ebdf3f110bac8bbdfd7cf0c8847a26cfc1509ce10b5e81eb31faca` | 1,695,610 / `028caf64fdf2bfa4023ff3bce480ee69f7f6536d8ad92de9a997d6272a3ad838` | 69,193,344 / `8126d148c8f71d573dbae11927647150d8d96922f88bab48074d018299369c08` | `028caf64fdf2bfa4023ff3bce480ee69f7f6536d8ad92de9a997d6272a3ad838` |
| Direct full-body control: [`lantern-v4-fullbody-20261108`](../.pocket-build/lantern-v4-fullbody-20261108/staging.json) | 1,073,374 / `c2df4275ea8243270a4638a362d55c503aaa2f56b2e0bc43c00f00bbfb01c643` | 1,731,670 / `776e9c4322f8ea9085be1d4cac7e358445d91d9969b1f71abf3bad080835939e` | 69,193,344 / `8126d148c8f71d573dbae11927647150d8d96922f88bab48074d018299369c08` | `776e9c4322f8ea9085be1d4cac7e358445d91d9969b1f71abf3bad080835939e` |

All three records have the same engine ABI, binding generation, tick rate, guest version/build, and PAK SHA. For each artifact, `sourceSha256` equals the SHA-256 of its `compiled/app.js`; the control's smaller QJBC is downstream of a genuinely smaller/different JS bundle.

The direct full-body build's `staging.json` records the current Lantern story hash `a83084561a1628db1c19f229cd044fbe50a4c4bae343b4ac27d7ad80dd9c3d36`, view hash `f532cfad486e9ab1271a19fafff38c0f47b7d3fd3acf42f505f816998fa49e84`, and Dart runtime hash `af67e338e533f0ade60579ba9a926a7d9f97ce4b22dfc978c36a7667d9a9b82b`.

## What differs in the clone build

The copied control project and the current Lantern project each have 93 source files when generated output and `node_modules` are excluded. Their only differing files are `story.json` and `story.test.ts`; the story difference is the three model framing `y` values. The full-body direct build changed those same three values and still produced the strict 1,073,374-byte QJBC.

The control's generated JS is 36,060 bytes smaller than strict. A normalized section comparison found materially different generated module output, including:

- compiler framework `model-reactive.ts`: 533 bytes in control versus 6,982 in strict;
- compiler framework `model-tasks.ts`: 2,610 bytes in control versus 13,174 in strict;
- Spine core `SkeletonBounds.js` (5,656 bytes) and `SkeletonRendererCore.js` (11,056 bytes) are present in strict but absent from control;
- several remaining `spine-core` sections and SDK sections differ slightly, while application identifiers also receive different generated suffixes.

The temporary entry basenames differ (`pocket-ui-entry-32Uwyz`, `pocket-ui-entry-nn8aWW`, and `pocket-ui-entry-adfVI2`). Those names are generated siblings of each app entry. Strict and full-body have different entry names and different JS/source hashes but identical JS and QJBC sizes, so the entry basename by itself does not explain the control size reduction.

The control clone keeps package dependencies such as `@pocket/ui: file:../../../../sdk/packages/pocket_ui`. From its project directory under `sdk/.pocket-build/lantern-station-wide-20261108/control/project`, that resolves to a nonexistent `sdk/sdk/packages/pocket_ui`. The same applies to VN, Spine, and Live2D. [`publicUiPackageRoot`](../scripts/build_guest.ts#L269) tries the declared file path first, then for projects inside the SDK tree checks SDK `node_modules` and `sdk/packages` before the project-local package. [`prepareUiPackage`](../scripts/build_guest.ts#L389) copies the selected source into the clone's `project/node_modules`; [`prepareCompilerEntry`](../scripts/build_guest.ts#L505) writes an entry beside the project source. The control build log records the temporary preload path and compiler path, but not the canonical `realpath` selected for each SDK package.

This is a real reproducibility hazard for nested project mirrors, but the artifact cannot prove which candidate was selected during that historical build. The present SDK `node_modules/@pocket/ui` symlink resolves to the current `sdk/packages/pocket_ui`; this current state does not attest what the clone resolved when the control artifact was made.

## Provenance still missing

The strict release metadata contains output hashes and bytecode ABI data, but no build log, compiler source hash, Bun version, selected SDK package realpaths, or hashes of resolved package sources. The control log names the high-resolution compiler path, but not its contents hash or the package realpaths. The full-body staging record has source/story/view/runtime hashes, but does not attest the compiler or resolved dependency hashes.

So the narrow conclusion is:

1. Strict and direct full-body outputs agree in size despite different temporary entry names and the three framing-value edits.
2. Control uses the same PAK but emits a smaller/different JS bundle and QJBC.
3. A nested `file:` dependency path is invalid and could select a fallback package alias; the artifact lacks evidence to prove it is the sole cause. Other differences in framework and Spine sections show that a future comparison needs build-time compiler, Bun, and resolved-package fingerprints before attributing the 20,187 bytes to a single layer.
