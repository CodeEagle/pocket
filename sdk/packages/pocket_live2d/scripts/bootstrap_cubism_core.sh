#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CACHE_DIR="$PACKAGE_DIR/.cache/cubism-sdk-native-5-r5"
SDK_DIR="$CACHE_DIR/CubismSdkForNative-5-r.5"
ZIP_PATH="$CACHE_DIR/CubismSdkForNative-5-r.5.zip"
IOS_XCFRAMEWORK="$SDK_DIR/Core/Frameworks/Live2DCubismCore.xcframework"
MACOS_XCFRAMEWORK="$SDK_DIR/Core/Frameworks/Live2DCubismCore-macos.xcframework"
MACOS_UNIVERSAL_ARCHIVE="$SDK_DIR/Core/lib/macos/libLive2DCubismCore-universal.a"
EXPECTED_SHA256=7ff3a4bbc19c0a8728965aa522ab77eb11b252916453e68a8a78d3b71188bb12
DOWNLOAD_URL=https://cubism.live2d.com/sdk-native/bin/CubismSdkForNative-5-r.5.zip

has_required_archives() {
  test -f "$SDK_DIR/Core/include/Live2DCubismCore.h" && \
    test -f "$SDK_DIR/Core/lib/android/arm64-v8a/libLive2DCubismCore.a" && \
    test -f "$SDK_DIR/Core/lib/ios/Release-iphoneos/libLive2DCubismCore.a" && \
    test -f "$SDK_DIR/Core/lib/ios/Release-iphonesimulator-arm64/libLive2DCubismCore.a" && \
    test -f "$SDK_DIR/Core/lib/macos/arm64/libLive2DCubismCore.a" && \
    test -f "$SDK_DIR/Core/lib/macos/x86_64/libLive2DCubismCore.a" && \
    test -f "$SDK_DIR/Core/dll/windows/x86_64/Live2DCubismCore.lib" && \
    test -f "$SDK_DIR/Core/dll/windows/x86_64/Live2DCubismCore.dll"
}

if ! has_required_archives; then
  cat <<'EOF'
This downloads Live2D's proprietary Cubism Core and Native SDK for local development.
The official archive contains Android arm64, iOS arm64 device/simulator, macOS
arm64/x86_64, and Windows x86_64 Core libraries. The official SDK page states
that downloading or launching means accepting the Proprietary Software License
Agreement and Open Software License Agreement. Read both before continuing.
This script does not submit an email, register an account, request a publication
license, or make any distribution eligibility claim.
  https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
  https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html
EOF
  printf 'Type "yes" only if you accept those development terms: '
  read answer
  if [ "$answer" != yes ]; then
    echo "Download cancelled."
    exit 1
  fi

  mkdir -p "$CACHE_DIR"
  curl -fL --retry 2 --connect-timeout 20 "$DOWNLOAD_URL" -o "$ZIP_PATH"
  printf '%s  %s\n' "$EXPECTED_SHA256" "$ZIP_PATH" | shasum -a 256 -c -
  unzip -q -o "$ZIP_PATH" -d "$CACHE_DIR"
fi

if ! has_required_archives; then
  echo "Official Cubism Native R5 archive is missing a required platform Core library." >&2
  exit 2
fi

if command -v xcodebuild >/dev/null 2>&1; then
  mkdir -p "$(dirname -- "$IOS_XCFRAMEWORK")"
  if [ ! -d "$IOS_XCFRAMEWORK" ]; then
    xcodebuild -create-xcframework \
      -library "$SDK_DIR/Core/lib/ios/Release-iphoneos/libLive2DCubismCore.a" \
      -headers "$SDK_DIR/Core/include" \
      -library "$SDK_DIR/Core/lib/ios/Release-iphonesimulator-arm64/libLive2DCubismCore.a" \
      -headers "$SDK_DIR/Core/include" \
      -output "$IOS_XCFRAMEWORK"
  fi
  if [ ! -d "$MACOS_XCFRAMEWORK" ]; then
    lipo -create \
      "$SDK_DIR/Core/lib/macos/arm64/libLive2DCubismCore.a" \
      "$SDK_DIR/Core/lib/macos/x86_64/libLive2DCubismCore.a" \
      -output "$MACOS_UNIVERSAL_ARCHIVE"
    xcodebuild -create-xcframework \
      -library "$MACOS_UNIVERSAL_ARCHIVE" \
      -headers "$SDK_DIR/Core/include" \
      -output "$MACOS_XCFRAMEWORK"
  fi
  mkdir -p "$PACKAGE_DIR/ios/Frameworks" "$PACKAGE_DIR/macos/Frameworks"
  ln -sfn "$IOS_XCFRAMEWORK" "$PACKAGE_DIR/ios/Frameworks/Live2DCubismCore.xcframework"
  ln -sfn "$IOS_XCFRAMEWORK" "$PACKAGE_DIR/macos/Frameworks/Live2DCubismCore.xcframework"
  ln -sfn "$MACOS_XCFRAMEWORK" "$PACKAGE_DIR/macos/Frameworks/Live2DCubismCore-macos.xcframework"
else
  echo "xcodebuild unavailable: Android and Windows are ready; iOS/macOS xcframeworks need macOS xcodebuild."
fi

echo "CUBISM_SDK_ROOT=$SDK_DIR"
