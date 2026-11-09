# Chapter blueprint authoring

## Reference and scope

The official [LetsGal chapter scheduling documentation](https://docs.avg-engine.com/advanced/chapter-scheduling)
was checked on 2026-11-09. Its blueprint is executable cross-chapter scheduling,
not merely visual grouping. This increment therefore authors actual control
flow, while retaining Pocket VN's existing instruction engine. It is not full
LetsGal blueprint parity: extension strategies, a code-expression DSL, chapter
preprocessing and collapsible groups remain outside this increment.

The retained parent outside `pocket_host/` was inspected first.
`mini_apps/app_nav/main.js` and `mini_apps/syslib/pocket_syslib_router.js`
provide named destinations and route navigation; `app_canvas_lab/main.js`
provides draw-list scenarios. None implements a VN chapter scheduler. Reuse
current migrated `engine.ts` call/return and control-flow semantics,
`authoring.ts` editing patterns, existing graph route fields/ports and story
history. No new scheduler, compiler, native state or duplicate edge document
is introduced.

## Canonical representation

`addNovelBlueprintNode(story, spec)` is a pure authoring operation. It creates
one real script label and optional `editor.blueprint.nodes[label]` kind/title
annotations. Route targets, conditions, values and player text live only in
canonical instructions. Deleting annotations must leave execution unchanged.
Creating an entry does not silently change the project's active start; authors
explicitly use the existing start control or an isolated replay entry.

| Authoring role | Existing executable instructions |
| --- | --- |
| Entry | jump |
| Chapter reference | call body, then jump continuation |
| Variable condition | branch with the existing condition AST |
| Player choice | choice with canonical options and stable ID |
| Assignment | set, then jump continuation |
| End | ending with a stable ID |

A referenced body is not rewritten. Both explicit return and reaching the end
of a called label return through the existing call stack. An ending inside a
body ends that narrative instead of returning; this is the existing language
contract, not a hidden scheduler override. The End role records a normal
Pocket VN ending; it is not LetsGal's separate scheduler-only terminal.

## Verified evidence (2026-11-09)

Playwright Chromium creates all six roles through the real Editor dialog, sets
an explicit start, changes a chapter's continuation through the existing port,
undoes/redoes, renames/deletes the role key while retaining its referenced body,
and saves/reopens the canonical story. The pinned buildGuest output runs through
the release native Probe: actual pointer choices select score 59 and 60, paint
the corresponding variable interpolation, and return from explicit-return and
EOF-return chapters to different endings. Removing the entire `editor` object,
rebuilding and rerunning produces the same path output. The targeted strict TypeScript check for types, blueprint helper and Editor
runtime exports passes. A broader Editor/dependency strict check still reports
existing errors and is not a passing full-repository typecheck.

The final input review also rejects over-limit choice/ending text, over-deep
assignment/condition literals, sparse conditions and JSON values that the
canonical engine rejects (accessors, symbols, custom array properties). Boundary
tests compare helper results with the actual Editor validator; the existing
script and draft stay unchanged on rejection. The original route and
free-canvas browser regressions pass alongside the new test: **3/3**.
The final selected SDK, Editor schema/service/layout and history regression suite
passes **275/275**; the architecture check also passes.

The Demo independent replay **“第六十道光 / The Sixtieth Light”** is reachable
through **手札 → 雾港纪念 → 回看 · 第六十道光** (scroll the replay list).
It adds 11 flow nodes, three chapter bodies and seven bilingual lines, retaining
all 120 previous label bodies exactly. The 59/60 choice changes the chapter and
ending. Four Chinese/English engine tests verify mid-chapter save/load, real
call-stack restoration, chapter continuation, metadata ablation and main-save
isolation; the full story/localization selection is **34/34**. The ordinary
Lantern QJBC's actual gallery clicks cover both routes and returning to the
original journey; crossfade and audio settings regressions pass in the same
selected artifact: **6/6**. A preexisting audio test used to overwrite explicit
artifact environment variables; it now supplies defaults only. Failed runs
against the previous package are retained as diagnostics, not accepted evidence.

A read-only check of the real Demo graph sees **134 labels / 197 edges**, scale
1, no browser page errors, and a fully visible located entry without dirtying or
writing story.json. Existing graph labels still use the original runtime.
Font preparation uses the pinned Noto source (1,144 characters); the high-resolution
compiler preserves the existing 2048² Live2D textures. No Live2D sampling,
framing, mesh or rendering changes are part of this increment.

The regular macOS Profile app (`lib/main.dart`, SSAA2) was rebuilt at
`sdk/.pocket-build/lantern-playable-blueprint-20261109/pocket_host.app` and is
running as **PID40085**. After local ad-hoc signing, deep/strict verification,
all four exact embedded Lantern artifacts, runnable main isolate and an
800×632 onscreen window were checked before retiring owned PID72925. The
53569-byte user store retains SHA-256
`038051b6cf43be9ef0a41b811308e6738e8c1d496d7b092a8e6a8374176007de`.
The system reports loginwindow foreground and screen capture unavailable;
this is no claim that the user has seen the window. NativeSession proves
Guest execution and capability requests, not new Flutter pixel/audio decoding
or iOS/Android/Windows acceptance. The whole-game performance gate remains open.

The final authoring-boundary changes are absent from the game bundle. A fresh
consumer build emits identical JavaScript after normalizing only the generated
`pocket-ui-entry-<random>.models.ts` source comment; its package and manifest
are byte-identical. QJBC and metadata hashes differ, so no binary-reproducibility
claim is made. The ordinary app retains the exact original package accepted by
the six actual Guest regressions. See `final-source-build-equivalence.json`.

QA and exact source, compiler, Probe, bytecode/package, ordinary-app and
save facts are under `sdk/.pocket-build/chapter-blueprint-20261109/`:
`acceptance.json`, `final-hashes.json`, `final-manifest.json`,
`lantern-native-final-2.log`, `staged-artifacts.json` and `ordinary-launch.json`.
The full 54-group goal remains active: E02.4 is **partial**, because code-expression
nodes, extension strategies, chapter preprocessing and collapsible groups remain
unimplemented. Conditions and choice options currently use the existing JSON
schema inside the creation dialog; they are not a visual expression builder.
