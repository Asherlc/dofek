import Compression
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

    /// Compress a file using streaming zlib compression.
    ///
    /// Uses `Data(contentsOf:options:.mappedIfSafe)` to memory-map the source file,
    /// so the OS pages data in on demand (~64 KB at a time) instead of loading the
    /// entire file into RAM. Output is written in chunks via FileHandle.
    ///
    /// - Returns: The size of the compressed file in bytes.
    static func compressFile(from sourceURL: URL, to destURL: URL) throws -> Int {
        let sourceData = try Data(contentsOf: sourceURL, options: .mappedIfSafe)

        FileManager.default.createFile(atPath: destURL.path, contents: nil)
        let outputHandle = try FileHandle(forWritingTo: destURL)
        defer { outputHandle.closeFile() }

        let bufferSize = 65_536
        let outputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { outputBuffer.deallocate() }

        var stream = compression_stream()
        guard compression_stream_init(
            &stream, COMPRESSION_STREAM_ENCODE, COMPRESSION_ZLIB
        ) == COMPRESSION_STATUS_OK else {
            throw NSError(
                domain: "DofekWatch.Compression", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to initialize compression stream"]
            )
        }
        defer { compression_stream_destroy(&stream) }

        var compressedSize = 0

        try sourceData.withUnsafeBytes { (rawBuffer: UnsafeRawBufferPointer) in
            guard let baseAddress = rawBuffer.baseAddress else { return }

            stream.src_ptr = baseAddress.assumingMemoryBound(to: UInt8.self)
            stream.src_size = rawBuffer.count

            var status = COMPRESSION_STATUS_OK

            repeat {
                stream.dst_ptr = outputBuffer
                stream.dst_size = bufferSize

                let flags = stream.src_size == 0
                    ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue)
                    : Int32(0)

                status = compression_stream_process(&stream, flags)

                let produced = bufferSize - stream.dst_size
                if produced > 0 {
                    outputHandle.write(Data(bytes: outputBuffer, count: produced))
                    compressedSize += produced
                }

                if status == COMPRESSION_STATUS_ERROR {
                    throw NSError(
                        domain: "DofekWatch.Compression", code: -2,
                        userInfo: [NSLocalizedDescriptionKey: "Compression stream error"]
                    )
                }
            } while status == COMPRESSION_STATUS_OK
        }

        return compressedSize
    }
}
