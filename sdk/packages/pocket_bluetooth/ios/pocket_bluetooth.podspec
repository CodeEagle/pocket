Pod::Spec.new do |s|
  s.name             = 'pocket_bluetooth'
  s.version          = '0.1.0'
  s.summary          = 'Independent PocketJS iOS Bluetooth capability provider.'
  s.description      = 'Real CoreBluetooth scan, connection, GATT and notification transport.'
  s.homepage         = 'https://github.com/pocketnexus/pocketjs'
  s.license          = { :type => 'MIT' }
  s.author           = { 'PocketNexus' => 'engineering@pocketnexus.invalid' }
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*.{h,m,swift}'
  s.dependency       'Flutter'
  s.ios.deployment_target = '15.0'
  s.swift_version    = '5.0'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
