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
    @StateObject private var sessionDelegate = WatchSessionDelegate.shared

    @StateObject private var transferManager: TransferManager = {
        let recorder = AccelerometerRecorder()
        return TransferManager(recorder: recorder)
    }()

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
                // Start recording on every foreground (extends existing session)
                recorder.startRecording()
                // Transfer any queued data
                transferManager.transferNewSamples()
            case .background:
                // Ensure recording continues in background
                recorder.startRecording()
            case .inactive:
                break
            @unknown default:
                break
            }
        }
    }
}
