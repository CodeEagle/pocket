#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_ROOT="$ROOT/packages/pocket_flutter"

python3 "$ROOT/scripts/prepare_upstream.py"

build() {
  local target="$1"
  cargo build --locked --release --manifest-path "$ROOT/native/Cargo.toml" --target "$target" --lib
}

case "${1:-}" in
  macos)
    # Keep Rust/rquickjs objects aligned with the Flutter/Xcode deployment
    # target.  Without this, the host can link successfully but Xcode emits
    # mixed macOS 12/27 object warnings (and future toolchains may reject it).
    export MACOSX_DEPLOYMENT_TARGET=12.0
    build aarch64-apple-darwin
    # Build the host-side static probe separately.  It is intentionally not
    # part of iOS/Android cross builds because those targets ship the library,
    # not a desktop stdin/stdout executable.
    cargo build --locked --release --manifest-path "$ROOT/native/Cargo.toml" \
      --target aarch64-apple-darwin --bin pocket_probe
    mkdir -p "$PACKAGE_ROOT/macos/Frameworks"
    # macOS links the static archive into Runner and resolves FFI symbols from
    # the process. Keep the dylib in native/target for standalone Rust checks;
    # embedding it would trigger Xcode27 LINKEDIT alignment failures.
    cp "$ROOT/native/target/aarch64-apple-darwin/release/libpocket_flutter.a" \
      "$PACKAGE_ROOT/macos/Frameworks/libpocket_flutter.a"
    ;;
  ios-sim)
    export LIBCLANG_PATH="${LIBCLANG_PATH:-$(dirname "$(xcrun --find clang)")/../lib}"
    export BINDGEN_EXTRA_CLANG_ARGS="--target=arm64-apple-ios15.0-simulator -isysroot $(xcrun --sdk iphonesimulator --show-sdk-path)"
    export IPHONEOS_DEPLOYMENT_TARGET=15.0
    build aarch64-apple-ios-sim
    mkdir -p "$PACKAGE_ROOT/ios/Frameworks"
    cp "$ROOT/native/target/aarch64-apple-ios-sim/release/libpocket_flutter.a" \
      "$PACKAGE_ROOT/ios/Frameworks/libpocket_flutter.a"
    ;;
  ios)
    export LIBCLANG_PATH="${LIBCLANG_PATH:-$(dirname "$(xcrun --find clang)")/../lib}"
    export BINDGEN_EXTRA_CLANG_ARGS="--target=arm64-apple-ios15.0 -isysroot $(xcrun --sdk iphoneos --show-sdk-path)"
    export IPHONEOS_DEPLOYMENT_TARGET=15.0
    build aarch64-apple-ios
    mkdir -p "$PACKAGE_ROOT/ios/Frameworks"
    cp "$ROOT/native/target/aarch64-apple-ios/release/libpocket_flutter.a" \
      "$PACKAGE_ROOT/ios/Frameworks/libpocket_flutter.a"
    ;;
  android)
    sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$(python3 -c 'import os; print(os.path.expanduser("~/Library/Android/sdk"))')}}"
    ndk="${POCKET_ANDROID_NDK:-$sdk/ndk/28.1.13356709}"
    case "$(uname -s)" in
      Darwin) host_tag="darwin-x86_64" ;;
      Linux) host_tag="linux-x86_64" ;;
      *) echo "Unsupported NDK build host" >&2; exit 2 ;;
    esac
    bin="$ndk/toolchains/llvm/prebuilt/$host_tag/bin"
    test -x "$bin/aarch64-linux-android24-clang" || {
      echo "Set POCKET_ANDROID_NDK to an installed Android NDK" >&2
      exit 1
    }
    export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$bin/aarch64-linux-android24-clang"
    export CC_aarch64_linux_android="$CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER"
    export AR_aarch64_linux_android="$bin/llvm-ar"
    export LIBCLANG_PATH="${LIBCLANG_PATH:-$(dirname "$(xcrun --find clang)")/../lib}"
    export BINDGEN_EXTRA_CLANG_ARGS="--target=aarch64-linux-android24 --sysroot=$ndk/toolchains/llvm/prebuilt/$host_tag/sysroot"
    export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384"
    build aarch64-linux-android
    mkdir -p "$PACKAGE_ROOT/android/src/main/jniLibs/arm64-v8a"
    cp "$ROOT/native/target/aarch64-linux-android/release/libpocket_flutter.so" \
      "$PACKAGE_ROOT/android/src/main/jniLibs/arm64-v8a/"
    ;;
  *)
    echo "Usage: $0 macos|ios-sim|ios|android" >&2
    exit 2
    ;;
esac
