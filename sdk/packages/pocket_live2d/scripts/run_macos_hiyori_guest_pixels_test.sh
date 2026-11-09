#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SDK_DIR=$(CDPATH= cd -- "$PACKAGE_DIR/../.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$PACKAGE_DIR/../../.." && pwd)
CUBISM_SDK_ROOT=${CUBISM_SDK_ROOT:-"$PACKAGE_DIR/.cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5"}
FIXTURE_DIR=${POCKET_LIVE2D_GUEST_FIXTURE_DIR:-"$PACKAGE_DIR/.cache/hiyori-guest-pixels"}
BUILD_DIR="${TMPDIR:-/tmp}/pocket-live2d-hiyori-ffi-test"
PINNED_FLUTTER=$(sed -n 's/.*"flutter"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/.fvmrc")

if [ -z "$PINNED_FLUTTER" ]; then
  echo "Could not read the pinned Flutter version from $REPO_ROOT/.fvmrc." >&2
  exit 2
fi

if [ -n "${FLUTTER_BIN:-}" ]; then
  if [ ! -x "$FLUTTER_BIN" ]; then
    echo "FLUTTER_BIN must name an executable Flutter binary: $FLUTTER_BIN" >&2
    exit 2
  fi
  run_flutter() { "$FLUTTER_BIN" "$@"; }
elif command -v fvm >/dev/null 2>&1; then
  run_flutter() { fvm flutter "$@"; }
elif command -v flutter >/dev/null 2>&1; then
  FLUTTER_BIN=$(command -v flutter)
  run_flutter() { "$FLUTTER_BIN" "$@"; }
else
  echo "Flutter $PINNED_FLUTTER is required; install FVM or set FLUTTER_BIN." >&2
  exit 2
fi

FLUTTER_VERSION=$(run_flutter --version 2>&1)
case "$FLUTTER_VERSION" in
  *"Flutter $PINNED_FLUTTER"*) ;;
  *)
    echo "Flutter version does not match .fvmrc pin ($PINNED_FLUTTER):" >&2
    echo "$FLUTTER_VERSION" >&2
    exit 2
    ;;
esac

if [ ! -f "$CUBISM_SDK_ROOT/Core/include/Live2DCubismCore.h" ]; then
  echo "Cubism SDK missing. Run scripts/bootstrap_cubism_core.sh after accepting the official development terms." >&2
  exit 2
fi
if [ ! -f "$CUBISM_SDK_ROOT/Samples/Resources/Hiyori/Hiyori.moc3" ]; then
  echo "Official Hiyori sample model missing from CUBISM_SDK_ROOT." >&2
  exit 2
fi

cd "$SDK_DIR"
bun "$SCRIPT_DIR/build_hiyori_guest_fixture.ts"

cmake -S "$PACKAGE_DIR/native" -B "$BUILD_DIR" \
  -DCUBISM_SDK_ROOT="$CUBISM_SDK_ROOT" \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_BUILD_TYPE=Debug
cmake --build "$BUILD_DIR" --target pocket_live2d_ffi

NATIVE_LIBRARY=${POCKET_NATIVE_LIBRARY:-"$REPO_ROOT/sdk/native/target/debug/libpocket_flutter.dylib"}
if [ ! -f "$NATIVE_LIBRARY" ]; then
  echo "Pocket native dylib missing: $NATIVE_LIBRARY. Build the SDK native target first." >&2
  exit 2
fi

cd "$PACKAGE_DIR"
CUBISM_SDK_ROOT="$CUBISM_SDK_ROOT" \
POCKET_LIVE2D_GUEST_ASSETS="$FIXTURE_DIR/flutter-assets" \
POCKET_LIVE2D_CORE_LIBRARY="$BUILD_DIR/libpocket_live2d_ffi.dylib" \
POCKET_NATIVE_LIBRARY="$NATIVE_LIBRARY" \
run_flutter test test/live2d_guest_pixels_test.dart
