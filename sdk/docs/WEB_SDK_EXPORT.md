# Standalone Web SDK export

## Source-first audit

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was inspected with `pocket_host/` excluded. Its `web_wasm_preview/index.html` constructs `WebAssembly.Memory` and a ring buffer in page JavaScript to simulate updates; it does not instantiate the PocketJS runtime or execute QJBC, so it was not reused as a runtime. The parent `README.md` and `docs/02_ARCHITECTURE_AND_MEMORY_DESIGN.md` describe the actual hosts as Flutter and WeChat: the retained Flutter implementation is under `lib/`, while `wechat_host/` is bound to `WXWebAssembly`, `wx.*`, WXML and WeChat storage/BLE. These files establish the host boundary, not a standard-browser implementation.

The implementation instead retains these working repository paths:

- `sdk/scripts/build_guest.ts`: the pinned Guest compiler and QJBC/PAK admission pipeline.
- `sdk/scripts/build_wechat.ts`: the verified QuickJS 0.12.2 WASM build and embedded-bytecode path.
- `sdk/targets/wechat/template/{wechat-host,wechat-system,binary-bridge}.js`: bounded request transport, storage admission, runtime lifecycle and Canvas2D frame delivery.
- `sdk/editor/`: the real `pocket_probe` preview, input/IME projection, version management and signed LAN publishing backend.
- `sdk/packages/pocket_ui/`: JS-owned UI and component behavior.

## Necessary Web adaptation

`sdk/scripts/build_web.ts` invokes the same QJBC + PAK + WASM build stage and converts only the outer host boundary. `sdk/targets/web/browser_runtime.js` supplies standard `WebAssembly.instantiate`, Canvas2D, Pointer events, a native browser input overlay, resize/visibility lifecycle and app-scoped `localStorage`. Guest-visible runtime metadata reports `web`; the WeChat target keeps its existing defaults.

No source-evaluation or mock-runtime fallback is provided. Missing browser hardware stays unsupported until a consumer registers a real capability handler.

`sdk/scripts/export_web_sdk.ts` creates a reproducible source repository containing the Web/WeChat builders, browser target, Editor, native probe source, pinned bootstrap, JS UI package, shader resource, license and selected integration documentation. Web builds use the main-thread renderer by default; pass `--render-worker` to include `pocket-render-worker.js`, or set `renderWorker: true` at runtime when that asset is present. `sdk/scripts/package_toolchain.ts` carries the precompiled entry from `.pocket-build/web-engine/pocket-render-worker.js` in the matching platform toolchain package into `web/pocket-render-worker.js` next to the matching `pocket-web.js` when available. `renderWorker: false` or `--no-render-worker` explicitly selects a main-thread package. The runtime fails clearly when `OffscreenCanvas` or the required worker policy is unavailable. It deliberately excludes `.cache`, native `target`, `node_modules`, Flutter/Dart packages and generated binaries. With `--publish`, it uses the CodeEagle GitHub credential for API creation and an SSH Git remote.

## Release operation

The current SDK distribution version is **0.1.6**. `.github/workflows/toolchain.yml` is the existing build, verification and GitHub Release workflow; it validates `sdk/package.json` against the shared `SDK_VERSION`, then builds both `darwin-arm64` and `win32-x64` packages. Push the matching `sdk-v0.1.6` tag to trigger it automatically, or dispatch the workflow with `publish_release=true` and `update_existing_release=false`. The Release is created only after both platform packages pass consumer acceptance; it includes the standalone SDK tarballs, platform tool archives, checksums and acceptance reports. The workflow does not publish to npm.

The release workflow validates the standalone npm/Web SDK toolchain and its platform packages. It checks the real `pocket_probe`, `pocketjs_bytecode` and Noble Windows binaries, then exercises the clean SDK archives; it does not install Flutter, build the Showcase host or include `pocket_flutter.dll`. The retained parent Flutter implementation has a separate native-host boundary. Flutter/Live2D consumers must validate their app in an authorized Flutter environment that supplies the required Cubism Core files; this Web SDK Release does not claim Flutter or Live2D native-host acceptance.

The exporter’s optional `--publish` operation publishes the standalone source repository and is separate from the versioned GitHub Release attachments.

## Validation

- Focused Web/export tests: 3 passed, 0 failed.
- Architecture boundary check passed.
- A clean exported directory downloaded and patched pinned PocketJS `99924de47c62fa36f526a8791055d91cbbdb3836`, installed dependencies, and built release `pocket_probe` without Flutter.
- The exported Editor served `/health` and its browser UI without a Flutter root.
- A real Lobby build produced a 16,465,194-byte standard WASM engine plus ESM `pocket-web.js`, config, types and provenance metadata.
- Playwright Chromium booted the QJBC Guest with no page/runtime error. The Canvas rendered 130,560 non-empty pixels at 480×272. At 480×800, a pointer down/up on “Increment lobby counter” changed the real Guest frame and both `visits` and `count` from 0 to 1.

The release build emitted a local `rust-objcopy` warning because that optional stripping tool could not find `libLLVM.dylib`; Cargo still completed the optimized `pocket_probe` successfully. This does not affect runtime correctness, but the local Rust installation should be repaired before requiring stripped release binaries.
