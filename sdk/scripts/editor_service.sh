#!/bin/sh
# Compatibility entrypoint. The cross-platform implementation lives in the
# Node manager beside this wrapper; keep this file for existing macOS scripts.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
NODE=${POCKET_EDITOR_NODE:-node}
exec "$NODE" "$ROOT/scripts/editor_service.mjs" "$@"
