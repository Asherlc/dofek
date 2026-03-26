import Foundation
import WatchConnectivity

/// Coordinates querying accelerometer samples and sending them to the paired iPhone
/// via WCSession.transferFile(). Files are gzip-compressed JSON arrays.
final class TransferManager: ObservableObject {
    private let recorder: AccelerometerRecorder
    private let session: WCSession

    @Published var isTransferring: Bool = false
    @Published var lastTransferStatus: String = "Idle"

    init(recorder: AccelerometerRecorder, session: WCSession = .default) {
        self.recorder = recorder
        self.session = session
    }

    /// Query new samples from the recorder, serialize to gzip JSON, and transfer
    /// to the paired iPhone via WCSession.
    func transferNewSamples() {
        guard session.activationState == .activated else {
            lastTransferStatus = "Session not active"
            return
        }
        guard session.isReachable || session.isCompanionAppInstalled else {
            lastTransferStatus = "iPhone not available"
            return
        }

        isTransferring = true
        lastTransferStatus = "Querying samples..."

        let samples = recorder.queryNewSamples()

        guard !samples.isEmpty else {
            isTransferring = false
            lastTransferStatus = "No new samples"
            return
        }

        lastTransferStatus = "Compressing \(samples.count) samples..."

        do {
            // Serialize to JSON
            let jsonData = try JSONSerialization.data(withJSONObject: samples)

            // Gzip compress
            let compressedData = try (jsonData as NSData).compressed(using: .zlib) as Data

            // Write to temp file
            let tempDirectory = FileManager.default.temporaryDirectory
            let fileName = "accel-\(ISO8601DateFormatter().string(from: Date())).json.gz"
            let fileURL = tempDirectory.appendingPathComponent(fileName)
            try compressedData.write(to: fileURL)

            // Transfer via WCSession
            let metadata: [String: Any] = [
                "type": "accelerometer_samples",
                "sampleCount": samples.count,
                "transferredAt": ISO8601DateFormatter().string(from: Date()),
            ]

            session.transferFile(fileURL, metadata: metadata)

            recorder.markTransferComplete()
            lastTransferStatus = "Sent \(samples.count) samples (\(compressedData.count / 1024) KB)"
            isTransferring = false

        } catch {
            lastTransferStatus = "Error: \(error.localizedDescription)"
            isTransferring = false
        }
    }
}
