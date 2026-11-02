# Pocket SDK toolchain notes

The release identity for a guest is carried by `editor.json` (or `pocket.json`
for projects created before the editor file existed). `scripts/build_guest.ts`
copies that identity into `app.bytecode.json` and into the generated
`guest-manifest.json` asset. A manifest value remains authoritative when a
consumer intentionally pins one. This keeps `PocketSession`'s embedded build
floor connected to the same version used by Editor and the CLI.
Explicit release builds are positive safe integers; `pocket init` and the demo
both start at build `1`, while malformed or zero build values fail the build.

`pocket.ts prepareNative` uses a SHA-256 fingerprint of native sources,
`Cargo.toml`/`Cargo.lock`, native patches, the build/bootstrap scripts, and the
pinned PocketJS revision. A newer mtime is not sufficient to reuse an archive,
so editing a patch or build script invalidates the cache.

Apple builds produce `packages/pocket_flutter/ios/Frameworks/PocketFlutter.xcframework`
with device and simulator arm64 slices. The previous single
`libpocket_flutter.a` path is removed after packaging, which prevents a device
build from silently replacing the simulator archive. Android builds publish
the arm64 JNI library and are available through `pocket.ts build
--platform=android`.

The iOS podspec force-loads the selected archive from CocoaPods' resolved
`PODS_XCFRAMEWORKS_BUILD_DIR/pocket_flutter/libpocket_flutter.a` path so Dart
FFI symbols are not dead-stripped. Since this SDK intentionally ships no Intel
simulator slice, the pod and user target exclude `x86_64` for simulator builds;
Apple Silicon simulator/device builds remain supported.
Packaging is serialized by an exclusive lock and uses macOS
`renameatx_np(RENAME_SWAP)` when replacing an existing bundle, preserving the
last complete artifact until the new one is ready.

The hardware scaffold remains opt-in. `pocket init --hardware` adds a direct
`pocket_hardware` path dependency and registers its `createHardwarePlugin`
factory; a host without `--hardware` has no hardware package dependency.

The implementation retains the pinned compiler and the existing PocketJS UI
package from the SDK checkout. It does not import the old `pocket_host` or the
former fake bytecode/runtime. Validation includes `bun run --cwd sdk test`, the
real native widget probe, and `bun run --cwd demo/js build`.

## Graphics ablation evidence

The removed line/arc and particle producers were compared without changing the
shared checkout. Two temporary consumer projects were made from
`sdk/packages/pocket_ui/test/fixture`; one vendored the current `graphics.ts`,
and the other vendored the `a5dd273` pre-ablation file. Both were built with:

```text
bun sdk/scripts/build_guest.ts --project-root=<temp-project> --outdir=<temp-project>/out
```

The current and pre-ablation artifacts had different `app.js` and `app.qjbc`
SHA-256 values, while `app.pak` was byte-for-byte identical. Both artifacts
were loaded by the release `pocket_probe` with the same create/load/frame
sequence. Their 50 DrawOps and events were byte-for-byte identical. Resource
records differed only in generated `pocket.texture.*` numeric IDs and were
identical after removing that runtime-local ID; dimensions and pixels matched.
This demonstrates that removing the unused producers changes the compiled
module payload but not the native frame or resource content consumed by the
renderer.

Recorded hashes from the isolated run (`/tmp/pocket-graphics-ablation.8BwRP7`)
were:

```text
                 current                                      pre-ablation
app.js           d0a486382d6a2a1fcc1601475f10772abb32cc4c991719e59ccdf2c4cc7c5d91
app.qjbc         9a3d1f908b058e5044398d2fc80bfb9f2766900d9242820498591999bd81ef03
app.pak          bd0a004ede5044a90ae9961256590cf8d4cf86dba2c9143896d5e9fa9c48c38d  (same)
frame/current    e7711da4581bfa5c08e918e1be1b9f743b72efa893b005acc8ec6db68f7e521c
frame/pre        2cdb1161c1d7c864acaf856d0ac9e3edb7b30e4305185d420504b5ce1b1dbc2a
canonical assets 1f6be2e7ccc51f041e7a15f346cf7daa6a9dd2e19d718e15e79777388f47ef3e (same)
```

The native probe command was equivalent to:

```text
{"op":"create","width":390,"height":844}
{"op":"loadBytecode","bytecodePath":"<variant>/out/app.qjbc","pakPath":"<variant>/out/app.pak"}
{"op":"frame","deltaMs":16}
{"op":"quit"}
```
