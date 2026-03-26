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
    private let sensorRecorder = CMSensorRecorder()
    private let defaults = UserDefaults.standard

    private let recordingActiveKey = "com.dofek.watch.accelerometer.recordingActive"
    private let lastQueryCursorKey = "com.dofek.watch.accelerometer.lastQueryCursor"
    private let lastTransferKey = "com.dofek.watch.accelerometer.lastTransfer"

    static let maxDurationSeconds: TimeInterval = 12 * 3600 // 12 hours

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
    func startRecording() {
        guard Self.isAvailable else { return }

        sensorRecorder.recordAccelerometer(forDuration: Self.maxDurationSeconds)
        isRecording = true
        defaults.set(true, forKey: recordingActiveKey)
    }

    /// Query recorded samples from the last query cursor to now.
    /// Returns an array of sample dictionaries ready for JSON serialization.
    func queryNewSamples() -> [[String: Any]] {
        guard Self.isAvailable else { return [] }

        let now = Date()
        let fromDate: Date
        if let cursor = defaults.object(forKey: lastQueryCursorKey) as? Date {
            fromDate = cursor
        } else {
            // First query: go back 3 days (max CMSensorRecorder retention)
            fromDate = now.addingTimeInterval(-3 * 24 * 3600)
        }

        // Don't query if fromDate is in the future or too close to now
        guard fromDate < now.addingTimeInterval(-1) else { return [] }

        guard let sensorData = sensorRecorder.accelerometerData(
            from: fromDate,
            to: now
        ) else {
            return []
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        var samples: [[String: Any]] = []
        for record in sensorData {
            guard let accelData = record as? CMRecordedAccelerometerData else { continue }

            let timestamp = Date(
                timeIntervalSinceReferenceDate: accelData.startDate.timeIntervalSinceReferenceDate
            )
            samples.append([
                "timestamp": formatter.string(from: timestamp),
                "x": accelData.acceleration.x,
                "y": accelData.acceleration.y,
                "z": accelData.acceleration.z,
            ])
        }

        // Advance the query cursor
        defaults.set(now, forKey: lastQueryCursorKey)
        samplesSinceLastTransfer = samples.count

        return samples
    }

    /// Mark a successful transfer by updating the transfer timestamp.
    func markTransferComplete() {
        defaults.set(Date(), forKey: lastTransferKey)
        samplesSinceLastTransfer = 0
    }
}
