Pod::Spec.new do |s|
  s.name           = 'ExpoBleHeartRate'
  s.version        = '0.1.0'
  s.summary        = 'Expo module for standard Bluetooth heart-rate monitor streaming'
  s.homepage       = 'https://github.com/asherlc/dofek'
  s.license        = 'MIT'
  s.author         = 'Asher Cohen'
  s.source         = { git: '' }

  s.platform       = :ios, '16.4'
  s.swift_version  = '5.9'

  s.source_files   = '**/*.swift'

  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'CoreBluetooth'
end
