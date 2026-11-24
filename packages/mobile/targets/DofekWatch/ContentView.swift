import SwiftUI

struct ContentView: View {
    @ObservedObject var recorder: AccelerometerRecorder
    @ObservedObject var gyroscopeRecorder: GyroscopeRecorder
    @ObservedObject var altimeterRecorder: AltimeterRecorder
    @ObservedObject var transferManager: TransferManager
    @ObservedObject var sessionDelegate: WatchSessionDelegate

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced
    @Environment(\.redactionReasons) private var redactionReasons

    private var showsGenericTransferLabel: Bool {
        redactionReasons.contains(.privacy)
            || scenePhase != .active
            || isLuminanceReduced
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            activeTransferContent
                .opacity(showsGenericTransferLabel ? 0 : 1)
                .accessibilityHidden(showsGenericTransferLabel)
                .allowsHitTesting(!showsGenericTransferLabel)

            if showsGenericTransferLabel {
                Text("iPhone transfer")
                    .font(.headline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding()
            }
        }
        // Keep session/recording setup on this stable outer view so wrist
        // dimming and privacy redaction do not re-register callbacks or restart the task.
        .task { [transferManager, recorder, gyroscopeRecorder, altimeterRecorder] in
            // Activate WCSession on first appearance
            sessionDelegate.activate()

            // Handle sync requests from iPhone
            sessionDelegate.onSyncRequested = { [weak transferManager = transferManager] in
                transferManager?.transferNewSamples()
            }

            // Handle recording requests from iPhone
            sessionDelegate.onRecordingRequested = { [weak recorder, weak gyroscopeRecorder, weak altimeterRecorder] in
                recorder?.startRecording()
                gyroscopeRecorder?.startRecording()
                altimeterRecorder?.startRecording()
            }

            // Start recording immediately
            recorder.startRecording()
            gyroscopeRecorder.startRecording()
            altimeterRecorder.startRecording()
        }
    }

    private var activeTransferContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                transferSummarySection

                Divider()

                // Accelerometer status
                Section {
                    HStack {
                        Image(systemName: recorder.isRecording ? "waveform.circle.fill" : "waveform.circle")
                            .foregroundColor(recorder.isRecording ? .green : .gray)
                        Text(recorder.isRecording ? "Recording" : "Not Recording")
                            .font(.headline)
                    }

                    if !AccelerometerRecorder.isAvailable {
                        Text("Accelerometer not available on this device")
                            .font(.caption)
                            .foregroundColor(.red)
                    }
                } header: {
                    Text("Accelerometer")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                // Gyroscope status
                Section {
                    HStack {
                        Image(systemName: gyroscopeRecorder.isRecording ? "gyroscope" : "gyroscope")
                            .foregroundColor(gyroscopeRecorder.isRecording ? .blue : .gray)
                        Text(gyroscopeRecorder.isRecording ? "Recording" : "Inactive")
                            .font(.headline)
                    }

                    Text("Active in foreground only")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    if !GyroscopeRecorder.isAvailable {
                        Text("Gyroscope not available on this device")
                            .font(.caption)
                            .foregroundColor(.red)
                    } else if !gyroscopeRecorder.isRecording {
                        Button("Start Gyroscope") {
                            gyroscopeRecorder.startRecording()
                        }
                        .font(.caption)
                        .buttonStyle(.bordered)
                    }
                } header: {
                    Text("Gyroscope")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                // Altimeter status
                Section {
                    HStack {
                        Image(systemName: altimeterRecorder.isRecording ? "mountain.2.fill" : "mountain.2")
                            .foregroundColor(altimeterRecorder.isRecording ? .orange : .gray)
                        Text(altimeterRecorder.isRecording ? "Recording" : "Inactive")
                            .font(.headline)
                    }

                    Text("Active in foreground only")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    if !AltimeterRecorder.isAvailable {
                        Text("Barometer not available on this device")
                            .font(.caption)
                            .foregroundColor(.red)
                    }

                    if let lastError = altimeterRecorder.lastError {
                        Text(lastError)
                            .font(.caption)
                            .foregroundColor(.red)

                        Button("Retry") {
                            altimeterRecorder.startRecording()
                        }
                        .font(.caption)
                        .buttonStyle(.bordered)
                    }
                } header: {
                    Text("Altimeter")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Divider()

                // Sync info
                Section {
                    HStack {
                        Image(systemName: sessionDelegate.isIPhoneReachable ? "iphone.circle.fill" : "iphone.circle")
                            .foregroundColor(sessionDelegate.isIPhoneReachable ? .green : .gray)
                        Text(sessionDelegate.isIPhoneReachable ? "iPhone Connected" : "iPhone Not Reachable")
                            .font(.subheadline)
                    }

                    Text("\(recorder.samplesSinceLastTransfer) pending accel samples")
                        .font(.subheadline)
                        .foregroundColor(.secondary)

                    Text("\(gyroscopeRecorder.bufferedSampleCount) pending gyro samples")
                        .font(.subheadline)
                        .foregroundColor(.secondary)

                    Text("\(altimeterRecorder.bufferedSampleCount) pending altitude samples")
                        .font(.subheadline)
                        .foregroundColor(.secondary)

                    if let lastTransfer = recorder.lastTransferDate {
                        Text("Last transfer: \(lastTransfer, style: .relative) ago")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }

                    Text(transferManager.lastTransferStatus)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                } header: {
                    Text("Sync")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Divider()

                // Actions below first-screen content
                VStack(spacing: 8) {
                    if !recorder.isRecording {
                        Button {
                            recorder.startRecording()
                        } label: {
                            Label("Start Recording", systemImage: "record.circle")
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.green)
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .padding()
        }
    }

    private var transferSummarySection: some View {
        let status = transferManager.phoneTransferStatus
        return VStack(alignment: .leading, spacing: 8) {
            Text("iPhone transfer")
                .font(.caption)
                .foregroundColor(.secondary)

            Text(status.title)
                .font(.headline)
                .foregroundStyle(statusColor(for: status))
                .accessibilityAddTraits(.isHeader)

            Text(status.detail)
                .font(.caption)
                .foregroundColor(.secondary)

            Button {
                transferManager.transferNewSamples()
            } label: {
                Label("Sync Now", systemImage: "arrow.triangle.2.circlepath")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(!transferManager.canRequestManualSync)
            .accessibilityLabel("Sync Now")
            .accessibilityHint("Queues new Watch motion files for the paired iPhone")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func statusColor(for status: WatchPhoneTransferStatus) -> Color {
        switch status {
        case .empty:
            return .green
        case .waitingForPhone, .preparing:
            return .orange
        case .failed:
            return .red
        case .paused, .unavailable:
            return .primary
        }
    }
}
