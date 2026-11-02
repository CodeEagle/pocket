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
  s.vendored_libraries = 'Frameworks/libpocket_flutter.a'
  s.dependency       'Flutter'
  s.ios.deployment_target = '15.0'
  s.swift_version    = '5.0'
  s.user_target_xcconfig = {
    'OTHER_LDFLAGS' => '$(inherited) -force_load "$(PODS_ROOT)/../.symlinks/plugins/pocket_flutter/ios/Frameworks/libpocket_flutter.a" -lc -lm -liconv -Wl,-export_dynamic'
  }
  s.requires_arc = false
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'OTHER_LDFLAGS' => '$(inherited) -lc++'
  }
end
