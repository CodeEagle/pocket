#!/usr/bin/env bash
set -euo pipefail

STUDIO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
JS_ROOT="$STUDIO_ROOT/js"
SDK_ROOT="$STUDIO_ROOT/../sdk"
cd "$JS_ROOT"

echo "test_guest: studio-client, tree and encoding units"
bun test tests/studio_client.test.ts tests/tree.test.ts tests/state.test.ts tests/state_m5.test.ts

if [[ "${POCKET_BUILD_GUEST:-1}" == "1" ]]; then
  echo "test_guest: reproducible pinned build (the only compiler path)"
  bun "$SDK_ROOT/scripts/build_guest.ts" --project-root="$JS_ROOT" --copy-assets-to="$STUDIO_ROOT/assets" --keep-source="$JS_ROOT/.pocket-build/app.js"
fi

echo "test_guest: built bytecode on the real native probe with a fake studio.* responder"
bun test tests/studio_guest_native.test.ts tests/studio_guest_workflows.test.ts tests/studio_guest_preview.test.ts tests/studio_guest_publish.test.ts tests/studio_guest_code.test.ts
