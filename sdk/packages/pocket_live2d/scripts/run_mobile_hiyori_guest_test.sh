#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SDK_DIR=$(CDPATH= cd -- "$PACKAGE_DIR/../.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$PACKAGE_DIR/../../.." && pwd)
CUBISM_SDK_ROOT=${CUBISM_SDK_ROOT:-"$PACKAGE_DIR/.cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5"}
FIXTURE_DIR=${POCKET_LIVE2D_GUEST_FIXTURE_DIR:-"$PACKAGE_DIR/.cache/hiyori-guest-pixels"}
CONSUMER_DIR="$PACKAGE_DIR/.cache/hiyori-mobile-consumer"
PINNED_FLUTTER=$(sed -n 's/.*"flutter"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/.fvmrc")

PREPARE_ONLY=0
CLEAN_CONSUMER=0
while [ "${1:-}" = "--prepare-only" ] || [ "${1:-}" = "--clean" ]; do
  case "$1" in
    --prepare-only) PREPARE_ONLY=1 ;;
    --clean) CLEAN_CONSUMER=1 ;;
  esac
  shift
done
if [ "$PREPARE_ONLY" -eq 0 ] && [ "$#" -lt 1 ]; then
  echo "Usage: $0 [--clean] [--prepare-only] <device-id> [device-id ...]" >&2
  echo "Example: $0 90B4AA40-E9B8-46B5-B70F-144ADEF9CB32 emulator-5554" >&2
  exit 2
fi
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

if [ ! -f "$CUBISM_SDK_ROOT/Core/include/Live2DCubismCore.h" ] ||
  [ ! -f "$CUBISM_SDK_ROOT/Core/lib/android/arm64-v8a/libLive2DCubismCore.a" ] ||
  [ ! -d "$CUBISM_SDK_ROOT/Core/Frameworks/Live2DCubismCore.xcframework" ]; then
  echo "Cubism SDK mobile artifacts missing. Run scripts/bootstrap_cubism_core.sh after accepting the official development terms." >&2
  exit 2
fi

cd "$SDK_DIR"
bun "$SCRIPT_DIR/build_hiyori_guest_fixture.ts"
if [ "$CLEAN_CONSUMER" -eq 1 ]; then
  rm -rf "$CONSUMER_DIR"
fi
mkdir -p "$CONSUMER_DIR"
cd "$CONSUMER_DIR"
if [ ! -f pubspec.yaml ] || [ ! -f android/app/build.gradle.kts ] || [ ! -f ios/Runner.xcodeproj/project.pbxproj ]; then
  run_flutter create \
    --platforms=android,ios \
    --project-name pocket_live2d_hiyori_consumer \
    --org dev.pocketjs \
    --no-pub .
fi

cat > pubspec.yaml <<EOF
name: pocket_live2d_hiyori_consumer
description: Temporary local platform smoke test for Pocket Live2D.
publish_to: none
version: 1.0.0+1
environment:
  sdk: ^3.9.2
dependencies:
  flutter:
    sdk: flutter
  pocket_live2d:
    path: $PACKAGE_DIR
  pocket_sdk:
    path: $SDK_DIR
dev_dependencies:
  flutter_test:
    sdk: flutter
  integration_test:
    sdk: flutter
flutter:
  uses-material-design: true
  assets:
    - assets/
    - assets/native-models/
EOF

rm -rf assets integration_test
mkdir -p assets integration_test
cp -R "$FIXTURE_DIR/flutter-assets/." assets/
cp "$PACKAGE_DIR/integration_test/live2d_mobile_guest_test.dart" integration_test/
cat > lib/main.dart <<'EOF'
import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(home: Scaffold()));
EOF

run_flutter pub get
if [ "$PREPARE_ONLY" -eq 1 ]; then
  echo "Prepared temporary consumer at $CONSUMER_DIR; no device test was started."
  exit 0
fi
RUN_IOS=0
for device in "$@"; do
  case "$device" in
    ????????-????-????-????-????????????) RUN_IOS=1 ;;
  esac
done
if [ "$RUN_IOS" -eq 1 ] && [ "$(uname -s)" = "Darwin" ] && command -v pod >/dev/null 2>&1; then
  # Flutter may reuse a local-path podspec snapshot when the ignored consumer
  # is preserved. Refresh it explicitly so the XCFramework slice settings and
  # Copy XCFrameworks phase always reflect the current plugin podspec.
  (cd ios && pod install)
fi
for device in "$@"; do
  echo "Running bundled Hiyori Live2D guest on $device"
  run_flutter test integration_test/live2d_mobile_guest_test.dart \
    --device-id "$device" \
    --timeout 4m
done
