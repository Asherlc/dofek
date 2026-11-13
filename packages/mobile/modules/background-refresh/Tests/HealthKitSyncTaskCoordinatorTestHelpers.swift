@testable import BackgroundRefreshLib

final class FakeContinuedProcessingScheduler: HealthKitContinuedProcessingScheduling {
    struct Submission: Equatable {
        let identifier: String
        let title: String
        let subtitle: String
        let strategy: HealthKitContinuedProcessingSubmissionStrategy
    }

    var isSupported = true
    var registrationSucceeds = true
    var onRegister: ((String) -> Bool?)?
    var submitError: Error?
    var configureGrant: ((FakeContinuedProcessingGrant) -> Void)?
    private(set) var registrations: [String] = []
    private(set) var submissions: [Submission] = []
    private var launchHandlers: [String: (HealthKitContinuedProcessingGrant) -> Void] = [:]

    func register(
        identifier: String,
        launchHandler: @escaping (HealthKitContinuedProcessingGrant) -> Void
    ) -> Bool {
        registrations.append(identifier)
        let succeeds = onRegister?(identifier) ?? registrationSucceeds
        guard succeeds else { return false }
        launchHandlers[identifier] = launchHandler
        return true
    }

    func submit(
        identifier: String,
        title: String,
        subtitle: String,
        strategy: HealthKitContinuedProcessingSubmissionStrategy
    ) throws {
        if let submitError { throw submitError }
        submissions.append(Submission(
            identifier: identifier,
            title: title,
            subtitle: subtitle,
            strategy: strategy
        ))
    }

    func launch(taskId: String) -> FakeContinuedProcessingGrant? {
        let identifier = HealthKitSyncTaskCoordinator.taskIdentifier(for: taskId)
        guard let launchHandler = launchHandlers[identifier] else { return nil }
        let grant = FakeContinuedProcessingGrant()
        configureGrant?(grant)
        launchHandler(grant)
        return grant
    }
}

final class FakeContinuedProcessingGrant: HealthKitContinuedProcessingGrant {
    var expirationHandler: (() -> Void)?
    var onSetExpirationHandler: ((() -> Void)?) -> Void = { _ in }
    var progressUpdates: [(completed: Int, total: Int, subtitle: String)] = []
    var completions: [Bool] = []

    func setExpirationHandler(_ handler: (() -> Void)?) {
        onSetExpirationHandler(handler)
        expirationHandler = handler
    }

    func report(completed: Int, total: Int, subtitle: String) {
        progressUpdates.append((completed, total, subtitle))
    }

    func complete(success: Bool) {
        completions.append(success)
    }
}
