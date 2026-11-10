# Novel Editor Live2D preview

The Novel Editor uses the same Pocket Live2D provider and Pocket VN factory as
the Web runtime. The stage and model asset card both load the official Cubism
Web Core, read only resources referenced by a registered Model3 document, run
the existing motion/physics/pose code, and paint its PMS1 meshes through the
shared Editor mesh compositor.

## Retained source and adaptation

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
was inspected with `pocket_host/` excluded. Its retained Canvas/ring-buffer
preview has no Live2D loader, Model3 resource authorization, Cubism Core bridge,
or Live2D regression case to migrate. The reusable current SDK implementation
is in:

- `packages/pocket_live2d/src/{manifest,transport,motion,physics,pose}.ts`:
  Model3 parsing, Core capability requests, motion sampling, physics and pose.
- `packages/pocket_vn/src/live2d.ts`: VN model factory and pose/expression
  application.
- `targets/web/live2d_provider.js` and `targets/web/live2d_browser.js`: the
  browser host adapter and same-origin asset reader.
- `editor/client/preview.js`: the retained PMS1 mesh, UV and effect compositor.
- `packages/pocket_live2d/lib/src/pocket_live2d_plugin.dart` and
  `packages/pocket_live2d/native/include/pocket_live2d_core.h` /
  `packages/pocket_live2d/native/src/pocket_live2d_core.cpp`: the existing Flutter plugin boundary
  and native Core C ABI. The Flutter plugin itself depends on `rootBundle` and
  `PocketPluginContext`, so it is not a Bun/browser provider. The Web Editor
  uses the official Web Core adapter; the shared JS factory and capability
  protocol keep model policy outside a second Editor-specific runtime.

The Editor adaptation is deliberately limited to loading canonical project
files, exposing the browser runtime module, and connecting the stage callbacks.
`editor/client/novel.js` no longer keeps a second PMS1 decoder; both Spine and
Live2D meshes use `PocketEditorPreview.projectModelMeshes`. The Core is served
from the local `POCKET_CUBISM_WEB_CORE` path or the pinned cache at
`packages/pocket_live2d/.cache/cubism-web-core/live2dcubismcore.min.js`; it is
never downloaded from a CDN or evaluated as guest source.

`/models/source` includes the Model3 document and referenced motion,
expression, physics and pose JSON. The provider's `assets` map contains only
Model3 `FileReferences`, with texture bytes resolved through the registered
texture map. `/models/resource` re-reads the current registered Model3 file
and authorizes an exact referenced asset key before opening it. Existing
project containment, symlink rejection, regular-file checks and per-file size
limits apply. The page CSP adds only `wasm-unsafe-eval` for the official Core's
embedded WebAssembly.

## Validation

`editor/test/novel.test.ts` verifies source assembly and exact-reference
authorization, including undeclared keys, traversal and symlinks.
`editor/test/novel_registry_diagnostics.test.ts` verifies Live2D no longer
gets the stale blanket `models.runtime.unsupported` warning.
`editor/test/novel_stage_live2d_browser.test.ts` stages the pinned Hiyori sample,
loads the Editor in Playwright Chromium, selects its authored scene, and checks
that actual model meshes paint nontransparent pixels and change across frames.
The browser regression uses the locally installed official Core and model
cache; staging the sample does not grant redistribution or publication rights.
