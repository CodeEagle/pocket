#!/usr/bin/env bash
set -euo pipefail
DEMO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLUTTER_ROOT="$DEMO_ROOT/.."
SDK_ROOT="$DEMO_ROOT/../../sdk"
cd "$SDK_ROOT"
bash scripts/build_native.sh macos
bun scripts/build_guest.ts --project-root="$DEMO_ROOT" --copy-assets-to="$FLUTTER_ROOT/assets" --keep-source="$DEMO_ROOT/.pocket-build/app.js"
python3 scripts/check_architecture.py
cd "$FLUTTER_ROOT"
flutter pub get
exec flutter run -d macos "$@"
