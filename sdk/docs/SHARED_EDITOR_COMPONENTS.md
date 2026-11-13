# Shared editor-shell components (`@pocket/ui`)

Source-first record for the M7 move of generic Pocket Studio pieces into the SDK (AGENTS.md: record source paths,
retained behavior, necessary changes, validation). The parent demo repository `pocketjs_flutter_demo` is not available in
this environment, so nothing was ported from it; the sources are the Studio's own M1-M6 components, moved without behavior
change.

## What moved

| Component | New location (export) | Studio source it replaces | Retained behavior |
| --- | --- | --- | --- |
| `Tree` + pure `buildTree` / `visibleRows` / `toggled` | `src/tree.tsx` (`@pocket/ui/tree`), `src/tree-model.ts` (`@pocket/ui/tree-model`) | `studio/js/src/tree.ts`, the row list of `components/file-tree.tsx` | folders first, sorted, empty folders from a separate list, `▾`/`▸` markers, `●` for marked (unsaved) files, 14 px indent per depth, selected-row highlight, optional ScrollablePage wrapper |
| `SplitPane` + pure `clampSplit` / `dragSplit` | `src/split-pane.tsx` (`@pocket/ui/split-pane`), `src/split-pane-model.ts` | new (the Studio Source page had fixed widths 240 / 300) | resizable two-pane row, one pane keeps a pixel size, handle is a pan gesture (`createGesture`, same recognizer pattern as `ShadcnResizable`), size clamped to `[min, max]`, `onResize` while dragging, `onResizeEnd` once on release (persist there) |
| `TabsBar` + pure `stepTab` | `src/tabs.tsx` (`@pocket/ui/tabs`), `src/tabs-model.ts` | `studio/js/src/components/tabs.tsx` | active tab, `●` dirty marker, close button, wrapping prev/next index |
| `ToastHost` | `src/toast-host.tsx` (`@pocket/ui/toast-host`) | `studio/js/src/components/toasts.tsx` | bottom-right stack, four tones, press dismisses; the list and lifetimes stay with the caller (the Studio keeps `state/toasts.ts`) |

The Studio keeps only what is Studio-specific: `components/file-tree.tsx` (toolbar buttons around `Tree`) and `state/toasts.ts`.
The copies `src/tree.ts`, `components/tabs.tsx` and `components/toasts.tsx` were deleted (ablation). The dead
`viewerLines` helper of the M1 read-only viewer was deleted with `tree.ts`.

## Necessary SDK changes

* Pure models live in `.ts` files so bun unit tests can import them without a JSX runtime (same reason `code/index.ts`
  does not export `view.tsx`).
* The components are re-exported from `src/index.ts`. The pinned compiler's pass 1 collects class literals only from the
  package's public entry, so a component reachable only through a subpath loses classes such as `absolute right-[12]` (found
  while moving the toast host: it rendered at y = 0). Same mechanism as the compositor preload comment in `index.ts`.
* `TabsBarItem` (not `TabItem`) because `ui.tsx` already exports `TabItem`.
* `CodeView` gained `onKeyDown(key, owned)`: every key-down of the main text area and of the find fields is offered to
  the app first; `owned` says whether CodeView's own keymap maps the key. Returning `true` consumes it. This is how an app
  shell implements global shortcuts without taking editor-scoped keys (Studio precedence: `studio/docs/ARCHITECTURE.md`).
  Without the prop nothing changes.
* `InputField` gained `autoFocus` (open the editing session ~0.1 s after mount, once layout is committed). Default off.

## Validation

* `packages/pocket_ui/test/shared_components_model.test.ts` (bun, pure logic): tree ordering/rows/toggle, split clamping and
  drag direction, wrapping tab stepping.
* `packages/pocket_ui/test/shared_components_native.test.ts` (real native probe, built guest with
  `shared_components_app.ts`): tree expand/collapse/open and indent, handle drag with clamping and a single
  `onResizeEnd`, a tap on the handle does not resize, tab activate/close, toast stack position and dismiss.
* The Studio's own suites stayed green after it imported the components (`studio/js/scripts/test_guest.sh`).
