import Foundation

/// Thread-safe buffer accumulating heart-rate samples until the JS layer drains
/// them for upload. Serializes samples into bridge-compatible dictionaries.
///
/// Uses the same peek-then-confirm drain pattern as the WHOOP BLE buffer so an
/// upload failure leaves samples in place for retry rather than losing them.
final class BleHeartRateSampleBuffer {
    private var samples: [BleHeartRateSample] = []
    private let lock = NSLock()

    /// ~24 hours at 1 Hz — heart-rate straps notify roughly once per second.
    private static let maxBufferSize = 86_400

    private(set) var overflowCount: UInt64 = 0

    var sampleCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return samples.count
    }

    func append(_ sample: BleHeartRateSample) {
        lock.lock()
        defer { lock.unlock() }
        samples.append(sample)
        if samples.count > Self.maxBufferSize {
            let overflow = samples.count - Self.maxBufferSize
            samples.removeFirst(overflow)
            overflowCount += 1
        }
    }

    func clearAll() {
        lock.lock()
        samples.removeAll()
        lock.unlock()
    }

    /// Peek at up to `maxCount` samples WITHOUT removing them.
    /// Call `confirmDrain(count:)` after a successful upload to remove them.
    func peekSamples(maxCount: Int = 1000) -> [[String: Any]] {
        lock.lock()
        // Clamp to a non-negative count so a negative bridge argument yields an
        // empty batch rather than trapping in `prefix`.
        let peekCount = max(0, min(maxCount, samples.count))
        let peeked = Array(samples.prefix(peekCount))
        lock.unlock()
        return serialize(peeked)
    }

    /// Remove the first `count` samples from the buffer after a successful upload.
    func confirmDrain(count: Int) {
        lock.lock()
        let removeCount = max(0, min(count, samples.count))
        samples.removeFirst(removeCount)
        lock.unlock()
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private func serialize(_ samples: [BleHeartRateSample]) -> [[String: Any]] {
        return samples.map { sample in
            [
                "timestamp": Self.isoFormatter.string(from: sample.timestamp),
                "heartRateBpm": sample.heartRateBpm,
                "rrIntervalsMs": sample.rrIntervalsMs,
            ]
        }
    }
}
