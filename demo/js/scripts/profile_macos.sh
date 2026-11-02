#!/usr/bin/env bash
set -euo pipefail
DEMO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLUTTER_ROOT="$DEMO_ROOT/.."
cd "$FLUTTER_ROOT"
exec flutter drive --driver=test_driver/integration_test.dart \
  --target=integration_test/performance_test.dart -d macos --profile "$@"
