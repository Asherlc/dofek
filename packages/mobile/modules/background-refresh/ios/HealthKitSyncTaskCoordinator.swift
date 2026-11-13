import Foundation

enum HealthKitSyncStartOutcome: Equatable {
    case launched
    case unsupported
}

enum HealthKitSyncStartError: Error, Equatable, LocalizedError {
    case invalidTaskId
    case listenerUnavailable
    case taskIdAlreadyUsed
    case alreadyRunning
    case registrationFailed
    case submissionFailed(String)
    case expiredBeforeLaunch
    case cancelledBeforeTeardown
    case cancelledByOwnerReplacement
    case unsupportedPlatform

    var errorDescription: String? {
        switch self {
        case .invalidTaskId:
            return "The Apple Health sync task ID must be a non-empty identifier-safe string."
        case .listenerUnavailable:
            return "Apple Health sync requires an active expiration listener owned by this app session."
        case .taskIdAlreadyUsed:
            return "The Apple Health sync task ID was already submitted. Use a fresh task ID for each attempt."
        case .alreadyRunning:
            return "An Apple Health sync background task is already pending or running."
        case .registrationFailed:
            return "The Apple Health sync background task could not be registered. Check BGTaskSchedulerPermittedIdentifiers."
        case .submissionFailed(let description):
            return "The Apple Health sync background task could not be submitted: \(description)"
        case .expiredBeforeLaunch:
            return "The Apple Health sync background task expired before it started."
        case .cancelledBeforeTeardown:
            return "The Apple Health sync background task was cancelled because its listener was removed."
        case .cancelledByOwnerReplacement:
            return "The Apple Health sync background task was cancelled because a new listener took ownership."
        case .unsupportedPlatform:
            return "Continued processing requires iOS 26 or later."
        }
    }
}

/// Submission strategies exposed by the coordinator. Only `.fail` is used so a
/// second job never queues behind work JavaScript already started.
enum HealthKitContinuedProcessingSubmissionStrategy: Equatable {
    case fail
}

/// Foundation-testable state machine for one user-started Apple Health sync.
///
/// Apple only accepts continued-processing submissions from the foreground and
/// requires each exact request identifier to be registered once. The coordinator
/// therefore registers the exact `com.dofek.app.healthkit-sync.<taskId>` identifier
/// immediately before submitting, and never re-registers a task ID in this process.
/// Callers must use a fresh task ID for every submitted attempt.
///
/// A live expiration listener is the owner of a request. Queued starts carry the
/// listener owner that scheduled them, so retiring that listener (or destroying its
/// module) rejects queued work even when a replacement listener appears. Grant
/// installation and start settlement are checked against the same owner state, so a
/// teardown or expiration that wins during launch setup cannot report success.
final class HealthKitSyncTaskCoordinator: @unchecked Sendable {
    static let taskIdentifierPrefix = "com.dofek.app.healthkit-sync"
    static let taskTitle = "Apple Health sync"
    static let startingSubtitle = "Starting…"

    static func taskIdentifier(for taskId: String) -> String {
        "\(taskIdentifierPrefix).\(taskId)"
    }

    private struct PendingStart {
        let taskId: String
        let ownerId: UUID
        let token: UUID
        let completion: (Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>) -> Void
    }

    private struct ActiveTask {
        let taskId: String
        let ownerId: UUID
        let token: UUID
        let grant: HealthKitContinuedProcessingGrant
        var completion: ((Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>) -> Void)?
        var settled: Bool
    }

    private let scheduler: HealthKitContinuedProcessingScheduling
    private let lock = NSLock()
    private var pendingStart: PendingStart?
    private var activeTask: ActiveTask?
    private var registeredTaskIds: Set<String> = []
    private var submittedTaskIds: Set<String> = []
    private var listenerOwnerId: UUID?
    private var expirationCallback: ((String) -> Void)?

    init(scheduler: HealthKitContinuedProcessingScheduling) {
        self.scheduler = scheduler
    }

    /// Marks one module/bridge instance as the live expiration listener. Work queued
    /// by a different owner is retired: that bridge can no longer receive expiration.
    func activateOwner(ownerId: UUID, onExpiration: @escaping (String) -> Void) {
        lock.lock()
        if listenerOwnerId == ownerId {
            expirationCallback = onExpiration
            lock.unlock()
            return
        }
        let retiredPending = pendingStart.flatMap { $0.ownerId == ownerId ? nil : $0 }
        let retiredActive = activeTask.flatMap { $0.ownerId == ownerId ? nil : $0 }
        if retiredPending != nil { pendingStart = nil }
        if retiredActive != nil { activeTask = nil }
        listenerOwnerId = ownerId
        expirationCallback = onExpiration
        lock.unlock()

        retire(
            pending: retiredPending,
            active: retiredActive,
            reason: .cancelledByOwnerReplacement
        )
    }

