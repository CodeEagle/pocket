#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
FRAMEWORK_TAG=5-r.5
FRAMEWORK_COMMIT=198a3769c26ca3d7b600e932590433badd392edd
FRAMEWORK_URL=https://github.com/Live2D/CubismWebFramework.git
CACHE_ROOT="$PACKAGE_DIR/.cache/cubism-web-framework-$FRAMEWORK_TAG"
FRAMEWORK_ROOT=${CUBISM_WEB_FRAMEWORK_ROOT:-$CACHE_ROOT}

if [ ! -d "$FRAMEWORK_ROOT/.git" ]; then
  if [ -n "${CUBISM_WEB_FRAMEWORK_ROOT:-}" ]; then
    echo "CUBISM_WEB_FRAMEWORK_ROOT must be a Git checkout: $FRAMEWORK_ROOT" >&2
    exit 2
  fi
  mkdir -p "$(dirname -- "$CACHE_ROOT")"
  git clone --depth 1 --branch "$FRAMEWORK_TAG" "$FRAMEWORK_URL" "$CACHE_ROOT"
  FRAMEWORK_ROOT=$CACHE_ROOT
fi

actual_commit=$(git -C "$FRAMEWORK_ROOT" rev-parse HEAD)
if [ "$actual_commit" != "$FRAMEWORK_COMMIT" ]; then
  echo "Cubism Web Framework checkout must be $FRAMEWORK_TAG at $FRAMEWORK_COMMIT; found $actual_commit." >&2
  exit 2
fi
for source_file in \
  src/physics/cubismphysics.ts \
  src/physics/cubismphysicsinternal.ts \
  src/math/cubismmath.ts \
  src/math/cubismvector2.ts \
  src/effect/cubismpose.ts \
  src/motion/cubismmotion.ts \
  LICENSE.md; do
  if [ ! -f "$FRAMEWORK_ROOT/$source_file" ]; then
    echo "Pinned Cubism Web Framework source is incomplete: $source_file" >&2
    exit 2
  fi
done

printf '%s\n' "$FRAMEWORK_ROOT"
