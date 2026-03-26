Pod::Spec.new do |s|
  s.name           = 'ExpoWatchMotion'
  s.version        = '0.1.0'
  s.summary        = 'Expo module for Apple Watch accelerometer data via WCSession'
  s.homepage       = 'https://github.com/asherlc/dofek'
  s.license        = 'MIT'
  s.author         = 'Asher Cohen'
  s.source         = { git: '' }

  s.platform       = :ios, '16.0'
  s.swift_version  = '5.9'

  s.source_files   = '**/*.swift'

  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'WatchConnectivity'
end
