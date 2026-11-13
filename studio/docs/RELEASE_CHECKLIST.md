# Pocket Studio release checklist (macOS acceptance, deferred)

Everything below needs a Mac (Apple Silicon) and cannot be proven in the Linux container where M0-M7 were built. The Linux
suites (`ARCHITECTURE.md` "Tests", `README.md` "Tests") run the same guest, host plugins and service on the real native
library; what they cannot show is the platform: the real IME, the Metal compositor, the signed app bundle, a profile build.
Tick each item with the date, the Mac model, the commit and the numbers.

Prerequisites: Xcode, Flutter (the SDK's pinned channel), `bun`, `cargo` with the `aarch64-apple-darwin` target.
Build the guest first: `cd studio/js && bun install && bun run build`.

## 1. Launcher end to end
- [ ] `bun sdk/pocket.ts editor --pocket <project>` starts `flutter run -d macos`, writes `<workspace>/pocket-studio-host.config.json`, attaches to or starts the service, opens the Studio window.
- [ ] Re-running with the service already up attaches (no second service); closing the window stops a service the host started.
- [ ] On Linux/Windows the launcher still prints the macOS-only error (covered by `sdk/scripts/tests/pocket_studio_launcher.test.ts`).
- [ ] `--pocket` becomes the default of `bun pocket.ts editor` only after every item here is ticked.

## 2. Spike A: IME and raw key checklist (sdk/docs/STUDIO_TEXT_INPUT.md, "Spike A", 12 items)
- [ ] Pinyin, Japanese, dead keys, composition cancel, selection replace, Cmd+S/Cmd+Z/Shift+Arrow modifiers, key policy, InputField/raw replacement, held-key pairing, AltGr/Option layers, Enter policy, gate toggles.
- [ ] Studio shortcut map on a real keyboard (the Linux tests inject `input.text` batches): Cmd+S, Cmd+F, Cmd+B, Cmd+Shift+B, Cmd+P, Cmd+W, Cmd+Shift+[ and ], Cmd+1..9, Cmd+Shift+P, Esc, while the code view has the keyboard and while it does not. Confirm macOS menu key equivalents do not swallow Cmd+W/Cmd+P/Cmd+B (Flutter's default macOS menu) and that the host reports Cmd+Shift+[ as `Shift+Meta+{` (US layout) or `Shift+Meta+[`; both are mapped.
- [ ] Quick-open: Cmd+P focuses the field (autoFocus) and the IME candidate window appears at the field.

## 3. Spike B: profile-build frame timings (sdk/docs/CODE_VIEW.md, PERFORMANCE.md)
- [ ] `flutter run --profile -d macos` with a 5,000-line file: open, wheel scroll, typing 100 keys, build, publish. Record UI build p95 / raster p95 / over-budget frames against the 16.67 ms budget (DevTools or `FlutterFrameMonitor`).
- [ ] Layout cache: capacity 2048 versus 256 (`studioSystemUI` sets 2048): hit rate and evictions (`PocketViewController.textLayoutCacheStats`).
- [ ] Guest turn budget 250 ms is not exceeded on the release native library with the largest supported file (4 MiB).
- [ ] Compare with the Linux debug numbers in `PERFORMANCE.md`; the Linux numbers are regression bounds, not frame budgets.

## 4. Spike C: compositing and latency
- [ ] The signed preview child composited by `CompositorSurface` beside the editor (Source dock) and on the Preview page: first visible frame, reload without flicker, correct clipping when the split handle moves.
- [ ] Save-to-preview latency (`STUDIO_SAVE_TO_PREVIEW_LATENCY` printed by `studio_preview_loop_test.dart`, Linux) measured on screen with auto-build on.
- [ ] Focus and health promotion of the preview child; pointer input reaches the child, keyboard input stays with the Studio.

## 5. Self-update on screen
- [ ] Settings -> check -> apply replaces the running Studio window content from the signed test channel; page and open project survive (handoff); a deliberately broken build rolls back (Linux: `studio_self_update_test.dart`).
- [ ] `POCKET_STUDIO_UPDATE_CHANNEL=stable` path against a stable slot.

## 6. Entitlements and codesign
- [ ] `studio/macos/Runner/*.entitlements`: the app runs without the App Sandbox (it spawns `bun` and reads the trusted workspace). Decide the distribution model (developer tool outside the Mac App Store) and sign with a Developer ID, hardened runtime; check `com.apple.security.cs.allow-jit` is NOT needed (QuickJS bytecode, no JIT) and that loopback networking works.
- [ ] Notarisation and Gatekeeper first launch; `bun` located through the configured path, not `PATH` of the launching shell.
- [ ] Release build (`flutter build macos --release`) links the static native archive (arm64 only).

## 7. Other macOS-only observations
- [ ] Clipboard plugin on `NSPasteboard` (Linux uses a mocked platform channel).
- [ ] Window resize, full screen, and display scale changes: split handle limits, tree and dock widths persisted in `system.storage`.
- [ ] Memory: Activity Monitor RSS after the M7 scenarios stays within the Linux table (`PERFORMANCE.md`) plus the Flutter engine baseline.

## Owner-scoped exclusions (not release blockers)
Visual novel editor, WeChat preview, Noble Bluetooth and Codex stay in the web Studio by owner decision (`PARITY.md`).
SDK checkout upgrade (`/api/studio/upgrade/*`) is not built in the Pocket Studio.
