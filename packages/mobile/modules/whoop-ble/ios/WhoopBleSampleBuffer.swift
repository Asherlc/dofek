import Foundation

private final class PeekConfirmDrainCursor {
    private var headSequence: UInt64 = 0
    private var lastPeekBaseSequence: UInt64 = 0
    private var hasInFlightPeek = false

    func recordPeek() {
        guard !hasInFlightPeek else { return }
        lastPeekBaseSequence = headSequence
        hasInFlightPeek = true
    }

    func recordHeadRemoval(count: Int) {
        guard count > 0 else { return }
        headSequence += UInt64(count)
    }

    func confirmRemovalCount(requestedCount: Int, bufferedCount: Int) -> Int {
        let requestedCount = max(0, requestedCount)
        defer { hasInFlightPeek = false }
        guard hasInFlightPeek else {
            return min(requestedCount, bufferedCount)
        }
        let evictedSincePeek = headSequence - lastPeekBaseSequence
        guard evictedSincePeek < UInt64(requestedCount) else { return 0 }
        return min(requestedCount - Int(evictedSincePeek), bufferedCount)
    }
}

private struct DeviceScopedSample<Sample> {
    let deviceId: String
    let sample: Sample
}

/// Thread-safe buffer for accumulating and draining WHOOP BLE samples.
/// Handles both IMU (accelerometer + gyroscope) and realtime (beat interval + quaternion) data.
/// Serializes samples to bridge-compatible dictionaries for the JS layer.
final class WhoopBleSampleBuffer {
    private var imuSamples: [DeviceScopedSample<WhoopImuSample>] = []
    private var realtimeDataSamples: [DeviceScopedSample<WhoopRealtimeDataSample>] = []
    private var deviceErasureCutoff: Date?
    private let lock = NSLock()
    private let imuDrainCursor = PeekConfirmDrainCursor()
    private let realtimeDrainCursor = PeekConfirmDrainCursor()

    private static let maxImuBufferSize = 500_000   // ~83 minutes at 100 Hz (R21 frames)
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

    func appendImuSamples(_ samples: [WhoopImuSample], deviceId: String = "WHOOP Strap") {
        guard !samples.isEmpty else { return }
        lock.lock()
        let accepted = samples.filter { sample in
            guard let cutoff = deviceErasureCutoff else { return true }
            return self.imuSampleDate(sample) > cutoff
        }
        imuSamples.append(contentsOf: accepted.map {
            DeviceScopedSample(deviceId: deviceId, sample: $0)
        })
        if imuSamples.count > Self.maxImuBufferSize {
            let overflow = imuSamples.count - Self.maxImuBufferSize
            imuSamples.removeFirst(overflow)
            imuDrainCursor.recordHeadRemoval(count: overflow)
            overflowCount += 1
            NSLog("[WhoopBLE] IMU buffer overflow: dropped %d oldest samples (overflow #%llu)",
                  overflow, overflowCount)
        }
        lock.unlock()
    }

    func appendRealtimeData(
        _ samples: [WhoopRealtimeDataSample],
        deviceId: String = "WHOOP Strap"
    ) {
        guard !samples.isEmpty else { return }
        lock.lock()
        let accepted = samples.filter { sample in
            guard let cutoff = deviceErasureCutoff else { return true }
            return self.realtimeSampleDate(sample) > cutoff
        }
        realtimeDataSamples.append(contentsOf: accepted.map {
            DeviceScopedSample(deviceId: deviceId, sample: $0)
        })
        if realtimeDataSamples.count > Self.maxRealtimeBufferSize {
            let overflow = realtimeDataSamples.count - Self.maxRealtimeBufferSize
            realtimeDataSamples.removeFirst(overflow)
            realtimeDrainCursor.recordHeadRemoval(count: overflow)
        }
        lock.unlock()
    }

    /// Clear all buffered samples (e.g., on streaming start).
    func clearAll() {
        lock.lock()
        imuDrainCursor.recordHeadRemoval(count: imuSamples.count)
        realtimeDrainCursor.recordHeadRemoval(count: realtimeDataSamples.count)
        imuSamples.removeAll()
        realtimeDataSamples.removeAll()
        lock.unlock()
    }

    func advanceErasureCutoff(to candidate: Date) {
        lock.lock()
        defer { lock.unlock() }
        let cutoff = deviceErasureCutoff.map { max($0, candidate) } ?? candidate
        deviceErasureCutoff = cutoff

        let imuHeadRemovalCount = imuSamples.prefix {
            imuSampleDate($0.sample) <= cutoff
        }.count
        imuSamples.removeAll { imuSampleDate($0.sample) <= cutoff }
        imuDrainCursor.recordHeadRemoval(count: imuHeadRemovalCount)

        let realtimeHeadRemovalCount = realtimeDataSamples.prefix {
            realtimeSampleDate($0.sample) <= cutoff
        }.count
        realtimeDataSamples.removeAll {
            realtimeSampleDate($0.sample) <= cutoff
        }
        realtimeDrainCursor.recordHeadRemoval(count: realtimeHeadRemovalCount)
    }

    // MARK: - Peek (read without removing)

