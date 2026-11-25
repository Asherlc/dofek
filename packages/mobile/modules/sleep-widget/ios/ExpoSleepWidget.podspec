Pod::Spec.new do |s|
  s.name           = 'ExpoSleepWidget'
  s.version        = '0.1.0'
  s.summary        = 'Expo module that publishes the Dofek Sleep widget App Group snapshot'
  s.homepage       = 'https://github.com/asherlc/dofek'
  s.license        = 'MIT'
  s.author         = 'Asher Cohen'
  s.source         = { git: '' }

  s.platform       = :ios, '16.4'
  s.swift_version  = '5.9'

  s.source_files   = '**/*.swift'

  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'WidgetKit'
end