    /// Retires one owner's listener and its pending/active request. Cleanup from an
    /// old module never affects a request owned by a replacement listener.
    func deactivateOwner(ownerId: UUID) {
        retireOwner(ownerId: ownerId, reason: .cancelledBeforeTeardown)
    }

    /// Module destruction uses the same owner-correlated cleanup as listener removal.
    func destroyOwner(ownerId: UUID) {
        retireOwner(ownerId: ownerId, reason: .cancelledBeforeTeardown)
    }

    /// Registers the exact request identifier once and submits a `.fail` request.
    /// The completion resolves with `.launched` only when the native launch handler
    /// grants the task and the owning listener is still live. Older iOS versions
    /// resolve `.unsupported` without registering or submitting.
    func start(
        taskId: String,
        ownerId: UUID,
        completion: @escaping (Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>) -> Void
    ) {
        guard Self.isValidTaskId(taskId) else {
            completion(.failure(.invalidTaskId))
            return
        }

        lock.lock()
        guard scheduler.isSupported else {
            lock.unlock()
            completion(.success(.unsupported))
            return
        }
        guard listenerOwnerId == ownerId else {
            lock.unlock()
            completion(.failure(.listenerUnavailable))
            return
        }
        guard !submittedTaskIds.contains(taskId) else {
            lock.unlock()
            completion(.failure(.taskIdAlreadyUsed))
            return
        }
        guard pendingStart == nil, activeTask == nil else {
            lock.unlock()
            completion(.failure(.alreadyRunning))
            return
        }
        let needsRegistration = !registeredTaskIds.contains(taskId)
        let token = UUID()
        pendingStart = PendingStart(
            taskId: taskId,
            ownerId: ownerId,
            token: token,
            completion: completion
        )
        lock.unlock()

        registerAndSubmitStart(taskId: taskId, token: token, needsRegistration: needsRegistration)
    }

    /// Scheduler calls stay outside the lock; lock sections only verify or commit
    /// this token's pending request so retired generations cannot settle a replacement.
    private func registerAndSubmitStart(taskId: String, token: UUID, needsRegistration: Bool) {
        if needsRegistration {
            let identifier = Self.taskIdentifier(for: taskId)
            let registered = scheduler.register(identifier: identifier) { [weak self] grant in
                self?.handleLaunch(taskId: taskId, grant: grant)
            }
            guard registered else {
                rejectPendingStart(token: token, error: .registrationFailed)
                return
            }
            lock.lock()
            registeredTaskIds.insert(taskId)
            lock.unlock()
        }

        lock.lock()
        let stillPending = pendingStart?.token == token
        lock.unlock()
        guard stillPending else { return }

        do {
            try scheduler.submit(
                identifier: Self.taskIdentifier(for: taskId),
                title: Self.taskTitle,
                subtitle: Self.startingSubtitle,
                strategy: .fail
            )
            lock.lock()
            submittedTaskIds.insert(taskId)
            lock.unlock()
        } catch {
            rejectPendingStart(token: token, error: .submissionFailed(error.localizedDescription))
        }
    }

    /// Reports completed semantic stages; stale, mismatched, or foreign-owner
    /// updates are ignored.
    func updateProgress(
        taskId: String,
        ownerId: UUID,
        completed: Int,
        total: Int,
        message: String
    ) {
        lock.lock()
        guard let active = activeTask, active.taskId == taskId, active.ownerId == ownerId else {
            lock.unlock()
            return
        }
        lock.unlock()

        let normalizedTotal = max(total, 1)
        let normalizedCompleted = min(max(completed, 0), normalizedTotal)
        active.grant.report(
            completed: normalizedCompleted,
            total: normalizedTotal,
            subtitle: message
        )
    }

    /// Completes the native task at most once. Duplicate, late, or foreign-owner
    /// calls are ignored.
    func complete(taskId: String, ownerId: UUID, success: Bool) {
        lock.lock()
        guard let active = activeTask, active.taskId == taskId, active.ownerId == ownerId else {
            lock.unlock()
            return
        }
        activeTask = nil
        lock.unlock()

        active.grant.setExpirationHandler(nil)
        active.grant.complete(success: success)
    }

