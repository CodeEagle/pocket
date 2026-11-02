#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v bun >/dev/null || { echo "build_guest: bun is required" >&2; exit 2; }
# For a clean checkout build_guest.ts bootstraps ROOT/.cache/pocketjs through
# prepare_upstream.py and always uses the pinned compiler there.
exec bun "$ROOT/scripts/build_guest.ts" "$@"
