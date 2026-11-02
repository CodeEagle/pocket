Pod::Spec.new do |s|
  s.name             = 'pocket_flutter'
  s.version          = '0.1.0'
  s.summary          = 'PocketJS retained Canvas renderer and FFI bridge.'
  s.description      = 'Thin Flutter renderer and native display geometry plugin for PocketJS guests.'
  s.homepage         = 'https://github.com/pocketnexus/pocketjs'
  s.license          = { :type => 'MIT', :file => '../LICENSE' }
  s.author           = { 'PocketJS' => 'dev@pocketjs.invalid' }
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*.{h,m,swift}'
  # The SDK ships both arm64 device and arm64 simulator slices in one
  # XCFramework. A single libpocket_flutter.a is intentionally not accepted:
  # switching targets must never overwrite the other platform's archive.
  s.vendored_frameworks = 'Frameworks/PocketFlutter.xcframework'
  s.dependency       'Flutter'
  s.ios.deployment_target = '15.0'
  s.swift_version    = '5.0'
  s.user_target_xcconfig = {
    # Rust exports the C ABI from a static archive inside the XCFramework.
    # Dart FFI resolves those symbols from the process image, so ordinary
    # -l/-framework linking is allowed to discard every object file. CocoaPods
    # extracts the active XCFramework slice to this stable build-directory
    # location; force-loading that selected archive keeps the ABI available on
    # both device and simulator without hard-coding one slice's path.
    # This SDK ships an Apple-Silicon simulator slice only. Excluding Intel
    # is not sufficient when Flutter's generated project still asks lipo to
    # validate both architectures; publish the supported simulator ABI to the
    # user target explicitly as well.
    'ARCHS[sdk=iphonesimulator*]' => 'arm64',
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'x86_64',
    'OTHER_LDFLAGS' => '$(inherited) -force_load "$(PODS_XCFRAMEWORKS_BUILD_DIR)/pocket_flutter/libpocket_flutter.a" -lc -lm -liconv -Wl,-export_dynamic'
  }
  s.requires_arc = false
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # The shipped simulator slice is arm64 for Apple Silicon/iPhone Duo. Keep
    # CocoaPods from asking its pod target to link an unavailable Intel slice.
    'ARCHS[sdk=iphonesimulator*]' => 'arm64',
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'x86_64',
    'OTHER_LDFLAGS' => '$(inherited) -lc++'
  }
end
