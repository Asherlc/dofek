# Prebuilt Sentry XCFramework podspec.
#
# Replaces the source-built Sentry pod to avoid @_implementationOnly /
# SwiftVerifyEmittedModuleInterface issues on Xcode 26+. The XCFramework
# is downloaded by scripts/download-sentry-xcframework.sh.
#
# SentrySessionReplayHybridSDK.m is compiled separately because the prebuilt
# XCFramework from GitHub releases is missing it (sentry-cocoa build bug).
# It is iOS-only (guarded by SENTRY_TARGET_REPLAY_SUPPORTED).
#
# Version must match what RNSentry expects (s.dependency 'Sentry', '9.7.0').
Pod::Spec.new do |s|
  s.name         = "Sentry"
  s.version      = "9.7.0"
  s.summary      = "Sentry client for cocoa (prebuilt XCFramework)"
  s.homepage     = "https://github.com/getsentry/sentry-cocoa"
  s.license      = "MIT"
  s.authors      = "Sentry"
  s.source       = { :path => "." }

  s.ios.deployment_target = "15.0"
  s.watchos.deployment_target = "10.0"
  s.module_name  = "Sentry"

  s.default_subspecs = ["Core"]

  s.subspec "Core" do |sp|
    sp.vendored_frameworks = "Sentry.xcframework"
    # SentrySessionReplayHybridSDK is iOS-only (Session Replay not supported on watchOS)
    sp.ios.source_files = "SentrySessionReplayHybridSDK.m"
  end
end
