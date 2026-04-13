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
  s.frameworks = 'MetricKit'

  # Sentry is resolved via FRAMEWORK_SEARCH_PATHS pointing at the vendored
  # XCFramework, NOT via a pod dependency. Adding `s.dependency 'Sentry'`
  # changes how CocoaPods generates module maps for the local prebuilt
  # Sentry pod, which breaks RNSentry compilation (PrivateSentrySDKOnly
  # becomes undeclared because the module map changes visibility of
  # internal headers). The xcframework path is enough for `import Sentry`.
  s.pod_target_xcconfig = {
    'FRAMEWORK_SEARCH_PATHS' => '"${PODS_ROOT}/../native/sentry-pod"'
  }
end
