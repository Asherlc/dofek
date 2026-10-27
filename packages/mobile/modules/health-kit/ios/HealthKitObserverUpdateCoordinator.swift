import Foundation

struct HealthKitObserverUpdateExpiration {
    let updateId: String
    let typeIdentifier: String
    let ageMilliseconds: Int
}

final class HealthKitObserverUpdateCoordinator {
    private struct PendingUpdate {
        let completion: () -> Void
        let expiration: DispatchWorkItem
        let registeredAt: TimeInterval
        let typeIdentifier: String
    }

    private let currentUptime: () -> TimeInterval
    private let expirationQueue: DispatchQueue
    private let lock = NSLock()
    private let reportExpiration: (HealthKitObserverUpdateExpiration) -> Void
    private let timeout: TimeInterval
    private var pendingUpdates: [String: PendingUpdate] = [:]

    init(
        timeout: TimeInterval,
        expirationQueue: DispatchQueue = DispatchQueue(
            label: "com.dofek.healthkit-observer-expiration"
        ),
        currentUptime: @escaping () -> TimeInterval = {
            ProcessInfo.processInfo.systemUptime
        },
        reportExpiration: @escaping (HealthKitObserverUpdateExpiration) -> Void = { _ in }
    ) {
        self.timeout = timeout
        self.expirationQueue = expirationQueue
        self.currentUptime = currentUptime
        self.reportExpiration = reportExpiration
    }

    var hasPendingUpdates: Bool {
        lock.withLock {
            !pendingUpdates.isEmpty
        }
    }

    func register(typeIdentifier: String, completion: @escaping () -> Void) -> String {
        let updateId = UUID().uuidString
        let expiration = DispatchWorkItem { [weak self] in
            self?.expire(updateId: updateId)
        }

        lock.withLock {
            pendingUpdates[updateId] = PendingUpdate(
                completion: completion,
                expiration: expiration,
                registeredAt: currentUptime(),
                typeIdentifier: typeIdentifier
            )
        }

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
        let updates = lock.withLock {
            let updates = Array(pendingUpdates.values)
            pendingUpdates.removeAll()
            return updates
        }

        for update in updates {
            update.expiration.cancel()
            update.completion()
        }
        return updates.count
    }

    private func expire(updateId: String) {
        let update = lock.withLock {
            pendingUpdates.removeValue(forKey: updateId)
        }

        guard let update else {
            return
        }
        let ageMilliseconds = Int(
            max(0, currentUptime() - update.registeredAt) * 1_000
        )
        reportExpiration(
            HealthKitObserverUpdateExpiration(
                updateId: updateId,
                typeIdentifier: update.typeIdentifier,
                ageMilliseconds: ageMilliseconds
            )
        )
        update.completion()
    }

    private func take(updateIds: [String]) -> [PendingUpdate] {
        let updates = lock.withLock {
            updateIds.compactMap { pendingUpdates.removeValue(forKey: $0) }
        }

        for update in updates {
            update.expiration.cancel()
        }
        return updates
    }
}
