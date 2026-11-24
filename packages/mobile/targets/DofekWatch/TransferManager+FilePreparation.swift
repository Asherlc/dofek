import Foundation

extension TransferManager {
    /// Compress a file using zlib via Foundation's NSData.compressed(using:).
    ///
    /// Uses memory-mapped input so large recordings do not need to be loaded into
    /// memory all at once.
    static func compressFile(from sourceURL: URL, to destURL: URL) throws -> Int {
        let sourceData = try Data(contentsOf: sourceURL, options: .mappedIfSafe)
        let compressedData = try (sourceData as NSData).compressed(using: .zlib) as Data
        try compressedData.write(to: destURL)
        return compressedData.count
    }

    /// Maximum time difference (in seconds) for merging an accel sample
    /// with a gyro sample into a single 6-axis IMU sample.
    private static let mergeToleranceSeconds: TimeInterval = 0.020 // 20ms = one 50Hz tick

    /// Merge gyroscope data into an accelerometer JSON file.
    ///
    /// Reads the accel JSON, matches gyro samples by timestamp within 20ms,
    /// and writes the merged 6-axis data to a new file.
    func mergeGyroscopeIntoFile(
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
}
