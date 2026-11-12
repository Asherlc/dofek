import Foundation

/// Foundation-testable state machine for one user-started Apple Health sync.
///
/// Apple only accepts continued-processing submissions from the foreground and
/// requires each exact request identifier to be registered once. The coordinator
/// therefore registers the exact `com.dofek.app.healthkit-sync.<taskId>` identifier
/// immediately before submitting, and never re-registers a task ID in this process.
/// See Apple's `BGContinuedProcessingTaskRequest` guidance on wildcard identifiers
/// and the `BGTaskScheduler` registration exception for continued processing.
enum HealthKitSyncStartOutcome: Equatable {
    case launched
    case unsupported
}

enum HealthKitSyncStartError: Error, Equatable, LocalizedError {
    case invalidTaskId
    case alreadyRunning
    case registrationFailed
    case submissionFailed(String)
    case expiredBeforeLaunch
    case cancelledBeforeTeardown
    case unsupportedPlatform

    var errorDescription: String? {
        switch self {
        case .invalidTaskId:
            return "The Apple Health sync task ID must be a non-empty identifier-safe string."
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

/// Owns at most one pending start and one active native grant. Completion and
/// expiration consume the stored state under a lock, so every native task is
/// completed at most once. Callbacks and grant operations run outside the lock.
final class HealthKitSyncTaskCoordinator: @unchecked Sendable {
    static let taskIdentifierPrefix = "com.dofek.app.healthkit-sync"
    static let taskTitle = "Apple Health sync"
    static let startingSubtitle = "Starting…"

    static func taskIdentifier(for taskId: String) -> String {
        "\(taskIdentifierPrefix).\(taskId)"
    }

    private struct PendingStart {
        let taskId: String
        let completion: (Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>) -> Void
    }

    private struct ActiveTask {
        let taskId: String
        let grant: HealthKitContinuedProcessingGrant
    }

    private let scheduler: HealthKitContinuedProcessingScheduling
    private let lock = NSLock()
    private var pendingStart: PendingStart?
    private var activeTask: ActiveTask?
    private var registeredTaskIds: Set<String> = []
    private var expirationCallback: ((String) -> Void)?

    init(scheduler: HealthKitContinuedProcessingScheduling) {
        self.scheduler = scheduler
    }

    func setExpirationCallback(_ callback: ((String) -> Void)?) {
        lock.lock()
        expirationCallback = callback
        lock.unlock()
    }

    /// Registers the exact request identifier once and submits a `.fail` request.
    /// The completion resolves with `.launched` only when the native launch handler
    /// grants the task, or with `.unsupported` on older iOS versions.
    func start(
        taskId: String,
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
        guard pendingStart == nil, activeTask == nil else {
            lock.unlock()
            completion(.failure(.alreadyRunning))
            return
        }
        let needsRegistration = !registeredTaskIds.contains(taskId)
        pendingStart = PendingStart(taskId: taskId, completion: completion)
        lock.unlock()

        if needsRegistration {
            let identifier = Self.taskIdentifier(for: taskId)
            let registered = scheduler.register(identifier: identifier) { [weak self] grant in
                self?.handleLaunch(taskId: taskId, grant: grant)
            }
            guard registered else {
                rejectPendingStart(taskId: taskId, error: .registrationFailed)
                return
            }
            lock.lock()
            registeredTaskIds.insert(taskId)
            lock.unlock()
        }

        lock.lock()
        let stillPending = pendingStart?.taskId == taskId
        lock.unlock()
        guard stillPending else { return }

        do {
            try scheduler.submit(
                identifier: Self.taskIdentifier(for: taskId),
                title: Self.taskTitle,
                subtitle: Self.startingSubtitle,
                strategy: .fail
            )
        } catch {
            rejectPendingStart(taskId: taskId, error: .submissionFailed(error.localizedDescription))
        }
    }

    /// Reports completed semantic stages; stale or mismatched task IDs are ignored.
    func updateProgress(taskId: String, completed: Int, total: Int, message: String) {
        lock.lock()
        guard let active = activeTask, active.taskId == taskId else {
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

    /// Completes the native task at most once. Duplicate or late calls are ignored.
    func complete(taskId: String, success: Bool) {
        lock.lock()
        guard let active = activeTask, active.taskId == taskId else {
            lock.unlock()
            return
        }
        activeTask = nil
        lock.unlock()

        active.grant.setExpirationHandler(nil)
        active.grant.complete(success: success)
    }

    /// Called by the native expiration handler, which also covers a person's
    /// cancellation in the system UI. Expiration removes the task so automatic
    /// continuation cannot override it; JavaScript must decide on a Resume tap.
    func expire(taskId: String) {
        lock.lock()
        if let active = activeTask, active.taskId == taskId {
            activeTask = nil
            let callback = expirationCallback
            lock.unlock()
            active.grant.setExpirationHandler(nil)
            active.grant.complete(success: false)
            callback?(taskId)
            return
        }
        if let pending = pendingStart, pending.taskId == taskId {
            pendingStart = nil
            lock.unlock()
            pending.completion(.failure(.expiredBeforeLaunch))
            return
        }
        lock.unlock()
    }

    /// Bridge teardown fails any pending start and completes an active task once.
    /// A later native launch for the same request is rejected by `handleLaunch`.
    func teardown() {
        lock.lock()
        let pending = pendingStart
        let active = activeTask
        pendingStart = nil
        activeTask = nil
        lock.unlock()

        active?.grant.setExpirationHandler(nil)
        active?.grant.complete(success: false)
        pending?.completion(.failure(.cancelledBeforeTeardown))
    }

    private func handleLaunch(taskId: String, grant: HealthKitContinuedProcessingGrant) {
        lock.lock()
        guard let pending = pendingStart, pending.taskId == taskId else {
            lock.unlock()
            grant.setExpirationHandler(nil)
            grant.complete(success: false)
            return
        }
        pendingStart = nil
        activeTask = ActiveTask(taskId: taskId, grant: grant)
        lock.unlock()

        grant.setExpirationHandler { [weak self] in
            self?.expire(taskId: taskId)
        }
        pending.completion(.success(.launched))
    }

    private func rejectPendingStart(taskId: String, error: HealthKitSyncStartError) {
        lock.lock()
        guard let pending = pendingStart, pending.taskId == taskId else {
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
