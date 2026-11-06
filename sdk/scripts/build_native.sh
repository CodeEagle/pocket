#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_ROOT="$ROOT/packages/pocket_flutter"

python3 "$ROOT/scripts/prepare_upstream.py"

build() {
  local target="$1"
  cargo build --locked --release --manifest-path "$ROOT/native/Cargo.toml" --target "$target" --lib
}

build_ios_slice() {
  local target="$1"
  local sdk_name="$2"
  local clang_target="$3"
  export LIBCLANG_PATH="${LIBCLANG_PATH:-$(dirname "$(xcrun --find clang)")/../lib}"
  export BINDGEN_EXTRA_CLANG_ARGS="--target=$clang_target -isysroot $(xcrun --sdk "$sdk_name" --show-sdk-path)"
  export IPHONEOS_DEPLOYMENT_TARGET=15.0
  build "$target"
}

package_ios_xcframework() {
  local device="$ROOT/native/target/aarch64-apple-ios/release/libpocket_flutter.a"
  local simulator="$ROOT/native/target/aarch64-apple-ios-sim/release/libpocket_flutter.a"
  local output="$PACKAGE_ROOT/ios/pocket_flutter/Frameworks/PocketFlutter.xcframework"
  local lock="$PACKAGE_ROOT/ios/pocket_flutter/Frameworks/.PocketFlutter.xcframework.lock"
  # xcodebuild requires the output argument itself to end in .xcframework.
  local temporary="${output%.xcframework}.tmp.$$.xcframework"
  test -f "$device" && test -f "$simulator"
  # A shared SDK checkout can be prepared by two Flutter consumers at once.
  # Serialize the package step so one process cannot remove the final bundle
  # while another is linking against it.  The lock is deliberately exclusive:
  # the caller can retry after the active producer finishes, rather than
  # observing a mixed bundle.  The final bundle is retained until the complete
  # temporary bundle has been produced.
  if ! mkdir "$lock" 2>/dev/null; then
    echo "PocketFlutter.xcframework packaging is already in progress: $lock" >&2
    exit 73
  fi
  cleanup_xcframework_lock() {
    rmdir "$lock" 2>/dev/null || true
    rm -rf "$temporary"
  }
  trap cleanup_xcframework_lock EXIT
  rm -rf "$temporary"
  xcodebuild -create-xcframework \
    -library "$device" \
    -library "$simulator" \
    -output "$temporary"
  # Install the complete bundle only after xcodebuild has finished. When a
  # previous bundle exists, renameatx_np(RENAME_SWAP) exchanges the directory
  # entries atomically, so readers see either the previous complete bundle or
  # the new complete bundle (never a missing/partial directory). The old bundle
  # is then removed from its temporary name.
  python3 - "$temporary" "$output" <<'PY'
import ctypes
import os
import sys

temporary, output = sys.argv[1:]
at_fdcwd = -2
rename_swap = 0x00000002
if os.path.lexists(output):
    libc = ctypes.CDLL(None, use_errno=True)
    renameatx_np = libc.renameatx_np
    renameatx_np.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameatx_np.restype = ctypes.c_int
    result = renameatx_np(
        at_fdcwd,
        os.fsencode(temporary),
        at_fdcwd,
        os.fsencode(output),
        rename_swap,
    )
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), output)
else:
    os.rename(temporary, output)
PY
  if [ -e "$temporary" ]; then
    rm -rf "$temporary"
  fi
  # Remove the old single-architecture location. Leaving it in place makes a
  # later Flutter build silently select whichever target was built last.
  rm -f "$PACKAGE_ROOT/ios/pocket_flutter/Frameworks/libpocket_flutter.a"
  trap - EXIT
  cleanup_xcframework_lock
}

case "${1:-}" in
  macos)
    # Keep target objects aligned with the Flutter/Xcode deployment target
    # without polluting host proc-macros (which breaks libserde_derive on Xcode 27.2).
    export CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS="-C link-arg=-mmacosx-version-min=12.0"
    export CARGO_TARGET_X86_64_APPLE_DARWIN_RUSTFLAGS="-C link-arg=-mmacosx-version-min=12.0"
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
    build_ios_slice aarch64-apple-ios-sim iphonesimulator arm64-apple-ios15.0-simulator
    build_ios_slice aarch64-apple-ios iphoneos arm64-apple-ios15.0
    mkdir -p "$PACKAGE_ROOT/ios/pocket_flutter/Frameworks"
    package_ios_xcframework
    ;;
  ios)
    build_ios_slice aarch64-apple-ios iphoneos arm64-apple-ios15.0
    build_ios_slice aarch64-apple-ios-sim iphonesimulator arm64-apple-ios15.0-simulator
    mkdir -p "$PACKAGE_ROOT/ios/pocket_flutter/Frameworks"
    package_ios_xcframework
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