    private func handleLaunch(taskId: String, grant: HealthKitContinuedProcessingGrant) {
        lock.lock()
        guard let pending = pendingStart,
              pending.taskId == taskId,
              listenerOwnerId == pending.ownerId
        else {
            lock.unlock()
            grant.setExpirationHandler(nil)
            grant.complete(success: false)
            return
        }
        pendingStart = nil
        let token = pending.token
        activeTask = ActiveTask(
            taskId: taskId,
            ownerId: pending.ownerId,
            token: token,
            grant: grant,
            completion: pending.completion,
            settled: false
        )
        lock.unlock()

        grant.setExpirationHandler { [weak self] in
            self?.expire(taskId: taskId, token: token)
        }

        // Retirement may have won while the expiration handler was being installed.
        // Re-check before settling; never leave a handler on a retired grant.
        lock.lock()
        if var active = activeTask, active.token == token, !active.settled {
            active.settled = true
            let completion = active.completion
            active.completion = nil
            activeTask = active
            lock.unlock()
            completion?(.success(.launched))
        } else {
            let isCurrent = activeTask?.token == token
            lock.unlock()
            grant.setExpirationHandler(nil)
            if isCurrent {
                retireActive(token: token, reason: .cancelledBeforeTeardown)
            }
        }
    }

    private func expire(taskId: String, token: UUID) {
        lock.lock()
        guard let active = activeTask, active.token == token else {
            lock.unlock()
            return
        }
        activeTask = nil
        let completion = active.completion
        let callback = active.settled && listenerOwnerId == active.ownerId
            ? expirationCallback
            : nil
        lock.unlock()

        active.grant.setExpirationHandler(nil)
        active.grant.complete(success: false)
        completion?(.failure(.expiredBeforeLaunch))
        callback?(taskId)
    }

    private func retireActive(token: UUID, reason: HealthKitSyncStartError) {
        lock.lock()
        guard let active = activeTask, active.token == token else {
            lock.unlock()
            return
        }
        activeTask = nil
        lock.unlock()

        active.grant.setExpirationHandler(nil)
        active.grant.complete(success: false)
        active.completion?(.failure(reason))
    }

    private func retireOwner(ownerId: UUID, reason: HealthKitSyncStartError) {
        lock.lock()
        if listenerOwnerId == ownerId {
            listenerOwnerId = nil
            expirationCallback = nil
        }
        let pending = pendingStart.flatMap { $0.ownerId == ownerId ? $0 : nil }
        let active = activeTask.flatMap { $0.ownerId == ownerId ? $0 : nil }
        if pending != nil { pendingStart = nil }
        if active != nil { activeTask = nil }
        lock.unlock()

        retire(pending: pending, active: active, reason: reason)
    }

    private func retire(
        pending: PendingStart?,
        active: ActiveTask?,
        reason: HealthKitSyncStartError
    ) {
        if let active {
            active.grant.setExpirationHandler(nil)
            active.grant.complete(success: false)
            active.completion?(.failure(reason))
        }
        pending?.completion(.failure(reason))
    }

    private func rejectPendingStart(token: UUID, error: HealthKitSyncStartError) {
        lock.lock()
        guard let pending = pendingStart, pending.token == token else {
            lock.unlock()
            return
        }
        pendingStart = nil
        lock.unlock()
        pending.completion(.failure(error))
    }

    private static func isValidTaskId(_ taskId: String) -> Bool {
        guard !taskId.isEmpty, taskId.count <= 128 else { return false }
        let allowed = CharacterSet(
            charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
        )
        return taskId.unicodeScalars.allSatisfy { allowed.contains($0) }
    }
}

/// The system-granted task. Tests provide a fake; the iOS 26 adapter wraps
/// `BGContinuedProcessingTask`.
protocol HealthKitContinuedProcessingGrant: AnyObject {
    func setExpirationHandler(_ handler: (() -> Void)?)
    func report(completed: Int, total: Int, subtitle: String)
    func complete(success: Bool)
}

/// The scheduling boundary. Tests provide a fake; the iOS 26 adapter talks to
/// `BGTaskScheduler`.
protocol HealthKitContinuedProcessingScheduling: AnyObject {
    var isSupported: Bool { get }
    func register(
        identifier: String,
        launchHandler: @escaping (HealthKitContinuedProcessingGrant) -> Void
    ) -> Bool
    func submit(
        identifier: String,
        title: String,
        subtitle: String,
        strategy: HealthKitContinuedProcessingSubmissionStrategy
    ) throws
}

/// Used below iOS 26 and as the explicit unsupported path; it never registers or
/// submits a request.
final class UnsupportedHealthKitContinuedProcessingScheduler: HealthKitContinuedProcessingScheduling {
    var isSupported: Bool { false }

    func register(
        identifier: String,
        launchHandler: @escaping (HealthKitContinuedProcessingGrant) -> Void
    ) -> Bool {
        false
    }

    func submit(
        identifier: String,
        title: String,
        subtitle: String,
        strategy: HealthKitContinuedProcessingSubmissionStrategy
    ) throws {
        throw HealthKitSyncStartError.unsupportedPlatform
    }
}
