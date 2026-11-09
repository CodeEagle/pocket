# Official PocketJS demo catalog and native benchmark

`npm --prefix sdk run official-demos` discovers every installable
`apps/<app>/main.tsx` package in the pinned `sdk/.cache/pocketjs` source tree,
builds the real mounted entry, compiles its
JavaScript bundle to QuickJS bytecode with the SDK's pinned compiler, and runs
the resulting QJBC/PAK through `pocket_bench`. It never copies upstream source
into `demo/js` or another consumer project.

Nested entries are target variants, not additional packages. For example,
`apps/nexus-touch/e7/main.tsx` uses `pocket.symbian.json` but intentionally
retains the parent `dev.pocket-nexus.nexus-touch` package ID, so the catalog
keeps the canonical app entry and does not invent a duplicate host identity.

The default ignored output directory is
`demo/build/official-demos/`. The Flutter worker reads
`demo/build/official-demos/catalog.json`; generated QJBC, PAK, bytecode
metadata, per-demo native benchmark JSON, and the aggregate report live beside
that catalog.

## Run

From the repository root:

```sh
npm --prefix sdk run official-demos -- all --apps=hero,motions
npm --prefix sdk run official-demos -- all
```

The first command is a focused check of the two portable upstream candidates.
The second builds and benchmarks every discovered mounted app. Each build or
runtime failure is recorded and the sweep continues.

Use the same script for one phase at a time:

```sh
npm --prefix sdk run official-demos -- build --apps=hero,motions
npm --prefix sdk run official-demos -- benchmark --apps=hero,motions
```

`build` writes `build-report.json`. `benchmark` reuses existing QJBC/PAK files
and writes `catalog.json` and `report.json`. Optional arguments are
`--frames=N`, `--warmup=N`, `--tick-hz=N`, `--density=N`, and
`--out-dir=PATH`. For example:

```sh
npm --prefix sdk run official-demos -- all --apps=hero --frames=300 --warmup=10
```

## Build and benchmark provenance

For each app, the script invokes the pinned upstream `tools/build.ts` with the
app's actual `main.tsx` mounted entry and the framework declared by its
manifest (defaulting to Solid only when absent). That command produces the upstream
`*-main.js` bundle and PAK in the ignored artifact directory. The script then
uses the SDK-installed `pocketjs_bytecode` binary to produce `app.qjbc` and
`app.bytecode.json`. The catalog records the upstream revision marker, source
entry and manifest paths, source hashes, exact commands, capabilities,
viewport, motion classification, artifact paths and per-stage results.

The native step builds `sdk/native/src/bin/pocket_bench.rs` once in release
mode, then reuses that binary for every demo. The benchmark loads real QJBC and
PAK and reports native QuickJS/runtime frame timings for its built-in idle and
`demo.increment` scenarios. It does not inject pointer/touch or button input;
the generic increment event may not change an official app that does not
subscribe to it.

## Catalog fields and status meaning

`catalog.json` has `schemaVersion: 1` and a `demos` array. Every item includes
the Flutter worker fields `id`, `title`, `qjbcPath`, `pakPath`, `metadataPath`
and `motion` (`continuous` or `static`). Paths are relative to the catalog.
The item also contains `capabilities` as a flat string list, separate
`requiredCapabilities` and `enhancedCapabilities`, `viewport` and
`auxiliaryViewport` as `{width, height}` objects when declared, provenance,
build command/results, native benchmark command/results, `status`, and
`hostCompatibility`.

`passed` means the upstream mounted build, SDK bytecode compilation and raw
native `pocket_bench` run all succeeded. It does **not** mean the app passes
Flutter `PocketSession` admission or that a phone reached a measured FPS.
`build_failed` means upstream bundle/PAK or QJBC/metadata generation failed;
`runtime_failed` means the native benchmark failed without an identified
missing host capability; `platform_limited` means a failed raw run is
consistent with a required capability absent from the current host.

`hostCompatibility.missingSessionCapabilities` is computed from the current
`sdk/lib/src/pocket_session.dart` capability getter. The report also lists
conditionally available capabilities and the inputs/providers the raw native
benchmark does not exercise. In particular, Flutter pointer-to-touch and
`Focusable` do not provide the upstream `input.buttons` bitmask or a physical
gamepad. Worker, offload, audio, auxiliary display/input and physics
requirements remain explicit in the capability report rather than being
inferred from a successful native frame run.

## Choosing a first Flutter-host FPS port

`apps/hero` is the smallest portable source candidate for a first host port. It
uses a Solid view, baked image assets, a rotating spinner and a count button;
pointer activation can change count text and underline position. Its visible
FPS number is a configured label, not a measurement. Use Flutter
`FrameTiming`/the host performance history for actual Flutter FPS.

`apps/motions` is a better second-stage animation stress scene: six tiles play
in parallel and L/R changes four pages. It uses a custom animation theme,
arc drawing, perspective and 3D transforms, so it has more renderer and
capability dependencies. Its playing animations are baked native keyframes;
the page does not run a JavaScript frame callback.

Both direct upstream browser commands use PocketJS's WebAssembly dev host and
are useful for inspecting the source before porting, but they do not execute
the current SDK's QJBC/native Flutter path:

```sh
cd sdk/.cache/pocketjs
bun tools/dev.ts hero-main
bun tools/dev.ts motions-main
```

The catalog's native benchmark is a reproducible engine baseline. For actual
Flutter-host FPS, integrate a selected app into the current consumer and run
the Flutter app on the target simulator/device with host frame timing enabled;
keep those measurements separate from `pocket_bench` results.
