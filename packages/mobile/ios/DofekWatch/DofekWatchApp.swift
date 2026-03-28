import Sentry
import SwiftUI

@main
struct DofekWatchApp: App {
    @Environment(\.scenePhase) private var scenePhase

    @StateObject private var recorder = AccelerometerRecorder.shared
    @StateObject private var sessionDelegate = WatchSessionDelegate.shared

    @StateObject private var transferManager = TransferManager(
        recorder: AccelerometerRecorder.shared
    )

    init() {
        SentrySDK.start { options in
            options.dsn = "https://971f1d756067049f70cdf4a04e8771a4@o4511073249067008.ingest.us.sentry.io/4511073386627073"
            // Disable iOS-specific features that are unavailable on watchOS.
            // The prebuilt XCFramework includes all platforms, but auto-instrumentation
            // (UIViewController tracking, swizzling, network breadcrumbs) relies on
            // UIKit which doesn't exist on watchOS and can crash at launch.
            options.enableSwizzling = false
            options.enableAutoPerformanceTracing = false
            options.enableCaptureFailedRequests = false
            options.enableAppHangTracking = false
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView(
                recorder: recorder,
                transferManager: transferManager,
                sessionDelegate: sessionDelegate
            )
        }
        .onChange(of: scenePhase) { _, newPhase in
            switch newPhase {
            case .active:
                recorder.startRecording()
                transferManager.transferNewSamples()
            case .background:
                recorder.startRecording()
            case .inactive:
                break
            @unknown default:
                break
            }
        }
    }
}
