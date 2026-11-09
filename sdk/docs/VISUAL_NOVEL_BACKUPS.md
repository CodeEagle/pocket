# Pocket Studio source backups

## Source-first review

The retained parent demo has rollback for deployed bytecode, but not source-project snapshots. `tools/compile_pocket_syslib_aot.py` and `native/pocket_runtime_multi.c` implement the old system-library hot-update rollback slot; the audit report describes package build rollback at `POCKET_SDK_AUDIT_REPORT_a5dd273.md` (section 3). Those records restore a running/deployed version and do not preserve an Editor project's author files. The matching SDK build path in `sdk/editor/server.ts` stages generated build output and restores the previous artifact if a build fails; that is also separate from project-source history.

The source project therefore needs a file snapshot service. It uses the existing workspace boundary (`sdk/editor/server.ts`) and the Editor's source-tree/file safety conventions (`sdk/editor/novel.ts`) while keeping backup policy in reusable JS/TS. It does not import or edit the retained `pocket_host/` tree.

## Behavior

`sdk/editor/novel-backups.ts` exports three operations:

- `createNovelBackup({ workspaceRoot, projectRoot, projectId })` makes an explicit checkpoint.
- `listNovelBackups(...)` returns summaries and marks invalid manifests. The manifest flag describes structure only; payload bytes are checked before restore.
- `restoreNovelBackup(..., backupId)` validates the manifest and every payload file, stages the whole selected tree, records the current project as a recovery checkpoint, then applies the selected files. If an apply step fails, it attempts to restore the recovery checkpoint and returns its ID in the error.

Snapshots are complete directories under `<workspaceRoot>/backups/<projectId>/<uuid>/`, with `manifest.json` and `files/`. Each regular file is copied with SHA-256, byte count, and permission bits. Content, file mode, path, and source identity are checked while copying. Restore rejects path traversal, case-colliding paths, file/directory collisions, symlinks, unexpected payload entries, count/size violations, and hash mismatches before it mutates the project. It does not follow project or backup symlinks. An unsupported author-tree symlink fails the operation instead of silently omitting its target.

Project files are retained regardless of extension, including registered assets such as PNG, WAV, OTF/TTF, `.moc3`, Spine atlases/textures, `.wasm`, and user-provided `.pak` files. Exclusions are limited to explicit cache/dependency directories (`.git`, `node_modules`, `.pocket-build`, `.dart_tool`, common tool caches), known generated build directories at the project root, and the three known root Pocket output names (`app.qjbc`, `app.pak`, `app.bytecode.json`). A nested `src/build/`, `assets/keys/`, `assets/runtime.wasm`, or `assets/custom.pak` is part of the backup. Excluded generated output is left in place during restore.

The service bounds a snapshot to 20,000 files, 20,000 directories, 1,024 UTF-8 bytes per relative path, 64 path components, 128 MiB per file, 1 GiB total payload, and an 8 MiB manifest. It retains at most 20 snapshots per project. `skipUnchanged: true` is intended for automatic checkpoints: it reuses a prior snapshot only after paths, sizes, hashes, modes, and the existing payload all match. Manual checkpoints default to a new snapshot.

## Ablation

The implementation stores source files once per snapshot and uses one manifest for integrity and listing. It does not add a second editable story representation, duplicate Editor history database, custom archive codec, chunk store, or Dart backup state machine. Periodic duplicate snapshots are avoided by the optional content-checked reuse path. The pre-restore snapshot is the single extra copy needed to recover if restoration fails after mutation starts.

## Validation

Run `bun test editor/test/novel_backups.test.ts` from `sdk/`. The tests create a temporary project, make a snapshot, change and remove source/assets, restore, and verify binary assets, executable mode, and the recovery checkpoint. They also prove nested source/build paths and author-owned binary assets survive the filter, generated root output remains untouched, identical automatic checkpoints are reused, corrupt payloads and traversal manifests cannot modify the project, and symlinks are not followed.
