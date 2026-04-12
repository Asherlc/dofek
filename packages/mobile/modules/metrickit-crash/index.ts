// MetricKit crash diagnostic forwarding is entirely native-side.
// This module auto-registers with MXMetricManager on app launch via OnCreate
// and forwards MXCrashDiagnostic payloads to Sentry. No JS API needed.
//
// The import ensures the native module is loaded and registered.
import "./src/MetricKitCrashModule";
