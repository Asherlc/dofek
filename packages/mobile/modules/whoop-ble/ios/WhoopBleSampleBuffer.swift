import Foundation

/// Thread-safe buffer for accumulating and draining WHOOP BLE samples.
/// Handles both IMU (accelerometer + gyroscope) and realtime (HR + quaternion) data.
/// Serializes samples to bridge-compatible dictionaries for the JS layer.
final class WhoopBleSampleBuffer {
    private var imuSamples: [WhoopImuSample] = []
    private var realtimeDataSamples: [WhoopRealtimeDataSample] = []
    private let lock = NSLock()

    private static let maxImuBufferSize = 500_000   // ~100 minutes at 80 Hz
    private static let maxRealtimeBufferSize = 86_400 // 24 hours at 1 Hz

    private(set) var overflowCount: UInt64 = 0

    var imuSampleCount: Int {
        lock.lock()
        let count = imuSamples.count
        lock.unlock()
        return count
    }

    var realtimeSampleCount: Int {
        lock.lock()
        let count = realtimeDataSamples.count
        lock.unlock()
        return count
    }

    // MARK: - Append

    func appendImuSamples(_ samples: [WhoopImuSample]) {
        guard !samples.isEmpty else { return }
        lock.lock()
        imuSamples.append(contentsOf: samples)
        if imuSamples.count > Self.maxImuBufferSize {
            let overflow = imuSamples.count - Self.maxImuBufferSize
            imuSamples.removeFirst(overflow)
            overflowCount += 1
            NSLog("[WhoopBLE] IMU buffer overflow: dropped %d oldest samples (overflow #%llu)",
                  overflow, overflowCount)
        }
        lock.unlock()
    }

    func appendRealtimeData(_ samples: [WhoopRealtimeDataSample]) {
        guard !samples.isEmpty else { return }
        lock.lock()
        realtimeDataSamples.append(contentsOf: samples)
        if realtimeDataSamples.count > Self.maxRealtimeBufferSize {
            let overflow = realtimeDataSamples.count - Self.maxRealtimeBufferSize
            realtimeDataSamples.removeFirst(overflow)
        }
        lock.unlock()
    }

    /// Clear all buffered samples (e.g., on streaming start).
    func clearAll() {
        lock.lock()
        imuSamples.removeAll()
        realtimeDataSamples.removeAll()
        lock.unlock()
    }

    // MARK: - Peek (read without removing)

    /// Peek at up to `maxCount` IMU samples WITHOUT removing them.
    /// Call `confirmImuDrain(count:)` after successful upload to remove.
    func peekImuSamples(maxCount: Int = 1000) -> [[String: Any]] {
        lock.lock()
        let peekCount = min(maxCount, imuSamples.count)
        let samples = Array(imuSamples.prefix(peekCount))
        lock.unlock()

        return serializeImuSamples(samples)
    }

    /// Peek at up to `maxCount` realtime data samples WITHOUT removing them.
    /// Call `confirmRealtimeDataDrain(count:)` after successful upload to remove.
    func peekRealtimeData(maxCount: Int = 1000) -> [[String: Any]] {
        lock.lock()
        let peekCount = min(maxCount, realtimeDataSamples.count)
        let samples = Array(realtimeDataSamples.prefix(peekCount))
        lock.unlock()

        return serializeRealtimeData(samples)
    }

    // MARK: - Confirm drain (remove after successful upload)

    /// Remove the first `count` IMU samples from the buffer.
    /// Call after a successful upload to commit the drain.
    func confirmImuDrain(count: Int) {
        lock.lock()
        let removeCount = min(count, imuSamples.count)
        imuSamples.removeFirst(removeCount)
        let remaining = imuSamples.count
        lock.unlock()

        NSLog("[WhoopBLE] confirmImuDrain: removed %d samples (%d remaining)", removeCount, remaining)
    }

    /// Remove the first `count` realtime data samples from the buffer.
    /// Call after a successful upload to commit the drain.
    func confirmRealtimeDataDrain(count: Int) {
        lock.lock()
        let removeCount = min(count, realtimeDataSamples.count)
        realtimeDataSamples.removeFirst(removeCount)
        let remaining = realtimeDataSamples.count
        lock.unlock()

        NSLog("[WhoopBLE] confirmRealtimeDataDrain: removed %d samples (%d remaining)",
              removeCount, remaining)
    }

    // MARK: - Legacy drain (peek + immediate confirm, used by getDataPathStats)

    /// Drain up to `maxCount` IMU samples, serialized for the JS bridge.
    /// Removes samples immediately — prefer peek + confirm for upload paths.
    func drainImuSamples(maxCount: Int = 1000) -> [[String: Any]] {
        lock.lock()
        let drainCount = min(maxCount, imuSamples.count)
        let samples = Array(imuSamples.prefix(drainCount))
        imuSamples.removeFirst(drainCount)
        let remaining = imuSamples.count
        lock.unlock()

        NSLog("[WhoopBLE] drainImuSamples: %d samples (%d remaining)", drainCount, remaining)
        return serializeImuSamples(samples)
    }

    /// Drain up to `maxCount` realtime data samples, serialized for the JS bridge.
    /// Removes samples immediately — prefer peek + confirm for upload paths.
    func drainRealtimeData(maxCount: Int = 1000) -> [[String: Any]] {
        lock.lock()
        let drainCount = min(maxCount, realtimeDataSamples.count)
        let samples = Array(realtimeDataSamples.prefix(drainCount))
        realtimeDataSamples.removeFirst(drainCount)
        let remaining = realtimeDataSamples.count
        lock.unlock()

        NSLog("[WhoopBLE] drainRealtimeData: %d samples (%d remaining)", drainCount, remaining)
        return serializeRealtimeData(samples)
    }

    // MARK: - Serialization

    private func serializeImuSamples(_ samples: [WhoopImuSample]) -> [[String: Any]] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let samplingInterval = 1.0 / 50.0

        return samples.map { sample in
            let baseTime = TimeInterval(sample.timestampSeconds)
                + TimeInterval(sample.subSeconds) / 1000.0
            let sampleTime = baseTime + Double(sample.sampleIndex) * samplingInterval
            let date = Date(timeIntervalSince1970: sampleTime)

            return [
                "timestamp": formatter.string(from: date),
                "accelerometerX": Double(sample.accelerometerX),
                "accelerometerY": Double(sample.accelerometerY),
                "accelerometerZ": Double(sample.accelerometerZ),
                "gyroscopeX": Double(sample.gyroscopeX),
                "gyroscopeY": Double(sample.gyroscopeY),
                "gyroscopeZ": Double(sample.gyroscopeZ),
            ]
        }
    }

    private func serializeRealtimeData(_ samples: [WhoopRealtimeDataSample]) -> [[String: Any]] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        return samples.map { sample in
            let baseTime = TimeInterval(sample.timestampSeconds)
                + TimeInterval(sample.subSeconds) / 1000.0
            let date = Date(timeIntervalSince1970: baseTime)

            return [
                "timestamp": formatter.string(from: date),
                "heartRate": Int(sample.heartRate),
                "rrIntervalMs": Int(sample.rrIntervalMs),
                "quaternionW": Double(sample.quaternionW),
                "quaternionX": Double(sample.quaternionX),
                "quaternionY": Double(sample.quaternionY),
                "quaternionZ": Double(sample.quaternionZ),
                "opticalRawHex": sample.opticalBytes.map { String(format: "%02x", $0) }.joined(),
            ]
        }
    }
}
