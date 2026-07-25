import Foundation

final class HealthKitBackgroundDeliveryCoordinator {
    private let lock = NSLock()
    private var completions: [String: () -> Void] = [:]

    var pendingCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return completions.count
    }

    func register(_ completion: @escaping () -> Void) -> String {
        let deliveryId = UUID().uuidString
        lock.lock()
        completions[deliveryId] = completion
        lock.unlock()
        return deliveryId
    }

    @discardableResult
    func complete(_ deliveryId: String) -> Bool {
        lock.lock()
        let completion = completions.removeValue(forKey: deliveryId)
        lock.unlock()

        guard let completion else {
            return false
        }
        completion()
        return true
    }

    func completeAll() {
        lock.lock()
        let pendingCompletions = Array(completions.values)
        completions.removeAll()
        lock.unlock()

        for completion in pendingCompletions {
            completion()
        }
    }
}
