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

/// Thread-safe buffer accumulating heart-rate samples until the JS layer drains
/// them for upload. Serializes samples into bridge-compatible dictionaries.
///
/// Uses the same peek-then-confirm drain pattern as the WHOOP BLE buffer so an
/// upload failure leaves samples in place for retry rather than losing them.
final class BleHeartRateSampleBuffer {
    private var samples: [BleHeartRateSample] = []
    private var deviceErasureCutoff: Date?
    private let lock = NSLock()
    private let drainCursor = PeekConfirmDrainCursor()

    /// ~24 hours at 1 Hz — heart-rate straps notify roughly once per second.
    private static let maxBufferSize = 86_400

    private(set) var overflowCount: UInt64 = 0

    var sampleCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return samples.count
    }

    func sampleCount(for deviceId: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return samples.count(where: { $0.deviceId == deviceId })
    }

    func append(_ sample: BleHeartRateSample) {
        lock.lock()
        defer { lock.unlock() }
        guard deviceErasureCutoff.map({ sample.timestamp > $0 }) ?? true else {
            return
        }
        samples.append(sample)
        if samples.count > Self.maxBufferSize {
            let overflow = samples.count - Self.maxBufferSize
            samples.removeFirst(overflow)
            drainCursor.recordHeadRemoval(count: overflow)
            overflowCount += 1
        }
    }

    func clearAll() {
        lock.lock()
        drainCursor.recordHeadRemoval(count: samples.count)
        samples.removeAll()
        lock.unlock()
    }

    func advanceErasureCutoff(to candidate: Date) {
        lock.lock()
        defer { lock.unlock() }
        let cutoff = deviceErasureCutoff.map { max($0, candidate) } ?? candidate
        deviceErasureCutoff = cutoff
        let previousCount = samples.count
        samples.removeAll { $0.timestamp <= cutoff }
        drainCursor.recordHeadRemoval(count: previousCount - samples.count)
    }

    /// Peek at up to `maxCount` samples WITHOUT removing them.
    /// Call `confirmDrain(count:)` after a successful upload to remove them.
    func peekSamples(maxCount: Int = 1000) -> [[String: Any]] {
        lock.lock()
        // Clamp to a non-negative count so a negative bridge argument yields an
        // empty batch rather than trapping in `prefix`.
        let peekCount = max(0, min(maxCount, samples.count))
        let peeked = Array(samples.prefix(peekCount))
        drainCursor.recordPeek()
        lock.unlock()
        return serialize(peeked)
    }

    /// Remove the first `count` samples from the buffer after a successful upload.
    func confirmDrain(count: Int) {
        lock.lock()
        let removeCount = drainCursor.confirmRemovalCount(requestedCount: count, bufferedCount: samples.count)
        samples.removeFirst(removeCount)
        drainCursor.recordHeadRemoval(count: removeCount)
        lock.unlock()
    }

    private func serialize(_ samples: [BleHeartRateSample]) -> [[String: Any]] {
        // Use a local formatter: ISO8601DateFormatter is not thread-safe, and
        // serialize runs after releasing the buffer lock, so a shared instance
        // could be raced by concurrent drain calls. It is allocated once per
        // page (not per sample), so the cost is negligible.
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return samples.map { sample in
            [
                "deviceId": sample.deviceId,
                "timestamp": formatter.string(from: sample.timestamp),
                "heartRateBpm": sample.heartRateBpm,
                "rrIntervalsMs": sample.rrIntervalsMs,
            ]
        }
    }
}
