import Foundation

/// Owns native background-task completion until JavaScript reports its result.
/// State transitions are locked; diagnostics and completion callbacks run outside the lock.
final class BackgroundRefreshTaskCoordinator: @unchecked Sendable {
    private let idGenerator: () -> String
    private let diagnostics: BackgroundRefreshDiagnostics
    private let lock = NSLock()
    private var handlerAvailable = false
    private var pendingCompletions: [String: (Bool) -> Void] = [:]

    init(
        idGenerator: @escaping () -> String = { UUID().uuidString },
        diagnostics: BackgroundRefreshDiagnostics = .shared
    ) {
        self.idGenerator = idGenerator
        self.diagnostics = diagnostics
    }

    func setHandlerAvailable(_ available: Bool) {
        lock.lock()
        handlerAvailable = available
        let abandonedCompletions = available ? [:] : pendingCompletions
        if !available { pendingCompletions.removeAll() }
        lock.unlock()

        diagnostics.record("listener_changed", fields: .init(reason: available ? "available" : "unavailable"))
        for (taskId, completion) in abandonedCompletions {
            diagnostics.record("task_completed", fields: .init(taskId: taskId, success: false, reason: "listener_removed"))
            completion(false)
        }
    }

    /// Returns an ID, or immediately fails when no JavaScript listener is available.
    func beginTask(completion: @escaping (Bool) -> Void) -> String? {
        let taskId = idGenerator()
        lock.lock()
        let available = handlerAvailable
        if available { pendingCompletions[taskId] = completion }
        lock.unlock()

        diagnostics.record("task_launched", fields: .init(taskId: taskId))
        guard available else {
            diagnostics.record("task_completed", fields: .init(taskId: taskId, success: false, reason: "missing_listener"))
            completion(false)
            return nil
        }
        return taskId
    }

    func completeTask(id: String, success: Bool) {
        let completion = takeCompletion(id: id)
        diagnostics.record("completion_requested", fields: .init(
            taskId: id, success: success, reason: completion == nil ? "no_pending_task" : "javascript"
        ))
        guard let completion else { return }
        diagnostics.record("task_completed", fields: .init(
            taskId: id, success: success, reason: success ? "javascript_success" : "javascript_failure"
        ))
        completion(success)
    }

    func expireTask(id: String) {
        let completion = takeCompletion(id: id)
        diagnostics.record("task_expired", fields: .init(taskId: id, reason: completion == nil ? "no_pending_task" : "expired"))
        guard let completion else { return }
        diagnostics.record("task_completed", fields: .init(taskId: id, success: false, reason: "expired"))
        completion(false)
    }

    private func takeCompletion(id: String) -> ((Bool) -> Void)? {
        lock.lock()
        defer { lock.unlock() }
        return pendingCompletions.removeValue(forKey: id)
    }
}
