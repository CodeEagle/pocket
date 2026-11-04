Pod::Spec.new do |s|
  s.name             = 'pocket_sensors'
  s.version          = '0.1.0'
  s.summary          = 'Independent PocketJS iOS sensors capability provider.'
  s.description      = 'Real Core Motion device-motion and relative-altitude transport with owner-scoped cancellation.'
  s.homepage         = 'https://github.com/pocketnexus/pocketjs'
  s.license          = { :type => 'MIT' }
  s.author           = { 'PocketNexus' => 'engineering@pocketnexus.invalid' }
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*.{h,m,swift}'
  s.dependency       'Flutter'
  s.ios.deployment_target = '15.0'
  s.swift_version    = '5.0'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.test_spec 'NativePolicyTests' do |test|
    test.source_files = 'Tests/**/*.swift'
  end
end
