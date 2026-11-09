# Pocket VN text authoring and JSON exchange

## Source review and format choices

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` does not contain a visual-novel language, dialogue editor, branching story format, or story import/export implementation outside the excluded `pocket_host/` directory. Its closest reusable interaction examples are [`mini_apps/app_game_detail/main.js`](../../../pocketjs_flutter_demo/mini_apps/app_game_detail/main.js), which reacts to live input in `onUpdate(dt)`, and [`lib/render/pocket_ui_components.dart`](../../../pocketjs_flutter_demo/lib/render/pocket_ui_components.dart) with [`test/pocket_38_components_screenshot_test.dart`](../../../pocketjs_flutter_demo/test/pocket_38_components_screenshot_test.dart), which show the retained host's render and input boundary. Those examples inform editor interaction and runtime verification; there was no narrative implementation to copy.

The syntax takes a few authoring ideas from official visual-novel formats while keeping Pocket's versioned JSON `StoryDefinition` as the only source of truth. Ren'Py documents compact dialogue, indented choices, and explicit label/jump/call/return control flow ([dialogue](https://www.renpy.org/doc/html/dialogue.html), [menus](https://www.renpy.org/doc/html/menus.html), [labels and control flow](https://www.renpy.org/doc/html/label.html)). Inkle describes Ink as text-first markup with knots, diverts, bullet-style choices, live preview, and source errors ([Ink](https://www.inklestudios.com/ink/), [writing tutorial](https://www.inklestudios.com/ink/web-tutorial/)). Pocket reuses the legible label/opcode structure and editor feedback, but does not import those engines' interpreters or expression languages.

## Current text format

`story.json` remains canonical. The text view is a reversible editing view over that same object:

```text
# Pocket VN authoring v1
story {"id":"harbor","version":1,"start":"opening","credits":{"writer":"Mira"}}

label opening:
  say {"id":"arrival","speaker":"Mira","voice":"arrival","text":"The tide is {{tide}}."}
  scene {"background":"harbor","characters":[{"id":"mira","position":"left","scale":1.2,"rotation":-4,"layer":2}]}
  choice {"id":"route","prompt":"Where now?","options":[{"id":"street","text":"Follow the gulls","target":"street"}]}
  call {"target":"afterword"}
  ending {"id":"end","text":"The harbor wakes."}

label afterword:
  return {}
```

- A `story` header contains every story-level field except `script`; label blocks encode `script` in its original key order.
- Each known opcode carries a single-line JSON object containing all fields except `type`. The opcode restores `type` during parse. Nested conditions, choices, audio/voice cues, scene/model data, transform values, and custom JSON properties stay intact.
- Use a bare label such as `opening`, or a quoted JSON string for labels that need spaces or punctuation such as `label "chapter one":`.
- Blank lines and full-line `#` or `//` comments are ignored. Inline comments and multiline JSON payloads are intentionally not part of v1; this keeps the reader line based and gives diagnostics a direct source location.
- All current instructions have explicit opcodes: `say`, `scene`, `audio`, `wait`, `set`, `inc`, `branch`, `jump`, `call`, `return`, `choice`, and `ending`. Unknown opcodes report a line and column. `json { ... }` explicitly carries a complete future instruction object; it is still passed to `createNovelEngine` validation before apply, so unsupported instructions cannot enter the story.

The JSON payload boundary is a deliberate v1 limit: nested instruction fields are editable, but remain JSON rather than being rewritten as a second condition language or another story interpreter. This preserves every current and consumer-defined JSON property. A future shorthand can make common dialogue and choice text more pleasant to write without changing the underlying story object.

## Public API and editor behavior

`@pocket/vn` exports `parseStoryText`, `formatStoryText`, `StoryTextError`, and the related result/location types from [`src/authoring.ts`](../packages/pocket_vn/src/authoring.ts). `@pocket/vn/authoring` exposes the same authoring helpers. Parse errors include line, column, and source offset. When the JavaScript engine's `JSON.parse` error supplies an offset, the diagnostic maps it to that column; when it does not (including current Chromium), the exact line is reported and the column points to the JSON payload start.

