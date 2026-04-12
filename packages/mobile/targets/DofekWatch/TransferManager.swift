import Foundation
import WatchConnectivity

/// Coordinates querying accelerometer + gyroscope samples and sending them
/// to the paired iPhone via WCSession.transferFile().
/// Files are gzip-compressed JSON arrays.
///
/// All heavy work (sample querying, compression, file I/O) runs on a background
/// queue to avoid blocking the main thread and triggering watchdog kills.
final class TransferManager: ObservableObject {
    private let accelerometerRecorder: AccelerometerRecorder
    private let gyroscopeRecorder: GyroscopeRecorder
    private let session: WCSession
    private let workQueue = DispatchQueue(label: "com.dofek.watch.transfer", qos: .utility)

    /// Maximum time difference (in seconds) for merging an accel sample
    /// with a gyro sample into a single 6-axis IMU sample.
    private static let mergeToleranceSeconds: TimeInterval = 0.020 // 20ms = one 50Hz tick

    @Published var isTransferring: Bool = false
    @Published var lastTransferStatus: String = "Idle"

    init(
        accelerometerRecorder: AccelerometerRecorder,
        gyroscopeRecorder: GyroscopeRecorder,
        session: WCSession = .default
    ) {
        self.accelerometerRecorder = accelerometerRecorder
        self.gyroscopeRecorder = gyroscopeRecorder
        self.session = session
    }

    /// Query new samples from both recorders, merge by timestamp, serialize
    /// to gzip JSON, and transfer to the paired iPhone via WCSession.
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
        guard let result = accelerometerRecorder.streamSamplesToFile() else {
            DispatchQueue.main.async { [weak self] in
                self?.isTransferring = false
                self?.lastTransferStatus = "No new samples"
            }
            return
        }

        let gyroSamples = gyroscopeRecorder.queryNewSamples()

        DispatchQueue.main.async { [weak self] in
            self?.accelerometerRecorder.samplesSinceLastTransfer = result.count
            self?.lastTransferStatus = "Compressing \(result.count) samples..."
        }

        do {
            // If we have gyroscope data, re-read the accel file, merge, and rewrite
            let fileToCompress: URL
            if !gyroSamples.isEmpty {
                let mergedURL = FileManager.default.temporaryDirectory
                    .appendingPathComponent("imu-merged-\(ISO8601DateFormatter().string(from: Date())).json")
                try mergeGyroscopeIntoFile(accelFileURL: result.url, gyroSamples: gyroSamples, outputURL: mergedURL)
                try? FileManager.default.removeItem(at: result.url)
                fileToCompress = mergedURL
            } else {
                fileToCompress = result.url
            }

            // Compress the JSON file using streaming compression (memory-mapped read)
            let compressedURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("imu-\(ISO8601DateFormatter().string(from: Date())).json.gz")
            let compressedSize = try Self.compressFile(from: fileToCompress, to: compressedURL)

            // Clean up the uncompressed temp file
            try? FileManager.default.removeItem(at: fileToCompress)

            // Transfer via WCSession
            let metadata: [String: Any] = [
                "type": "accelerometer_samples",
                "sampleCount": result.count,
                "hasGyroscope": !gyroSamples.isEmpty,
                "transferredAt": ISO8601DateFormatter().string(from: Date()),
            ]

            session.transferFile(compressedURL, metadata: metadata)

            DispatchQueue.main.async { [weak self] in
                self?.accelerometerRecorder.markTransferComplete()
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

    /// Merge gyroscope data into an accelerometer JSON file.
    ///
    /// Reads the accel JSON, matches gyro samples by timestamp within 20ms,
    /// and writes the merged 6-axis data to a new file.
    private func mergeGyroscopeIntoFile(
        accelFileURL: URL,
        gyroSamples: [[String: Any]],
        outputURL: URL
    ) throws {
        let accelData = try Data(contentsOf: accelFileURL, options: .mappedIfSafe)
        guard let accelArray = try JSONSerialization.jsonObject(with: accelData) as? [[String: Any]] else {
            // If we can't parse, just copy the original file
            try FileManager.default.copyItem(at: accelFileURL, to: outputURL)
            return
        }

        let merged = mergeSamples(accel: accelArray, gyro: gyroSamples)
        let mergedData = try JSONSerialization.data(withJSONObject: merged)
        try mergedData.write(to: outputURL)
    }

    /// Merge accelerometer and gyroscope samples by timestamp.
    ///
    /// Accelerometer samples come from CMSensorRecorder (continuous background).
    /// Gyroscope samples come from CMMotionManager (foreground only).
    /// When timestamps are within 20ms (one 50Hz tick), they're merged into
    /// a single 6-axis sample. Accel-only samples keep null gyro fields.
    private func mergeSamples(
        accel: [[String: Any]],
        gyro: [[String: Any]]
    ) -> [[String: Any]] {
        // If no gyro data, return accel samples as-is
        guard !gyro.isEmpty else { return accel }

        // If no accel data, return gyro samples (unusual but safe)
        guard !accel.isEmpty else { return gyro }

        // Build a lookup from gyro timestamps to gyro samples
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        // Parse gyro samples into (Date, sample) pairs for efficient lookup
        var gyroByDate: [(date: Date, sample: [String: Any])] = []
        for gyroSample in gyro {
            guard let timestampString = gyroSample["timestamp"] as? String,
                  let date = formatter.date(from: timestampString) else { continue }
            gyroByDate.append((date: date, sample: gyroSample))
        }

        // Sort gyro by date for binary-search-like matching
        gyroByDate.sort { $0.date < $1.date }

        var matched = Set<Int>() // indices of gyro samples that were matched
        var result: [[String: Any]] = []

        for accelSample in accel {
            var merged = accelSample

            if let timestampString = accelSample["timestamp"] as? String,
               let accelDate = formatter.date(from: timestampString) {
                // Find closest gyro sample within tolerance
                if let matchIndex = findClosestGyro(
                    accelDate: accelDate,
                    gyroSamples: gyroByDate,
                    tolerance: Self.mergeToleranceSeconds,
                    excluded: matched
                ) {
                    let gyroSample = gyroByDate[matchIndex].sample
                    merged["gyroscopeX"] = gyroSample["gyroscopeX"]
                    merged["gyroscopeY"] = gyroSample["gyroscopeY"]
                    merged["gyroscopeZ"] = gyroSample["gyroscopeZ"]
                    matched.insert(matchIndex)
                }
            }

            result.append(merged)
        }

        return result
    }

    /// Find the closest unmatched gyro sample within the tolerance window.
    private func findClosestGyro(
        accelDate: Date,
        gyroSamples: [(date: Date, sample: [String: Any])],
        tolerance: TimeInterval,
        excluded: Set<Int>
    ) -> Int? {
        var bestIndex: Int?
        var bestDistance: TimeInterval = .greatestFiniteMagnitude

        for (index, gyro) in gyroSamples.enumerated() {
            if excluded.contains(index) { continue }

            let distance = abs(accelDate.timeIntervalSince(gyro.date))
            if distance > tolerance { continue }
            if distance < bestDistance {
                bestDistance = distance
                bestIndex = index
            }
        }

        return bestIndex
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
