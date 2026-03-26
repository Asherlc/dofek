import SwiftUI

struct ContentView: View {
    @ObservedObject var recorder: AccelerometerRecorder
    @ObservedObject var transferManager: TransferManager
    @ObservedObject var sessionDelegate: WatchSessionDelegate

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // Recording status
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

                Divider()

                // Sync info
                Section {
                    HStack {
                        Image(systemName: sessionDelegate.isIPhoneReachable ? "iphone.circle.fill" : "iphone.circle")
                            .foregroundColor(sessionDelegate.isIPhoneReachable ? .green : .gray)
                        Text(sessionDelegate.isIPhoneReachable ? "iPhone Connected" : "iPhone Not Reachable")
                            .font(.subheadline)
                    }

                    Text("\(recorder.samplesSinceLastTransfer) pending samples")
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

                // Actions
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

                    Button {
                        transferManager.transferNewSamples()
                    } label: {
                        Label("Sync Now", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .buttonStyle(.bordered)
                    .disabled(transferManager.isTransferring)
                }
                .frame(maxWidth: .infinity)
            }
            .padding()
        }
    }
}
