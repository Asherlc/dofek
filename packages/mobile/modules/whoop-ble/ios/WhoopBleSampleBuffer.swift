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

private struct BufferDiagnosticCounters {
    var receivedCount = 0
    var confirmedCount = 0
    var overflowDiscardedCount = 0
    var erasureDiscardedCount = 0
    var clearedCount = 0
    var legacyDrainedCount = 0
    var lastConfirmedAt: Date?

    func payload(dates: [Date], formatter: ISO8601DateFormatter) -> [String: Any] {
        [
            "count": dates.count,
            "oldestTimestamp": dates.min().map(formatter.string) ?? NSNull(),
            "newestTimestamp": dates.max().map(formatter.string) ?? NSNull(),
            "receivedCount": receivedCount,
            "confirmedCount": confirmedCount,
            "overflowDiscardedCount": overflowDiscardedCount,
            "erasureDiscardedCount": erasureDiscardedCount,
            "clearedCount": clearedCount,
            "legacyDrainedCount": legacyDrainedCount,
            "lastConfirmedAt": lastConfirmedAt.map(formatter.string) ?? NSNull(),
        ]
    }
}

/// Thread-safe buffer for accumulating and draining WHOOP BLE samples.
/// Handles both IMU (accelerometer + gyroscope) and realtime (heart rate + beat interval + quaternion) data.
/// Serializes samples to bridge-compatible dictionaries for the JS layer.
final class WhoopBleSampleBuffer {
    private var imuSamples: [DeviceScopedSample<WhoopImuSample>] = []
    private var realtimeDataSamples: [DeviceScopedSample<WhoopRealtimeDataSample>] = []
    private var deviceErasureCutoff: Date?
    private let lock = NSLock()
    private let imuDrainCursor = PeekConfirmDrainCursor()
    private let realtimeDrainCursor = PeekConfirmDrainCursor()
    private var imuDiagnostics = BufferDiagnosticCounters()
    private var realtimeDiagnostics = BufferDiagnosticCounters()
    private var bufferInstanceId = UUID().uuidString
    private var bufferCreatedAt: Date
    private var previousCheckpoint: [String: Any]?
    private var lastCheckpointAt: Date?
    private let diagnosticDefaults: UserDefaults
    private let now: () -> Date
    private static let checkpointKey = "dofek_whoop_ble_buffer_checkpoint_v1"

    init(diagnosticDefaults: UserDefaults = .standard, now: @escaping () -> Date = Date.init) {
        self.diagnosticDefaults = diagnosticDefaults
        self.now = now
        self.bufferCreatedAt = now()
        self.previousCheckpoint = diagnosticDefaults.dictionary(forKey: Self.checkpointKey)
            .map(Self.bridgeCheckpoint)
    }

    private static let maxImuBufferSize = 500_000   // ~83 minutes at 100 Hz (R21 frames)
    private static let maxRealtimeBufferSize = 86_400 // 24 hours at 1 Hz

    private(set) var overflowCount: UInt64 = 0

