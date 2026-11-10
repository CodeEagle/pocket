# Demo theme first draw

The retained parent demo initializes its selected theme before its first route is built: `pocketjs_flutter_demo/lib/core/perf_monitor.dart` stores `ThemeMode.dark`, `lib/main.dart` supplies that mode to `MaterialApp`, and `lib/ui/mini_app_host_page.dart` reads the inherited brightness. The JS showcase instead restores `appearance` asynchronously from `platform.storage.get`, while its initial `DemoState` uses light mode.

The showcase now keeps its root business UI hidden until that real storage read settles. A saved appearance is reduced into the existing JS state before `preferencesReady` opens the root; a rejected or missing storage value follows the existing light default and still opens the UI from `finally`. The `system.ready` wait was removed from this path because it is independent of reading the root appearance. System presets and platform system UI each use one readiness-gated effect, so their initial light defaults are not sent before restore and no duplicate final sync is needed. Optional system UI work does not gate the root draw.

This is a JS startup ordering change. It does not add a Dart theme state machine or change Pocket's initial-event protocol. Child apps continue to receive presets through the existing JS system API after the root preference has been restored.

The retained native probe test holds `platform.storage.get`, `system.runtime.configure`, and `platform.systemUi.set` pending. It verifies the root stays blank before storage responds, then checks the first visible canvas for saved dark, saved light, and storage-error fallback. On Editor build revision 19, this test passed together with `container_close_native.test.ts`; both consumed the same root QJBC, PAK, and metadata. The Editor project build was completed without a publish request.

Source and validation references:

- Retained parent theme: `pocketjs_flutter_demo/lib/core/perf_monitor.dart`, `pocketjs_flutter_demo/lib/main.dart`, `pocketjs_flutter_demo/lib/ui/mini_app_host_page.dart`.
- JS preference restore and root gate: `demo/js/app.tsx`.
- Native first-draw regression: `demo/js/tests/theme_startup_native.test.ts`.
- Editor candidate revision: `sdk/.pocket-build/editor-workspace-8791/builds/pocket-host-showcase/19/`.

Published as Showcase `0.1.0-test.9` on the original fixed index. Signed entry SHA-256 `aeee46ba8ca25e40f9df2ac8ec54ff00d72840ebf3bad59ef49c692c53e91859` matches the tested Editor artifact (740557 bytes); Lantern remains test.5. Local agy Argon Medium final follow-up in conversation `a7900426-0cc2-4f55-a9ab-9836850b938d` returned `NO BLOCKING FINDINGS` after confirming existing setPresets synchronously updates state and queues child delivery behind initialization. Physical first-entry dark-theme confirmation remains pending.
