# Story graph canvas

This increment addresses E02.3 (free node layout) in the existing Editor graph
panel. It does not complete E02.4 (chapter blueprints) or the full VN goal.

## Source-first adaptation

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`,
excluding `pocket_host/`, has no visual-novel graph editor. Its
`mini_apps/app_nav/main.js` and `mini_apps/syslib/pocket_syslib_router.js` use
named navigation destinations; `mini_apps/app_canvas_lab/main.js` demonstrates
2D draw lists, not editable narrative nodes. No graph-editor implementation or
matching narrative interaction test was found there.

Reuse the retained migrated behavior in
`sdk/editor/client/novel.js`: graph labels, canonical jump/call/branch/choice/
timeout/input-cancel/trade-failure fields, start selection, label creation and
`historyMutation("story", ...)`. Existing regression scenarios live in
`sdk/editor/test/novel_graph_browser.test.ts` and
`novel_authoring_browser.test.ts`. The missing adaptation is a DOM/SVG graph
surface with free coordinates and connection gestures, not another runtime.

## Data and ownership

Optional `StoryDefinition.editor.graph` has shape
`{ version: 1, positions: { [label]: { x, y } } }`. Coordinates are finite world
coordinates within ±100000. Missing label positions use automatic layout;
stale keys are permitted and ignored when their labels are absent. Other
editor metadata is preserved. Graph moves use the same story history/save
pipeline as instruction edits. Pan/zoom are transient editor view state.

The game engine ignores editor metadata. There is no second edge document:
visible lines are derived from canonical story instructions, and connecting
ports changes those existing fields. Legacy stories omit the optional metadata.
`editor/novel.ts` rejects malformed imported layout fields before persistence.

## Interaction and ablation

Nodes use a DOM/SVG surface with existing route selectors and new connection
ports. Dragging commits once to story history; Escape/pointer cancellation
discards the move. Initial automatic layout measures real card heights once.
The first committed move saves the current measured coordinates, so other
nodes remain fixed. Rename/delete update layout keys in the same history entry.

Pan/zoom remain transient. Small graphs initially fit; large graphs whose
overview scale would be below 0.5 open at readable scale 1 around the selected
label. The explicit overview control still fits all nodes, and a label locator
centers a chosen label without changing story/history or cancelling a pending
connection.

Review removed a redundant estimated-height/collision layout algorithm, unified
selector/port route assignment, corrected negative-coordinate view compensation,
and added observer/RAF cleanup on rerender. Edge updates build one local node
map, and render reads saved positions once rather than rescanning all labels
for every node. These are source-level complexity/lifecycle corrections, not
measured whole-game frame-time improvements.

## Verification

`sdk/editor/test/novel_graph_layout.test.ts` verifies optional/sparse layout,
malformed-coordinate field diagnostics, equivalent narrative execution and
save loading after a layout change. The save-endpoint test additionally verifies that invalid layout does not
overwrite the project. Core/editor/history regression tests passed 267 cases;
strict core TypeScript and architecture checks passed.

`novel_graph_canvas_browser.test.ts` uses actual Playwright Chromium gestures
for pan/zoom, node drag (other nodes remain fixed), undo/redo, creation,
rename/delete position-key history, port reconnection, save and reopen. It
builds the saved project twice through pinned buildGuest, with and without
editor metadata, then uses release `pocket_probe`/NativeSession pointer input
to reach `NEW ROUTE REACHED` with identical output. The retained
`novel_graph_browser.test.ts` checks original route-selector/start/history
behavior. The two browser tests pass serially with no page errors. Earlier
coordinate assertions read before the first animation-frame layout; waiting
for the measured layout fixed that test race, without weakening drag-distance
or history assertions.

Root separately inspected the real Lantern story: 120 nodes and 183 edges,
no page errors. Its initial 0.0506 overview was unreadable; after the readable
initial-view correction it opens at scale 1, and locating
`score_handoff_showcase` makes that entire card visible. Locate leaves the
draft clean and source story SHA unchanged. Before/after and located-node
PNGs, source hashes, test logs and `acceptance.json` are under
`sdk/.pocket-build/story-graph-20261109/`.

E02.3 is accepted for the existing label-node/route model. Chapter blueprints,
instruction-level graph nodes, a full accessibility audit and large-project
performance benchmarks are not covered. No Flutter/native/game rendering or
ordinary Demo assets were changed by this increment; Live2D clarity and the
whole-game performance gate remain open.
