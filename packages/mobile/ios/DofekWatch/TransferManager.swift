import Foundation
import WatchConnectivity

/// Coordinates querying accelerometer + gyroscope samples and sending them
/// to the paired iPhone via WCSession.transferFile().
/// Files are gzip-compressed JSON arrays.
final class TransferManager: ObservableObject {
    private let accelerometerRecorder: AccelerometerRecorder
    private let gyroscopeRecorder: GyroscopeRecorder
    private let session: WCSession

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

        let accelSamples = accelerometerRecorder.queryNewSamples()
        let gyroSamples = gyroscopeRecorder.queryNewSamples()

        let merged = mergeSamples(accel: accelSamples, gyro: gyroSamples)

        guard !merged.isEmpty else {
            isTransferring = false
            lastTransferStatus = "No new samples"
            return
        }

        lastTransferStatus = "Compressing \(merged.count) samples..."

        do {
            // Serialize to JSON
            let jsonData = try JSONSerialization.data(withJSONObject: merged)

            // Gzip compress
            let compressedData = try (jsonData as NSData).compressed(using: .zlib) as Data

            // Write to temp file
            let tempDirectory = FileManager.default.temporaryDirectory
            let fileName = "imu-\(ISO8601DateFormatter().string(from: Date())).json.gz"
            let fileURL = tempDirectory.appendingPathComponent(fileName)
            try compressedData.write(to: fileURL)

            // Transfer via WCSession
            let metadata: [String: Any] = [
                "type": "accelerometer_samples",
                "sampleCount": merged.count,
                "hasGyroscope": !gyroSamples.isEmpty,
                "transferredAt": ISO8601DateFormatter().string(from: Date()),
            ]

            session.transferFile(fileURL, metadata: metadata)

            accelerometerRecorder.markTransferComplete()
            lastTransferStatus = "Sent \(merged.count) samples (\(compressedData.count / 1024) KB)"
            isTransferring = false

        } catch {
            lastTransferStatus = "Error: \(error.localizedDescription)"
            isTransferring = false
        }
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
}
