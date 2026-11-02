# Pocket integration

- Flutter owns only the rendering surface, input/IME, lifecycle, resource decoding and explicitly registered native capability transport. Business UI, state, routing and component composition belong in JS.
- Reuse the pinned PocketJS compiler and engine. Do not invent a second layout engine, mock runtime fallback or success placeholder.
- Work inside `/Volumes/ORICO/Development/Github/pocket`. `sdk/` is the reusable implementation and `demo/` is the only Showcase consumer. The Demo Flutter project is first-layer (`demo/lib`, `demo/ios`, `demo/android`, `demo/pubspec.yaml`); its JS/TS project is the single `demo/js/` folder. Preserve the original parent Flutter demo and the source archive; do not use the old `pocket_host` directory as a second implementation or edit it during normal work.
- Keep upstream provenance and reproducible bootstrap. Generated caches and binaries are not source.
- Validate actual JS execution and input-driven frame changes. Report unsupported components honestly.
- Source-first integration is mandatory: before implementing a capability, inspect `sdk/migrations/pocket_flutter_poc-source-20261102.tar.gz` (extract the original PocketJSKit sources into a temporary directory when needed) and the retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` (excluding this standalone directory). Reuse and adapt their usable implementations and regression scenarios; do not start over. Add new code only for an evidenced gap or a necessary adaptation to the thin Flutter host / JS-owned UI architecture. Record the source paths, retained behavior, necessary changes and validation in `sdk/docs/`.
- Use ablation to remove redundant layers and duplicate state. Do not replace existing working components with speculative new wrappers or accept static checks as proof that migrated interactions work.
- Delegate independent work to Luna Max; workers must not spawn more agents. Shared workspace: never revert another worker's edits.

- Public SDK code under `sdk/` must not import `demo/` internals. Keep scaffold/editor/showcase on the same pinned buildGuest bytecode pipeline; preserve custom consumer files and keep generated platform patches idempotent.
