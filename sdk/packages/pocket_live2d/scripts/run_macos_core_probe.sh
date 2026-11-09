#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CACHE_ROOT="$PACKAGE_DIR/.cache/cubism-sdk-native-5-r5"
CUBISM_SDK_ROOT=${CUBISM_SDK_ROOT:-"$CACHE_ROOT/CubismSdkForNative-5-r.5"}
MODEL_ROOT="$CUBISM_SDK_ROOT/Samples/Resources/Mao"
BUILD_DIR="${TMPDIR:-/tmp}/pocket-live2d-core-build"

if [ ! -f "$CUBISM_SDK_ROOT/Core/include/Live2DCubismCore.h" ]; then
  echo "Cubism SDK missing. Run scripts/bootstrap_cubism_core.sh after accepting the official development terms." >&2
  exit 2
fi
if [ ! -f "$MODEL_ROOT/Mao.moc3" ] || [ ! -f "$MODEL_ROOT/Mao.model3.json" ]; then
  echo "Official Mao sample model missing from CUBISM_SDK_ROOT." >&2
  exit 2
fi

cmake -S "$PACKAGE_DIR/native" -B "$BUILD_DIR" \
  -DCUBISM_SDK_ROOT="$CUBISM_SDK_ROOT" \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_BUILD_TYPE=Debug
cmake --build "$BUILD_DIR" --target pocket_live2d_core_probe
"$BUILD_DIR/pocket_live2d_core_probe" "$MODEL_ROOT/Mao.moc3" --repeat 8
