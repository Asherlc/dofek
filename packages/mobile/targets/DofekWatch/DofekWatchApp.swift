#if canImport(Sentry)
import Sentry
#endif
import SwiftUI

@main
struct DofekWatchApp: App {
    @Environment(\.scenePhase) private var scenePhase

    @StateObject private var recorder = AccelerometerRecorder.shared
    @StateObject private var gyroscopeRecorder = GyroscopeRecorder.shared
    @StateObject private var altimeterRecorder = AltimeterRecorder.shared
    @StateObject private var sessionDelegate = WatchSessionDelegate.shared

    @StateObject private var transferManager = TransferManager(
        accelerometerRecorder: AccelerometerRecorder.shared,
        gyroscopeRecorder: GyroscopeRecorder.shared,
        altimeterRecorder: AltimeterRecorder.shared
    )

    init() {
        #if canImport(Sentry)
        if let sentryDsn = Bundle.main.object(forInfoDictionaryKey: "SentryDsn") as? String,
           !sentryDsn.isEmpty {
            SentrySDK.start { options in
                options.dsn = sentryDsn
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
        #endif
    }

    var body: some Scene {
        WindowGroup {
            ContentView(
                recorder: recorder,
                gyroscopeRecorder: gyroscopeRecorder,
                altimeterRecorder: altimeterRecorder,
                transferManager: transferManager,
                sessionDelegate: sessionDelegate
            )
        }
        .onChange(of: scenePhase) { _, newPhase in
            switch newPhase {
            case .active:
                // Start accelerometer recording on every foreground (extends existing session)
                recorder.startRecording()
                // Start gyroscope recording (foreground only)
                gyroscopeRecorder.startRecording()
                // Start altimeter recording (foreground only)
                altimeterRecorder.startRecording()
                // Transfer any queued data
                transferManager.transferNewSamples()
            case .background:
                // Ensure accelerometer continues in background
                recorder.startRecording()
                // Stop gyroscope — CMMotionManager requires foreground
                gyroscopeRecorder.stopRecording()
                // Stop altimeter — CMAltimeter requires foreground
                altimeterRecorder.stopRecording()
            case .inactive:
                break
            @unknown default:
                break
            }
        }
    }
}
