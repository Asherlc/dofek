require 'json'

Pod::Spec.new do |s|
  s.name           = 'ExpoHealthKit'
  s.version        = '0.1.0'
  s.summary        = 'Expo module for HealthKit access'
  s.homepage       = 'https://github.com/eastbaysoftware/dofek'
  s.license        = 'MIT'
  s.author         = 'Asher Cohen'
  s.source         = { git: '' }

  s.platform       = :ios, '15.1'
  s.swift_version  = '5.9'

  s.source_files   = '**/*.swift'

  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'HealthKit'
end
