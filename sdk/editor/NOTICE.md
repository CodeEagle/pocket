# Editor provenance and licensing

The editor service and its small browser UI are new host-side adapter code in
this repository and are covered by the repository `LICENSE`.

The API names and workflow were compared with the PocketJS Kit editor at the
reference checkout (`PocketEditor/src/server/editor_server.ts`,
`src/server/build_queue.ts` and `src/client/*`). No old checkout file, package
dependency, symlink or absolute path is required at runtime. The old editor's
page-graph/WASM preview code was intentionally not copied because it depends
on `PocketTemplates`, `PocketPlugins` and a browser WASM runtime that are not
part of this thin Flutter host; `docs/EDITOR_REUSE.md` records the retained
contract and the ablation.