    /// Peek at up to `maxCount` IMU samples WITHOUT removing them.
    /// Call `confirmImuDrain(count:)` after successful upload to remove.
    func peekImuSamples(maxCount: Int = 1000) -> [[String: Any]] {
        lock.lock()
        let peekCount = max(0, min(maxCount, imuSamples.count))
        let samples = Array(imuSamples.prefix(peekCount))
        imuDrainCursor.recordPeek()
        lock.unlock()

        return serializeImuSamples(samples)
    }

    /// Peek at up to `maxCount` realtime data samples WITHOUT removing them.
    /// Call `confirmRealtimeDataDrain(count:)` after successful upload to remove.
    func peekRealtimeData(maxCount: Int = 1000) -> [[String: Any]] {
        lock.lock()
        let peekCount = max(0, min(maxCount, realtimeDataSamples.count))
        let samples = Array(realtimeDataSamples.prefix(peekCount))
        realtimeDrainCursor.recordPeek()
        lock.unlock()

        return serializeRealtimeData(samples)
    }

    // MARK: - Confirm drain (remove after successful upload)

    /// Remove the first `count` IMU samples from the buffer.
    /// Call after a successful upload to commit the drain.
    func confirmImuDrain(count: Int) {
        lock.lock()
        let removeCount = imuDrainCursor.confirmRemovalCount(requestedCount: count, bufferedCount: imuSamples.count)
        imuSamples.removeFirst(removeCount)
        imuDrainCursor.recordHeadRemoval(count: removeCount)
        let remaining = imuSamples.count
        lock.unlock()

        NSLog("[WhoopBLE] confirmImuDrain: removed %d samples (%d remaining)", removeCount, remaining)
    }

    /// Remove the first `count` realtime data samples from the buffer.
    /// Call after a successful upload to commit the drain.
    func confirmRealtimeDataDrain(count: Int) {
        lock.lock()
        let removeCount = realtimeDrainCursor.confirmRemovalCount(
            requestedCount: count,
            bufferedCount: realtimeDataSamples.count
        )
        realtimeDataSamples.removeFirst(removeCount)
        realtimeDrainCursor.recordHeadRemoval(count: removeCount)
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
        imuDrainCursor.recordHeadRemoval(count: drainCount)
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
        realtimeDrainCursor.recordHeadRemoval(count: drainCount)
        let remaining = realtimeDataSamples.count
        lock.unlock()

        NSLog("[WhoopBLE] drainRealtimeData: %d samples (%d remaining)", drainCount, remaining)
        return serializeRealtimeData(samples)
    }

    // MARK: - Serialization

    /// Clamp a timestamp to a sane range: no earlier than year 2000, no more than 5 min in the future.
    private func clampTimestamp(_ timestampSeconds: UInt32, _ subSeconds: UInt16) -> TimeInterval {
        let rawInterval = TimeInterval(timestampSeconds) + TimeInterval(subSeconds) / 1000.0
        let now = Date()
        let maxFuture = now.addingTimeInterval(300).timeIntervalSince1970
        let minPast = Date(timeIntervalSince1970: 946684800).timeIntervalSince1970 // year 2000

        if rawInterval > maxFuture {
            NSLog("[WhoopBLE] sample timestamp %f clamped to max future", rawInterval)
            return maxFuture
        }
        if rawInterval < minPast {
            NSLog("[WhoopBLE] sample timestamp %f clamped to min past", rawInterval)
            return minPast
        }
        return rawInterval
    }

    private func imuSampleDate(_ sample: WhoopImuSample) -> Date {
        let samplingInterval =
            sample.samplesInFrame > 0 ? 1 / Double(sample.samplesInFrame) : 0.01
        return Date(
            timeIntervalSince1970:
                TimeInterval(sample.timestampSeconds)
                + TimeInterval(sample.subSeconds) / 1_000
                + Double(sample.sampleIndex) * samplingInterval
        )
    }

    private func realtimeSampleDate(_ sample: WhoopRealtimeDataSample) -> Date {
        Date(
            timeIntervalSince1970:
                TimeInterval(sample.timestampSeconds)
                + TimeInterval(sample.subSeconds) / 1_000
        )
    }

    private func serializeImuSamples(_ samples: [DeviceScopedSample<WhoopImuSample>]) -> [[String: Any]] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        return samples.map { scopedSample in
            let sample = scopedSample.sample
            // Derive per-sample interval from the frame's sample count.
            // Each frame spans ~1 second, so interval = 1.0 / samplesInFrame.
            // Typical values: 100 (R21 packets) or variable (0x33/0x34 streams).
            let samplingInterval = sample.samplesInFrame > 0
                ? 1.0 / Double(sample.samplesInFrame)
                : 1.0 / 100.0 // fallback for legacy samples without frame count
            let baseTime = clampTimestamp(sample.timestampSeconds, sample.subSeconds)
            let sampleTime = baseTime + Double(sample.sampleIndex) * samplingInterval
            let date = Date(timeIntervalSince1970: sampleTime)

            return [
                "deviceId": scopedSample.deviceId,
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

    private func serializeRealtimeData(
        _ samples: [DeviceScopedSample<WhoopRealtimeDataSample>]
    ) -> [[String: Any]] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        return samples.map { scopedSample in
            let sample = scopedSample.sample
            let baseTime = clampTimestamp(sample.timestampSeconds, sample.subSeconds)
            let date = Date(timeIntervalSince1970: baseTime)

            return [
                "deviceId": scopedSample.deviceId,
                "timestamp": formatter.string(from: date),
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
