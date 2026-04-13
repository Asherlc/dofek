Pod::Spec.new do |s|
  s.name           = 'ExpoMetricKitCrash'
  s.version        = '0.1.0'
  s.summary        = 'Expo module that forwards MXCrashDiagnostic payloads to Sentry'
  s.homepage       = 'https://github.com/asherlc/dofek'
  s.license        = 'MIT'
  s.author         = 'Asher Cohen'
  s.source         = { git: '' }

  s.platform       = :ios, '16.0'
  s.swift_version  = '5.9'

  s.source_files   = '**/*.swift'

  s.dependency 'ExpoModulesCore'
  s.dependency 'Sentry'
  s.frameworks = 'MetricKit'

  # Ensure Sentry's vendored XCFramework headers are visible during
  # explicit module scanning. Without this, ScanDependencies can fail
  # to resolve the Sentry module because the xcframework path isn't
  # in the default header search paths for this pod target.
  s.pod_target_xcconfig = {
    'FRAMEWORK_SEARCH_PATHS' => '"${PODS_ROOT}/../native/sentry-pod"'
  }
end
