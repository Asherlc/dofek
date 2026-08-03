import Foundation

/// Retains gyroscope samples until the file containing them is delivered.
///
/// A snapshot is non-destructive. Confirming a delivered snapshot removes only
/// its prefix, leaving samples recorded while the transfer was in flight.
final class GyroscopeSampleBuffer {
    private var samples: [[String: Any]] = []
    private let lock = NSLock()

    func append(_ sample: [String: Any]) {
        lock.lock()
        samples.append(sample)
        lock.unlock()
    }

    func snapshot() -> [[String: Any]] {
        lock.lock()
        let snapshot = samples
        lock.unlock()
        return snapshot
    }

    func confirmTransferredSamples(count: Int) {
        guard count > 0 else { return }

        lock.lock()
        if count <= samples.count {
            samples.removeFirst(count)
        }
        lock.unlock()
    }

    func clearAll() {
        lock.lock()
        samples.removeAll()
        lock.unlock()
    }

    var count: Int {
        lock.lock()
        let count = samples.count
        lock.unlock()
        return count
    }
}
