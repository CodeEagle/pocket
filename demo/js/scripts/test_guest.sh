#!/usr/bin/env bash
set -euo pipefail

DEMO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLUTTER_ROOT="$DEMO_ROOT/.."
SDK_ROOT="$DEMO_ROOT/../../sdk"
cd "$DEMO_ROOT"

echo "test_guest: reducer and source contract"
bun tests/guest_state.test.ts

echo "test_guest: platform-neutral hardware contract"
bun tests/hardware_platform.test.ts

echo "test_guest: video playback and lifecycle scenarios"
bun run test:video

if [[ "${POCKET_BUILD_GUEST:-1}" == "1" ]]; then
  echo "test_guest: reproducible pinned build"
  bun "$SDK_ROOT/scripts/build_guest.ts" --project-root="$DEMO_ROOT" --copy-assets-to="$FLUTTER_ROOT/assets" --keep-source="$DEMO_ROOT/.pocket-build/app.js"
fi

echo "test_guest: JS-to-frame ablation (required)"
bun tests/guest_ablation.ts --required

echo "test_guest: static native probe integration (required)"
bun tests/native_guest_probe.ts --required

echo "test_guest: native settings and preference restore (required)"
bun tests/settings_native.test.ts

echo "test_guest: native route lifetime and state retention (required)"
bun test tests/navigation_native.test.ts