    /// A checkpoint describes observed metadata only; it never restores buffered samples.
    func diagnosticSnapshot() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        var checkpoint = checkpointLocked(at: now())
        checkpoint["previousCheckpoint"] = previousCheckpoint ?? NSNull()
        return checkpoint
    }

    /// Account erasure starts a new diagnostic lifetime and removes unattributed history.
    func resetDiagnosticHistory() {
        lock.lock()
        defer { lock.unlock() }
        previousCheckpoint = nil
        diagnosticDefaults.removeObject(forKey: Self.checkpointKey)
        bufferInstanceId = UUID().uuidString
        bufferCreatedAt = now()
        imuDiagnostics = BufferDiagnosticCounters(receivedCount: imuSamples.count)
        realtimeDiagnostics = BufferDiagnosticCounters(receivedCount: realtimeDataSamples.count)
        overflowCount = 0
        lastCheckpointAt = nil
    }

    private func checkpointIfDueLocked() {
        let timestamp = now()
        guard lastCheckpointAt.map({ timestamp.timeIntervalSince($0) >= 30 }) ?? true else { return }
        _ = checkpointLocked(at: timestamp)
    }

    private func checkpointLocked(at timestamp: Date) -> [String: Any] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let checkpoint: [String: Any] = [
            "bufferInstanceId": bufferInstanceId,
            "bufferCreatedAt": formatter.string(from: bufferCreatedAt),
            "checkpointAt": formatter.string(from: timestamp),
            "imu": imuDiagnostics.payload(dates: imuSamples.map { imuSampleDate($0.sample) }, formatter: formatter),
            "realtime": realtimeDiagnostics.payload(dates: realtimeDataSamples.map { realtimeSampleDate($0.sample) }, formatter: formatter),
        ]
        // UserDefaults accepts property-list values; optional dates are omitted on disk.
        var stored = checkpoint
        for stream in ["imu", "realtime"] {
            stored[stream] = (checkpoint[stream] as? [String: Any])?.filter { !($0.value is NSNull) }
        }
        diagnosticDefaults.set(stored, forKey: Self.checkpointKey)
        lastCheckpointAt = timestamp
        return checkpoint
    }

    private static func bridgeCheckpoint(_ stored: [String: Any]) -> [String: Any] {
        var checkpoint = stored
        for stream in ["imu", "realtime"] {
            var counters = stored[stream] as? [String: Any] ?? [:]
            for field in ["oldestTimestamp", "newestTimestamp", "lastConfirmedAt"] {
                counters[field] = counters[field] ?? NSNull()
            }
            checkpoint[stream] = counters
        }
        return checkpoint
    }

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
        imuDiagnostics.receivedCount += samples.count
        let accepted = samples.filter { sample in
            guard let cutoff = deviceErasureCutoff else { return true }
            return self.imuSampleDate(sample) > cutoff
        }
        imuDiagnostics.erasureDiscardedCount += samples.count - accepted.count
        imuSamples.append(contentsOf: accepted.map {
            DeviceScopedSample(deviceId: deviceId, sample: $0)
        })
        if imuSamples.count > Self.maxImuBufferSize {
            let overflow = imuSamples.count - Self.maxImuBufferSize
            imuSamples.removeFirst(overflow)
            imuDrainCursor.recordHeadRemoval(count: overflow)
            overflowCount += 1
            imuDiagnostics.overflowDiscardedCount += overflow
            NSLog("[WhoopBLE] IMU buffer overflow: dropped %d oldest samples (overflow #%llu)",
                  overflow, overflowCount)
        }
        checkpointIfDueLocked()
        lock.unlock()
    }

    func appendRealtimeData(
        _ samples: [WhoopRealtimeDataSample],
        deviceId: String = "WHOOP Strap"
    ) {
        guard !samples.isEmpty else { return }
        lock.lock()
        realtimeDiagnostics.receivedCount += samples.count
        let accepted = samples.filter { sample in
            guard let cutoff = deviceErasureCutoff else { return true }
            return self.realtimeSampleDate(sample) > cutoff
        }
        realtimeDiagnostics.erasureDiscardedCount += samples.count - accepted.count
        realtimeDataSamples.append(contentsOf: accepted.map {
            DeviceScopedSample(deviceId: deviceId, sample: $0)
        })
        if realtimeDataSamples.count > Self.maxRealtimeBufferSize {
            let overflow = realtimeDataSamples.count - Self.maxRealtimeBufferSize
            realtimeDataSamples.removeFirst(overflow)
            realtimeDrainCursor.recordHeadRemoval(count: overflow)
            realtimeDiagnostics.overflowDiscardedCount += overflow
        }
        checkpointIfDueLocked()
        lock.unlock()
    }

    /// Clear all buffered samples (e.g., on streaming start).
    func clearAll() {
        lock.lock()
        imuDiagnostics.clearedCount += imuSamples.count
        realtimeDiagnostics.clearedCount += realtimeDataSamples.count
        imuDrainCursor.recordHeadRemoval(count: imuSamples.count)
        realtimeDrainCursor.recordHeadRemoval(count: realtimeDataSamples.count)
        imuSamples.removeAll()
        realtimeDataSamples.removeAll()
        _ = checkpointLocked(at: now())
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
        let previousImuCount = imuSamples.count
        imuSamples.removeAll { imuSampleDate($0.sample) <= cutoff }
        imuDiagnostics.erasureDiscardedCount += previousImuCount - imuSamples.count
        imuDrainCursor.recordHeadRemoval(count: imuHeadRemovalCount)

        let realtimeHeadRemovalCount = realtimeDataSamples.prefix {
            realtimeSampleDate($0.sample) <= cutoff
        }.count
        let previousRealtimeCount = realtimeDataSamples.count
        realtimeDataSamples.removeAll {
            realtimeSampleDate($0.sample) <= cutoff
        }
        realtimeDiagnostics.erasureDiscardedCount += previousRealtimeCount - realtimeDataSamples.count
        realtimeDrainCursor.recordHeadRemoval(count: realtimeHeadRemovalCount)
        _ = checkpointLocked(at: now())
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
        imuDiagnostics.confirmedCount += removeCount
        if removeCount > 0 { imuDiagnostics.lastConfirmedAt = now() }
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
        realtimeDiagnostics.confirmedCount += removeCount
        if removeCount > 0 { realtimeDiagnostics.lastConfirmedAt = now() }
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
        imuDiagnostics.legacyDrainedCount += drainCount
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
        realtimeDiagnostics.legacyDrainedCount += drainCount
        let remaining = realtimeDataSamples.count
        lock.unlock()

        NSLog("[WhoopBLE] drainRealtimeData: %d samples (%d remaining)", drainCount, remaining)
        return serializeRealtimeData(samples)
    }

    // MARK: - Serialization

    private func timestampInterval(_ timestampSeconds: UInt32, _ subSeconds: UInt16) -> TimeInterval {
        // R18/R21 clock fractions use 1/32768-second ticks, not milliseconds.
        TimeInterval(timestampSeconds) + TimeInterval(subSeconds) / 32_768.0
    }

    /// Clamp a timestamp to a sane range: no earlier than year 2000, no more than 5 min in the future.
    private func clampTimestamp(_ timestampSeconds: UInt32, _ subSeconds: UInt16) -> TimeInterval {
        let rawInterval = timestampInterval(timestampSeconds, subSeconds)
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
                timestampInterval(sample.timestampSeconds, sample.subSeconds)
                + Double(sample.sampleIndex) * samplingInterval
        )
    }

    private func realtimeSampleDate(_ sample: WhoopRealtimeDataSample) -> Date {
        Date(
            timeIntervalSince1970: timestampInterval(sample.timestampSeconds, sample.subSeconds)
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
                "heartRateBpm": Int(sample.heartRate),
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
