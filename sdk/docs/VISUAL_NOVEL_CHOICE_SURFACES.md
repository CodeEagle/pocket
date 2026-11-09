# Visual novel choice surfaces

Choice surfaces place touch and focus regions over a scene or a dial illustration while the engine continues to own the choice and its routes. The registry is `novel.assets.json`'s optional `choiceSurfaces` map, keyed by the stable `choice.id` from `story.json`.

```json
{
  "choiceSurfaces": {
    "relay_pick": {
      "kind": "dial",
      "image": "art/relay-dial.png",
      "frame": { "x": 0.2, "y": 0.1, "w": 0.6, "h": 0.5 },
      "targets": {
        "route_7": { "x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5 },
        "route_1": { "x": 0.05, "y": 0.25, "w": 0.3, "h": 0.5 },
        "route_4": { "x": 0.65, "y": 0.25, "w": 0.3, "h": 0.5 }
      }
    }
  }
}
```

`scene` surfaces map normalized rectangles to the stage; their optional `frame` defaults to the full stage. `dial` surfaces require a project-relative PNG or SVG and a frame. The dial is drawn with the existing image component's contain bounds, and the option rectangles use that same contained image region. `x`, `y`, `w` and `h` are normalized to the selected frame, with positive size and an extent no greater than 1.

Every configured surface must map the complete authored option ID set exactly. Conditional options stay in the registry even while their conditions hide them. The editor checks targets against the full choice in `story.json`; a missing choice ID, missing option, extra option, malformed rectangle, or unsafe image path blocks an asset write. At runtime the view resolves against the engine's currently available options. If an option is unmapped or a target would be smaller than the minimum hit size, the ordinary scrollable choice list remains available instead of dropping an option.

## Source and reuse

The retained parent project was inspected at `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/app_ui_showcase/main.js` and `mini_apps/pocketjs_uikit.js` (excluding `pocket_host/`). It has focusable actions and keyboard focus primitives, but no normalized scene hotspot or dial hit-testing model. `mini_apps/app_game_detail/main.js` draws a JavaScript canvas HUD, but its 3D movement and collision setup does not supply a reusable visual-novel choice surface.

The adaptation reuses the Pocket VN engine's existing `selectChoice(optionId)` transaction, the current view's focus targets and image skin, and the normal project PNG/SVG collection path. [choice-surface.ts](/Volumes/ORICO/Development/Github/pocket/sdk/packages/pocket_vn/src/choice-surface.ts) is the shared geometry/schema source: `novelChoiceSurfaceIssue` validates normalized shapes and `createNovelChoiceSurfaceLayout` returns `null` when the regular choice list must remain available. The editor exposes the schema through `editor-runtime.ts`; it validates stored target IDs against the source story because the pure geometry helper intentionally has no story dependency.

The editor form lives in `editor/client/novel.js`; server registry validation and story-reference diagnostics live in [novel.ts](/Volumes/ORICO/Development/Github/pocket/sdk/editor/novel.ts). Surface edits use the same asset history scope as backgrounds, atmospheres and image skin. Saving only updates the choice-surface subtree, so sibling metadata such as author notes on an atmosphere is retained. Dial images are ordinary project-relative PNG/SVG files and go through the existing Guest image collector; no second image registry or image pipeline is introduced.

## Validation

`bun test sdk/editor/test/novel_choice_surfaces_browser.test.ts` exercises the actual Editor page with a temporary project and port 0. It creates a surface for a choice with a conditional option, changes it from scene to dial, loads the real image preview, checks undo/redo and save/reopen, rejects missing and unknown target IDs and a traversal image path without changing the saved registry, and confirms the dial bitmap appears in the built Guest PAK.

`bun test sdk/editor/test/novel.test.ts sdk/packages/pocket_vn/test/choice-surface.test.ts` covers the server registry paths and the shared geometry helper. `demo/js/tests/novel_choice_surface_native.test.ts` separately exercises the actual NativeSession pointer and engine route for scene/dial hit regions; the Editor browser test does not claim native hit-testing evidence.

`demo/js/tests/novel_choice_surface_view_native.test.ts` builds a temporary Guest with the pinned `buildGuest` pipeline and mounts the real `NovelView`. NativeSession confirms the Relay label's painted text center selects the dial while the authored camera motion is active. At the settled nonidentity camera scale, the renderer represents each caption glyph as an image quad using a `pocket.texture.*` atlas asset rather than a `type: text` operation; the test checks the hub groups have 7/5/4 glyphs and each dial digit has one glyph quad. It taps transformed scene/dial regions using the shared `createNovelChoiceSurfaceLayout` and `resolveNovelCameraPose` geometry. This avoids treating a text-operation-only dump as proof that captions disappeared. The same fixture checks the Journal/Back HUD, a 190×290 scroll fallback, and a long-English caption fallback with both complete options.

Run it with:

```sh
cd demo/js
npm exec --yes --package=bun@1.4.4 -- bun test tests/novel_choice_surface_view_native.test.ts
```

Result: 1 test passed with 15 assertions on the pinned QuickJS bytecode Guest and NativeSession. The fixture does not substitute a handwritten choice renderer or claim a Flutter screenshot; it validates actual Guest draw operations and pointer routing.
