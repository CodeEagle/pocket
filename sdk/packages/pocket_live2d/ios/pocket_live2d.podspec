Pod::Spec.new do |s|
  s.name             = 'pocket_live2d'
  s.version          = '0.1.0'
  s.summary          = 'PocketJS Cubism Core FFI bridge'
  s.description      = 'A thin FFI adapter over the official Live2D Cubism Core.'
  s.homepage         = 'https://github.com/pocketjs/pocket'
  s.license          = { :type => 'Proprietary SDK dependency; see Live2D terms' }
  s.author           = { 'Pocket' => 'Pocket SDK' }
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*'
  s.vendored_frameworks = 'Frameworks/Live2DCubismCore.xcframework'
  s.dependency 'Flutter'
  s.platform = :ios, '13.0'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_TARGET_SRCROOT)/../native/include" "$(PODS_TARGET_SRCROOT)/../.cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5/Core/include"',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    # Cubism's simulator XCFramework slice is arm64-only. CocoaPods' copy
    # phase selects a slice for every architecture in ARCHS, so excluding only
    # the obsolete i386 still leaves x86_64 and causes the Core archive to be
    # skipped before `-lLive2DCubismCore` is linked.
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386 x86_64'
  }
end
