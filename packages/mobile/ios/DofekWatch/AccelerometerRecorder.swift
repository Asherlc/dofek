import CoreMotion
import Foundation

// CMSensorDataList only conforms to NSFastEnumeration, not Swift Sequence.
// This extension bridges it so we can use for-in loops.
extension CMSensorDataList: @retroactive Sequence {
    public func makeIterator() -> NSFastEnumerationIterator {
        NSFastEnumerationIterator(self)
    }
}

/// Manages CMSensorRecorder sessions on Apple Watch.
/// Records accelerometer data at 50 Hz in the background, retains up to 3 days of history.
final class AccelerometerRecorder: ObservableObject {
    static let shared = AccelerometerRecorder()

    private let sensorRecorder = CMSensorRecorder()
    private let defaults = UserDefaults.standard

    private let recordingActiveKey = "com.dofek.watch.accelerometer.recordingActive"
    private let lastQueryCursorKey = "com.dofek.watch.accelerometer.lastQueryCursor"
    private let lastTransferKey = "com.dofek.watch.accelerometer.lastTransfer"

    static let maxDurationSeconds: TimeInterval = 12 * 3600 // 12 hours

    /// Batch size for streaming JSON writes. Keeps peak memory to ~500 KB per flush.
    static let streamingBatchSize = 5000

    @Published var isRecording: Bool = false
    @Published var samplesSinceLastTransfer: Int = 0

    var lastTransferDate: Date? {
        defaults.object(forKey: lastTransferKey) as? Date
    }

    init() {
        isRecording = defaults.bool(forKey: recordingActiveKey)
    }

    /// Check if accelerometer recording is supported on this Watch.
    static var isAvailable: Bool {
        CMSensorRecorder.isAccelerometerRecordingAvailable()
    }

    /// Start a 12-hour recording session.
    /// CMSensorRecorder handles overlapping calls gracefully (extends the window).
    /// Safe to call from any thread — @Published updates are dispatched to main.
    func startRecording() {
        guard Self.isAvailable else { return }

        sensorRecorder.recordAccelerometer(forDuration: Self.maxDurationSeconds)
        defaults.set(true, forKey: recordingActiveKey)

        if Thread.isMainThread {
            isRecording = true
        } else {
            DispatchQueue.main.async { self.isRecording = true }
        }
    }

    /// Stream recorded samples directly to a temporary JSON file in batches.
    ///
    /// Unlike the previous `queryNewSamples()` which loaded every sample into a
    /// `[[String: Any]]` array (50 Hz × 12 h = 2.16 M entries ≈ 860 MB), this
    /// method writes JSON in batches of `streamingBatchSize` entries, keeping peak
    /// memory at ~500 KB regardless of recording duration.
    ///
    /// **Thread safety**: This method does not update any `@Published` properties.
    /// The caller is responsible for updating `samplesSinceLastTransfer` on the
    /// main thread after the call returns.
    ///
    /// - Returns: The file URL and sample count, or `nil` if no samples are available.
    func streamSamplesToFile() -> (url: URL, count: Int)? {
        guard Self.isAvailable else { return nil }

        let now = Date()
        // CMSensorRecorder requires startTime within 3 days of today.
        // Use 2.9 days to leave margin and avoid edge-case NSExceptions.
        let maxLookback = now.addingTimeInterval(-2.9 * 24 * 3600)
        let fromDate: Date
        if let cursor = defaults.object(forKey: lastQueryCursorKey) as? Date {
            fromDate = max(cursor, maxLookback)
        } else {
            fromDate = maxLookback
        }

        // Don't query if fromDate is in the future or too close to now
        guard fromDate < now.addingTimeInterval(-1) else { return nil }

        guard let sensorData = sensorRecorder.accelerometerData(
            from: fromDate,
            to: now
        ) else {
            return nil
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        let tempFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("accel-raw-\(UUID().uuidString).json")

        FileManager.default.createFile(atPath: tempFile.path, contents: nil)
        guard let handle = try? FileHandle(forWritingTo: tempFile) else { return nil }
        defer { handle.closeFile() }

        handle.write(Data("[".utf8))

        var count = 0
        var totalFlushed = 0
        var batch: [String] = []
        batch.reserveCapacity(Self.streamingBatchSize)

        for record in sensorData {
            guard let accelData = record as? CMRecordedAccelerometerData else { continue }

            let timestamp = Date(
                timeIntervalSinceReferenceDate: accelData.startDate.timeIntervalSinceReferenceDate
            )
            let entry = "{\"timestamp\":\"\(formatter.string(from: timestamp))\","
                + "\"x\":\(accelData.acceleration.x),"
                + "\"y\":\(accelData.acceleration.y),"
                + "\"z\":\(accelData.acceleration.z)}"

            batch.append(entry)
            count += 1

            if batch.count >= Self.streamingBatchSize {
                let prefix = totalFlushed > 0 ? "," : ""
                let chunk = prefix + batch.joined(separator: ",")
                handle.write(Data(chunk.utf8))
                totalFlushed += batch.count
                batch.removeAll(keepingCapacity: true)
            }
        }

        // Flush remaining entries
        if !batch.isEmpty {
            let prefix = totalFlushed > 0 ? "," : ""
            let chunk = prefix + batch.joined(separator: ",")
            handle.write(Data(chunk.utf8))
        }

        handle.write(Data("]".utf8))

        guard count > 0 else {
            try? FileManager.default.removeItem(at: tempFile)
            return nil
        }

        // Advance the query cursor (UserDefaults is thread-safe)
        defaults.set(now, forKey: lastQueryCursorKey)

        return (url: tempFile, count: count)
    }

    /// Mark a successful transfer by updating the transfer timestamp.
    func markTransferComplete() {
        defaults.set(Date(), forKey: lastTransferKey)
        samplesSinceLastTransfer = 0
    }
}
