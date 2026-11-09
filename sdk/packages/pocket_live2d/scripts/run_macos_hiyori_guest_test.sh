#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SDK_DIR=$(CDPATH= cd -- "$PACKAGE_DIR/../.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$PACKAGE_DIR/../../.." && pwd)
CUBISM_SDK_ROOT=${CUBISM_SDK_ROOT:-"$PACKAGE_DIR/.cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5"}
FIXTURE_DIR=${POCKET_LIVE2D_GUEST_FIXTURE_DIR:-"$PACKAGE_DIR/.cache/hiyori-guest-pixels"}
CONSUMER_DIR="$PACKAGE_DIR/.cache/hiyori-macos-consumer"
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
if [ "$#" -ne 0 ]; then
  echo "Usage: $0 [--prepare-only] [--clean]" >&2
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
  [ ! -d "$CUBISM_SDK_ROOT/Core/Frameworks/Live2DCubismCore-macos.xcframework" ]; then
  echo "Cubism macOS SDK artifacts missing. Run scripts/bootstrap_cubism_core.sh after accepting the official development terms." >&2
  exit 2
fi

# Presence of an old bytecode file is not proof of this source revision.
# Match mobile acceptance: rebuild through the pinned pipeline on every run.
cd "$SDK_DIR"
bun "$SCRIPT_DIR/build_hiyori_guest_fixture.ts"
if [ "$CLEAN_CONSUMER" -eq 1 ]; then
  rm -rf "$CONSUMER_DIR"
fi
mkdir -p "$CONSUMER_DIR"
cd "$CONSUMER_DIR"
if [ ! -f pubspec.yaml ] || [ ! -f macos/Runner.xcodeproj/project.pbxproj ]; then
  run_flutter create \
    --platforms=macos \
    --project-name pocket_live2d_hiyori_macos_consumer \
    --org dev.pocketjs \
    --no-pub .
fi

cat > pubspec.yaml <<EOF
name: pocket_live2d_hiyori_macos_consumer
description: Temporary macOS default-FFI smoke test for Pocket Live2D.
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
  echo "Prepared temporary macOS consumer at $CONSUMER_DIR; no application test was started."
  exit 0
fi

# Refresh CocoaPods from the current local podspec before inspecting or testing
# the FFI package, so a previous Pods cache cannot stand in for this source.
cd macos
pod install --verbose
cd "$CONSUMER_DIR"

run_flutter test integration_test/live2d_mobile_guest_test.dart \
  --device-id macos \
  --timeout 4m
