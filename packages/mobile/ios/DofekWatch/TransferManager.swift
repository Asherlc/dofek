import Foundation
import WatchConnectivity

/// Coordinates querying accelerometer samples and sending them to the paired iPhone
/// via WCSession.transferFile(). Files are gzip-compressed JSON arrays.
///
/// All heavy work (sample querying, compression, file I/O) runs on a background
/// queue to avoid blocking the main thread and triggering watchdog kills.
final class TransferManager: ObservableObject {
    private let recorder: AccelerometerRecorder
    private let session: WCSession
    private let workQueue = DispatchQueue(label: "com.dofek.watch.transfer", qos: .utility)

    @Published var isTransferring: Bool = false
    @Published var lastTransferStatus: String = "Idle"

    init(recorder: AccelerometerRecorder, session: WCSession = .default) {
        self.recorder = recorder
        self.session = session
    }

    /// Query new samples from the recorder, serialize to gzip JSON, and transfer
    /// to the paired iPhone via WCSession.
    ///
    /// Safe to call from any thread. @Published updates are dispatched to main.
    /// Heavy work (sample iteration, compression) runs on a background queue.
    func transferNewSamples() {
        // Bounce to main thread for @Published property checks
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in
                self?.transferNewSamples()
            }
            return
        }

        guard !isTransferring else { return }
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

        workQueue.async { [weak self] in
            self?.performTransfer()
        }
    }

    private func performTransfer() {
        // Stream samples to a temp JSON file (memory-efficient)
        guard let result = recorder.streamSamplesToFile() else {
            DispatchQueue.main.async { [weak self] in
                self?.isTransferring = false
                self?.lastTransferStatus = "No new samples"
            }
            return
        }

        DispatchQueue.main.async { [weak self] in
            self?.recorder.samplesSinceLastTransfer = result.count
            self?.lastTransferStatus = "Compressing \(result.count) samples..."
        }

        do {
            // Compress the JSON file using streaming compression (memory-mapped read)
            let compressedURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("accel-\(ISO8601DateFormatter().string(from: Date())).json.gz")
            let compressedSize = try Self.compressFile(from: result.url, to: compressedURL)

            // Clean up the uncompressed temp file
            try? FileManager.default.removeItem(at: result.url)

            // Transfer via WCSession
            let metadata: [String: Any] = [
                "type": "accelerometer_samples",
                "sampleCount": result.count,
                "transferredAt": ISO8601DateFormatter().string(from: Date()),
            ]

            session.transferFile(compressedURL, metadata: metadata)

            DispatchQueue.main.async { [weak self] in
                self?.recorder.markTransferComplete()
                self?.lastTransferStatus = "Sent \(result.count) samples (\(compressedSize / 1024) KB)"
                self?.isTransferring = false
            }

        } catch {
            // Clean up temp files on error
            try? FileManager.default.removeItem(at: result.url)

            DispatchQueue.main.async { [weak self] in
                self?.lastTransferStatus = "Error: \(error.localizedDescription)"
                self?.isTransferring = false
            }
        }
    }

    /// Compress a file using zlib via Foundation's NSData.compressed(using:).
    ///
    /// Uses `Data(contentsOf:options:.mappedIfSafe)` to memory-map the source file
    /// so the OS pages data in on demand rather than loading the entire file into RAM.
    /// The compressed output is typically 10-15x smaller than the input, so holding
    /// it in memory is fine even for large recordings.
    ///
    /// Uses Foundation (no `import Compression` needed) to avoid framework linking
    /// issues when CocoaPods manages the DofekWatch target's build settings.
    ///
    /// - Returns: The size of the compressed file in bytes.
    static func compressFile(from sourceURL: URL, to destURL: URL) throws -> Int {
        let sourceData = try Data(contentsOf: sourceURL, options: .mappedIfSafe)
        let compressedData = try (sourceData as NSData).compressed(using: .zlib) as Data
        try compressedData.write(to: destURL)
        return compressedData.count
    }
}
