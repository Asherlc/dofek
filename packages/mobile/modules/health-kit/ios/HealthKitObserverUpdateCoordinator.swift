import Foundation

final class HealthKitObserverUpdateCoordinator {
    private struct PendingUpdate {
        let completion: () -> Void
        let expiration: DispatchWorkItem
    }

    private let expirationQueue: DispatchQueue
    private let lock = NSLock()
    private let reportExpiration: (String) -> Void
    private let timeout: TimeInterval
    private var pendingUpdates: [String: PendingUpdate] = [:]

    init(
        timeout: TimeInterval,
        expirationQueue: DispatchQueue = DispatchQueue(
            label: "com.dofek.healthkit-observer-expiration"
        ),
        reportExpiration: @escaping (String) -> Void = { _ in }
    ) {
        self.timeout = timeout
        self.expirationQueue = expirationQueue
        self.reportExpiration = reportExpiration
    }

    func register(completion: @escaping () -> Void) -> String {
        let updateId = UUID().uuidString
        let expiration = DispatchWorkItem { [weak self] in
            self?.expire(updateId: updateId)
        }

        lock.lock()
        pendingUpdates[updateId] = PendingUpdate(
            completion: completion,
            expiration: expiration
        )
        lock.unlock()

        expirationQueue.asyncAfter(deadline: .now() + timeout, execute: expiration)
        return updateId
    }

    @discardableResult
    func complete(updateIds: [String]) -> Int {
        let updates = take(updateIds: updateIds)
        for update in updates {
            update.completion()
        }
        return updates.count
    }

    @discardableResult
    func completeAll() -> Int {
        lock.lock()
        let updates = Array(pendingUpdates.values)
        pendingUpdates.removeAll()
        lock.unlock()

        for update in updates {
            update.expiration.cancel()
            update.completion()
        }
        return updates.count
    }

    private func expire(updateId: String) {
        lock.lock()
        let update = pendingUpdates.removeValue(forKey: updateId)
        lock.unlock()

        guard let update else {
            return
        }
        reportExpiration(updateId)
        update.completion()
    }

    private func take(updateIds: [String]) -> [PendingUpdate] {
        lock.lock()
        let updates = updateIds.compactMap { pendingUpdates.removeValue(forKey: $0) }
        lock.unlock()

        for update in updates {
            update.expiration.cancel()
        }
        return updates
    }
}
