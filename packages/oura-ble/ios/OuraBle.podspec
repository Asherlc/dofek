require 'json'

Pod::Spec.new do |s|
  s.name           = 'OuraBle'
  s.version        = JSON.parse(File.read(File.join(__dir__, '../package.json')))['version']
  s.summary        = 'Expo module for Oura Ring Bluetooth pairing and sync'
  s.description    = 'iOS adapter for @dofek/oura-ble backed by a vendored OuraBleCore XCFramework.'
  s.homepage       = 'https://github.com/Asherlc/dofek/tree/main/packages/oura-ble'
  s.license        = { :type => 'MIT', :file => '../LICENSE' }
  s.author         = 'Asher Levy'
  s.source         = { :git => 'https://github.com/Asherlc/dofek.git', :tag => "@dofek/oura-ble@#{s.version}" }

  s.platform       = :ios, '16.4'
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  s.libraries      = 'sqlite3'

  s.vendored_frameworks = 'generated/OuraBleCore.xcframework'
  s.source_files   = '*.{swift,h,m}', 'generated/*.swift'
  s.preserve_paths = 'generated/OuraBleCore.xcframework'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
