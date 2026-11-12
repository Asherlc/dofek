import BackgroundTasks
import Foundation
import RNSentry

/// Chosen once per process. Older iOS versions resolve every start as unsupported
/// without touching `BGTaskScheduler`.
enum HealthKitContinuedProcessingSchedulerFactory {
    static func make() -> HealthKitContinuedProcessingScheduling {
        if #available(iOS 26.0, *) {
            return HealthKitContinuedProcessingAdapter()
        }
        return UnsupportedHealthKitContinuedProcessingScheduler()
    }
}

/// Thin iOS 26 adapter over `BGContinuedProcessingTaskRequest` and
/// `BGContinuedProcessingTask`. Continued-processing registrations are exempt from
/// the launch-time registration rule, so each exact request identifier is
/// registered once immediately before its foreground submission.
@available(iOS 26.0, *)
final class HealthKitContinuedProcessingAdapter: HealthKitContinuedProcessingScheduling {
    private let lock = NSLock()
    private var registeredIdentifiers: Set<String> = []

    var isSupported: Bool { true }

    func register(
        identifier: String,
        launchHandler: @escaping (HealthKitContinuedProcessingGrant) -> Void
    ) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        // Registering the same identifier twice kills the app, so reuse the
        // existing handler for retries of the same task ID.
        guard !registeredIdentifiers.contains(identifier) else { return true }
        guard identifier.hasPrefix("\(HealthKitSyncTaskCoordinator.taskIdentifierPrefix).") else {
            HealthKitContinuedProcessingDiagnostics.captureFailure("invalid_task_identifier")
            return false
        }

        let registered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: identifier,
            using: nil
        ) { task in
            guard let continuedTask = task as? BGContinuedProcessingTask else {
                HealthKitContinuedProcessingDiagnostics.captureFailure("unexpected_task_type")
                task.setTaskCompleted(success: false)
                return
            }
            launchHandler(HealthKitContinuedProcessingGrantAdapter(task: continuedTask))
        }
        if registered {
            registeredIdentifiers.insert(identifier)
        } else {
            HealthKitContinuedProcessingDiagnostics.captureFailure("registration_rejected")
        }
        return registered
    }

    func submit(
        identifier: String,
        title: String,
        subtitle: String,
        strategy: HealthKitContinuedProcessingSubmissionStrategy
    ) throws {
        let request = BGContinuedProcessingTaskRequest(
            identifier: identifier,
            title: title,
            subtitle: subtitle
        )
        switch strategy {
        case .fail:
            request.strategy = .fail
        }
        try BGTaskScheduler.shared.submit(request)
    }
}

@available(iOS 26.0, *)
private final class HealthKitContinuedProcessingGrantAdapter: HealthKitContinuedProcessingGrant {
    private let task: BGContinuedProcessingTask
    private let lock = NSLock()
    private var isCompleted = false

    init(task: BGContinuedProcessingTask) {
        self.task = task
    }

    func setExpirationHandler(_ handler: (() -> Void)?) {
        task.expirationHandler = handler
    }

    func report(completed: Int, total: Int, subtitle: String) {
        let totalUnits = Int64(max(total, 1))
        let completedUnits = Int64(min(max(completed, 0), max(total, 1)))
        lock.lock()
        let shouldReport = !isCompleted
        lock.unlock()
        guard shouldReport else { return }
        DispatchQueue.main.async { [task] in
            task.progress.totalUnitCount = totalUnits
            task.progress.completedUnitCount = completedUnits
            if !subtitle.isEmpty {
                task.updateTitle(task.title, subtitle: subtitle)
            }
        }
    }

    func complete(success: Bool) {
        lock.lock()
        guard !isCompleted else {
            lock.unlock()
            return
        }
        isCompleted = true
        lock.unlock()
        task.expirationHandler = nil
        DispatchQueue.main.async { [task] in
            task.setTaskCompleted(success: success)
        }
    }
}

private enum HealthKitContinuedProcessingDiagnostics {
    static func captureFailure(_ reason: String) {
        SentrySDK.capture(error: NSError(
            domain: "DofekHealthKitSync",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: reason]
        )) { scope in
            scope.setTag(value: "health-kit-sync-native", key: "source")
        }
    }
}
