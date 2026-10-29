Pod::Spec.new do |s|
  s.name           = 'ExpoWhoopBle'
  s.version        = '0.1.0'
  s.summary        = 'Expo module for WHOOP strap BLE accelerometer streaming'
  s.homepage       = 'https://github.com/asherlc/dofek'
  s.license        = 'MIT'
  s.author         = 'Asher Cohen'
  s.source         = { git: '' }

  s.platform       = :ios, '16.4'
  s.swift_version  = '5.9'

  s.source_files   = '*.swift'

  s.dependency 'ExpoModulesCore'
  s.dependency 'RNSentry'
  s.libraries      = 'sqlite3'
  s.frameworks     = 'CoreBluetooth'

  s.app_spec 'BridgeTestHost' do |host|
    host.source_files = 'BridgeTestHost/*.swift'
    host.info_plist = {
      'NSBluetoothAlwaysUsageDescription' => 'Exercise native WHOOP connection tests.',
      'UIBackgroundModes' => ['bluetooth-central']
    }
  end

  s.test_spec 'BridgeTests' do |tests|
    tests.source_files = 'BridgeTests/*.swift'
    tests.requires_app_host = true
    tests.app_host_name = 'ExpoWhoopBle/BridgeTestHost'
    tests.dependency 'ExpoWhoopBle/BridgeTestHost'
    tests.dependency 'ExpoModulesTestCore'
    tests.libraries = 'c++'
  end
end
