import Foundation

/// Owns native background-task completion until JavaScript reports its result.
///
/// All state transitions are lock-protected so expiration, listener teardown,
/// and JavaScript completion can race without completing a task more than once.
final class BackgroundRefreshTaskCoordinator: @unchecked Sendable {
    private let idGenerator: () -> String
    private let lock = NSLock()
    private var handlerAvailable = false
    private var pendingCompletions: [String: (Bool) -> Void] = [:]

    init(idGenerator: @escaping () -> String = { UUID().uuidString }) {
        self.idGenerator = idGenerator
    }

    func setHandlerAvailable(_ available: Bool) {
        lock.lock()
        handlerAvailable = available
        let abandonedCompletions = available ? [] : Array(pendingCompletions.values)
        if !available {
            pendingCompletions.removeAll()
        }
        lock.unlock()

        for completion in abandonedCompletions {
            completion(false)
        }
    }

    /// Starts a task only when JavaScript has an active event listener.
    ///
    /// Returns the task identifier included in the event payload, or `nil`
    /// after immediately reporting failure when no handler is available.
    func beginTask(completion: @escaping (Bool) -> Void) -> String? {
        lock.lock()
        guard handlerAvailable else {
            lock.unlock()
            completion(false)
            return nil
        }
        let taskId = idGenerator()
        pendingCompletions[taskId] = completion
        lock.unlock()
        return taskId
    }

    func completeTask(id: String, success: Bool) {
        lock.lock()
        let completion = pendingCompletions.removeValue(forKey: id)
        lock.unlock()
        completion?(success)
    }

    func expireTask(id: String) {
        completeTask(id: id, success: false)
    }
}
