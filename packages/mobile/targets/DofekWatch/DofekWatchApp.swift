import SwiftUI

@main
struct DofekWatchApp: App {
    @Environment(\.scenePhase) private var scenePhase

    @StateObject private var recorder = AccelerometerRecorder.shared
    @StateObject private var gyroscopeRecorder = GyroscopeRecorder.shared
    @StateObject private var sessionDelegate = WatchSessionDelegate.shared

    @StateObject private var transferManager = TransferManager(
        accelerometerRecorder: AccelerometerRecorder.shared,
        gyroscopeRecorder: GyroscopeRecorder.shared
    )

    init() {}

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
