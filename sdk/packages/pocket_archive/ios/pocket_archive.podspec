Pod::Spec.new do |s|
  native_root = File.expand_path('native', __dir__)
  source_list = File.read(File.join(native_root, 'pocket_archive_sources.cmake'))
  native_sources = source_list.scan(/^\s+([^\s#()]+\.(?:c|cpp))\s*$/).flatten
  # The retained ZIP codec list is shared with Android and the native harness.
  zip_sources = File.read(File.join(native_root, '7zip_sources.cmake')).scan(/^\s+([^\s#()]+\.(?:c|cpp))\s*$/).flatten
  s.name = 'pocket_archive'
  s.version = '0.1.0'
  s.summary = 'Shared native ZIP and 7z extraction for Pocket hosts.'
  s.description = 'File-based extraction with signed-package validation in the Pocket SDK.'
  s.homepage = 'https://github.com/CodeEagle/pocket'
  s.license = { :type => 'LGPL-2.1-or-later', :file => '../LICENSE' }
  s.author = { 'Pocket' => 'dev@pocketjs.dev' }
  s.source = { :path => '.' }
  s.source_files = ['Classes/*.{h,m}',
      *(native_sources + zip_sources).uniq.map { |path| "native/#{path}" }]
  s.preserve_paths = 'native/**/*'
  s.public_header_files = 'Classes/PocketArchivePlugin.h'
  s.platforms = { :ios => '13.0', :osx => '10.15' }
  s.ios.dependency 'Flutter'
  s.osx.dependency 'FlutterMacOS'
  s.requires_arc = true
  s.libraries = 'c++'
  s.pod_target_xcconfig = {
    'CLANG_C_LANGUAGE_STANDARD' => 'c11',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_ENABLE_MODULES' => 'YES',
    'DEFINES_MODULE' => 'YES',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) Z7_EXTRACT_ONLY=1',
    'OTHER_CFLAGS' => '$(inherited) -O2 -fvisibility=hidden',
    'OTHER_CPLUSPLUSFLAGS' => '$(inherited) -O2 -fvisibility=hidden',
    'HEADER_SEARCH_PATHS' => '$(inherited) $(PODS_TARGET_SRCROOT)/native $(PODS_TARGET_SRCROOT)/native/src $(PODS_TARGET_SRCROOT)/native/7zip',
  }
end
