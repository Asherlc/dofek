import Foundation

/// Serializes lazy ownership of the one Core Bluetooth central used by the
/// standard heart-rate connection manager.
final class BleHeartRateCentralManagerOwner<Manager> {
    private let queue: DispatchQueue
    private let queueKey = DispatchSpecificKey<UUID>()
    private let queueToken = UUID()
    private var manager: Manager?

    init(queue: DispatchQueue) {
        self.queue = queue
        queue.setSpecific(key: queueKey, value: queueToken)
    }

    func getOrCreate(_ create: () -> Manager) -> Manager {
        withQueue {
            if let manager {
                return manager
            }
            let created = create()
            manager = created
            return created
        }
    }

    var current: Manager? {
        withQueue { manager }
    }

    private func withQueue<Result>(_ operation: () -> Result) -> Result {
        if DispatchQueue.getSpecific(key: queueKey) == queueToken {
            return operation()
        }
        return queue.sync(execute: operation)
    }
}
