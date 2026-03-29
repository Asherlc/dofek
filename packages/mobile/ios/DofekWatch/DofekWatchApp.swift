import Sentry
import SwiftUI

@main
struct DofekWatchApp: App {
    @Environment(\.scenePhase) private var scenePhase

    init() {
        SentrySDK.start { options in
            options.dsn = "https://971f1d756067049f70cdf4a04e8771a4@o4511073249067008.ingest.us.sentry.io/4511073386627073"
        }
    }

    @StateObject private var recorder = AccelerometerRecorder()
    @StateObject private var gyroscopeRecorder = GyroscopeRecorder()
    @StateObject private var sessionDelegate = WatchSessionDelegate.shared

    @StateObject private var transferManager: TransferManager = {
        let recorder = AccelerometerRecorder()
        let gyroscope = GyroscopeRecorder()
        return TransferManager(accelerometerRecorder: recorder, gyroscopeRecorder: gyroscope)
    }()

    var body: some Scene {
        WindowGroup {
            ContentView(
                recorder: recorder,
                gyroscopeRecorder: gyroscopeRecorder,
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
                // Transfer any queued data
                transferManager.transferNewSamples()
            case .background:
                // Ensure accelerometer continues in background
                recorder.startRecording()
                // Stop gyroscope — CMMotionManager requires foreground
                gyroscopeRecorder.stopRecording()
            case .inactive:
                break
            @unknown default:
                break
            }
        }
    }
}