The browser module [`novel-authoring.js`](../editor/client/novel-authoring.js) mounts inside the existing Novel Editor and consumes the current root `getStory()` value. Import loads a local `.pvn.txt` file into an ephemeral draft; export downloads the text in the editor. Applying parses the draft and calls the root `commitStory` callback once. The root validates with `createNovelEngine`, records one undo entry, and replaces its existing story state. The editor keeps an unapplied draft in root-owned transient state so it survives tab dispose/remount. Each draft stores the canonical story text it started from; if blocks or undo/redo change that story before the draft is applied, reopening the text view shows a conflict with explicit reload or keep-draft actions. Applying and reloading clear the draft. No text draft or second history is persisted. Block editing, undo/redo, saving, reopening, and Guest builds continue to use the same `story.json`.

The parent visual-novel editor and runtime were newly implemented in the retained SDK because the source review found no narrative capability to migrate. This authoring surface adapts the existing root editor history and the real engine validator; it adds no second interpreter, schema validator, ID generator, or saved story file. An ablation removed an initial hand-written JSON reader: the authoring syntax now delegates JSON payloads to `JSON.parse` and keeps only label/opcode parsing. This avoids a second JSON grammar; exact payload columns are shown only when the native error includes an offset, with payload-start fallback documented above.

## Validation

The package tests exercise round trips for all current instruction types, stable say/choice IDs, call/return, conditions, audio/voice, scene/model transforms, custom nested metadata, unknown-opcode errors, and line/column diagnostics. The editor browser flow verifies import/edit, apply into the block view, root undo/redo, save/reopen, Guest build, and native pointer-driven story progression.

The Playwright preview observer retains only the latest 16 native frames. Its previous unbounded array kept every large `textureTriangle` payload even though pointer targeting and progression checks only use recent frames. The 16-frame ring preserves the tested interactions while removing that redundant history. Browser acceptance diagnostics now record stage timestamps, page/browser disconnects and failed requests, bound page actions to 12 seconds, and read persisted build state before any bounded status request. The stage test also arms an independent one-second Bun timer before Guest build to show whether the test event loop resumes after the synchronous compiler step.

The combined Chromium acceptance was run from `sdk/` with the isolated Bun 1.4.4 executable and the existing pinned tools and native probe:

```sh
POCKET_TOOLS_PACKAGE=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/current-native-tools \
POCKET_NATIVE_PROBE=/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/current-native-tools/bin/pocket_probe \
/Volumes/ORICO/Development/Github/pocket/sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test --max-concurrency=1 \
  editor/test/novel_text_browser.test.ts \
  editor/test/novel_authoring_browser.test.ts \
  editor/test/novel_graph_browser.test.ts \
  editor/test/novel_localization_browser.test.ts \
  editor/test/novel_stage_browser.test.ts
```

It completed with 6 passing tests, 0 failures, and 50 expectations in 30.64 seconds. The stage test's independent timer fired 1.587 seconds after it was armed; the editor page remained open, the build notice appeared, and native Guest geometry checks passed. The text authoring test completed its text-to-block edit, save/reopen, Guest build, and pointer-driven native progression.

The same browser group had earlier hung under the workspace's Bun 1.3.9 runtime after successful Guest build state was recorded. The stalled run did not capture an original Playwright error or a browser disconnect event, so its local cause is not proven. Bun's reports [#47956](https://github.com/oven-sh/bun/issues/47956) and [#47561](https://github.com/oven-sh/bun/issues/47561) describe a related 1.3.x extra-stdio file-descriptor lifetime issue that can make Playwright calls hang after Chromium exits; the reports reproduce on Linux, and #47561 explicitly says it was not observed on macOS. Bun reports the fix in 1.4.0 and later. The successful isolated 1.4.4 run supports this runtime explanation, but the earlier macOS 1.3.9 stall has no direct event trace tying it to that bug.
