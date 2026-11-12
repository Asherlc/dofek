import XCTest
@testable import BackgroundRefreshLib

final class HealthKitSyncTaskCoordinatorTests: XCTestCase {
    func testStartRegistersTheExactRequestIdentifierThenResolvesOnNativeLaunch() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        coordinator.start(taskId: "sync-1") { outcomes.append($0) }

        XCTAssertEqual(scheduler.registrations, ["com.dofek.app.healthkit-sync.sync-1"])
        XCTAssertEqual(scheduler.submissions.count, 1)
        XCTAssertEqual(scheduler.submissions.first?.identifier, "com.dofek.app.healthkit-sync.sync-1")
        XCTAssertEqual(scheduler.submissions.first?.strategy, .fail)
        XCTAssertTrue(outcomes.isEmpty)

        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))

        XCTAssertEqual(outcomes, [.success(.launched)])
        XCTAssertNotNil(grant.expirationHandler)
    }

    func testUnsupportedPlatformResolvesWithoutRegisteringOrSubmitting() {
        let scheduler = FakeContinuedProcessingScheduler()
        scheduler.isSupported = false
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        coordinator.start(taskId: "sync-1") { outcomes.append($0) }

        XCTAssertEqual(outcomes, [.success(.unsupported)])
        XCTAssertTrue(scheduler.registrations.isEmpty)
        XCTAssertTrue(scheduler.submissions.isEmpty)
    }

    func testRejectsInvalidTaskIdentifiersBeforeRegistration() {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        coordinator.start(taskId: "") { outcomes.append($0) }
        coordinator.start(taskId: "bad id/with spaces") { outcomes.append($0) }

        XCTAssertEqual(outcomes, [.failure(.invalidTaskId), .failure(.invalidTaskId)])
        XCTAssertTrue(scheduler.registrations.isEmpty)
        XCTAssertTrue(scheduler.submissions.isEmpty)
    }

    func testRegistrationFailureRejectsTheStartWithoutSubmitting() {
        let scheduler = FakeContinuedProcessingScheduler()
        scheduler.registrationSucceeds = false
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        coordinator.start(taskId: "sync-1") { outcomes.append($0) }

        XCTAssertEqual(outcomes, [.failure(.registrationFailed)])
        XCTAssertTrue(scheduler.submissions.isEmpty)
    }

    func testRejectsAStartWhileAnotherRequestIsPendingOrRunning() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        coordinator.start(taskId: "sync-1") { outcomes.append($0) }
        coordinator.start(taskId: "sync-2") { outcomes.append($0) }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))
        coordinator.start(taskId: "sync-3") { outcomes.append($0) }

        XCTAssertEqual(outcomes, [
            .failure(.alreadyRunning),
            .success(.launched),
            .failure(.alreadyRunning),
        ])
        XCTAssertEqual(scheduler.registrations, ["com.dofek.app.healthkit-sync.sync-1"])
        XCTAssertEqual(scheduler.submissions.count, 1)
        XCTAssertEqual(grant.completions, [])
    }

    func testSubmissionFailureRejectsTheStartAndAllowsRetryWithoutReRegistering() {
        let scheduler = FakeContinuedProcessingScheduler()
        scheduler.submitError = NSError(
            domain: "BGTaskSchedulerErrorDomain",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "The operation could not be completed."]
        )
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        coordinator.start(taskId: "sync-1") { outcomes.append($0) }

        guard case .failure(.submissionFailed(let description)) = outcomes.first else {
            return XCTFail("Expected a specific submission failure, got \(outcomes)")
        }
        XCTAssertTrue(description.contains("The operation could not be completed."))

        scheduler.submitError = nil
        coordinator.start(taskId: "sync-1") { outcomes.append($0) }
        _ = scheduler.launch(taskId: "sync-1")
        XCTAssertEqual(scheduler.registrations, ["com.dofek.app.healthkit-sync.sync-1"])
        XCTAssertEqual(scheduler.submissions.count, 1)
        XCTAssertEqual(outcomes.count, 2)
        XCTAssertEqual(outcomes.last, .success(.launched))
    }

    func testExpirationBeforeLaunchRejectsThePendingStartAndLateLaunchCannotRun() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []
        var expiredTaskIds: [String] = []
        coordinator.setExpirationCallback { expiredTaskIds.append($0) }

        coordinator.start(taskId: "sync-1") { outcomes.append($0) }
        coordinator.expire(taskId: "sync-1")

        XCTAssertEqual(outcomes, [.failure(.expiredBeforeLaunch)])
        XCTAssertEqual(expiredTaskIds, [])

        let lateGrant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))

        XCTAssertEqual(lateGrant.completions, [false])
        XCTAssertNil(lateGrant.expirationHandler)
        XCTAssertEqual(outcomes, [.failure(.expiredBeforeLaunch)])
    }

    func testExpirationCompletesTheActiveTaskExactlyOnceAndNotifiesWithTheTaskId() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var expiredTaskIds: [String] = []
        coordinator.setExpirationCallback { expiredTaskIds.append($0) }
        coordinator.start(taskId: "sync-1") { _ in }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))

        grant.expirationHandler?()
        coordinator.expire(taskId: "sync-1")
        coordinator.complete(taskId: "sync-1", success: true)

        XCTAssertEqual(grant.completions, [false])
        XCTAssertEqual(expiredTaskIds, ["sync-1"])
        XCTAssertNil(grant.expirationHandler)
    }

    func testCompletionRunsOnceAndLateExpirationOrCompletionIsIgnored() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var expiredTaskIds: [String] = []
        coordinator.setExpirationCallback { expiredTaskIds.append($0) }
        coordinator.start(taskId: "sync-1") { _ in }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))

        coordinator.complete(taskId: "sync-1", success: true)
        coordinator.complete(taskId: "sync-1", success: false)
        grant.expirationHandler?()

        XCTAssertEqual(grant.completions, [true])
        XCTAssertEqual(expiredTaskIds, [])
        XCTAssertNil(grant.expirationHandler)
    }

    func testLateLaunchFromAnAbandonedRequestCannotStartOrCompleteANewerTask() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var expiredTaskIds: [String] = []
        coordinator.setExpirationCallback { expiredTaskIds.append($0) }
        coordinator.start(taskId: "sync-1") { _ in }
        let firstGrant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))
        coordinator.complete(taskId: "sync-1", success: true)

        coordinator.start(taskId: "sync-2") { _ in }
        let secondGrant = try XCTUnwrap(scheduler.launch(taskId: "sync-2"))
        firstGrant.expirationHandler?()
        _ = scheduler.launch(taskId: "sync-1")

        XCTAssertEqual(firstGrant.completions, [true])
        XCTAssertEqual(secondGrant.completions, [])
        XCTAssertEqual(expiredTaskIds, [])
    }

    func testProgressOnlyAppliesToTheMatchingActiveTaskAndReflectsCompletedWork() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)

        coordinator.updateProgress(taskId: "sync-1", completed: 1, total: 4, message: "Before launch")

        coordinator.start(taskId: "sync-1") { _ in }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))

        coordinator.updateProgress(taskId: "sync-2", completed: 3, total: 4, message: "Other task")
        coordinator.updateProgress(taskId: "sync-1", completed: 2, total: 4, message: "Uploading workouts")

        XCTAssertEqual(grant.progressUpdates.count, 1)
        XCTAssertEqual(grant.progressUpdates.first?.completed, 2)
        XCTAssertEqual(grant.progressUpdates.first?.total, 4)
        XCTAssertEqual(grant.progressUpdates.first?.subtitle, "Uploading workouts")
    }

    func testProgressClampsInvalidValuesBeforeReportingToTheSystem() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        coordinator.start(taskId: "sync-1") { _ in }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))

        coordinator.updateProgress(taskId: "sync-1", completed: 9, total: 0, message: "")

        XCTAssertEqual(grant.progressUpdates.first?.completed, 1)
        XCTAssertEqual(grant.progressUpdates.first?.total, 1)
        XCTAssertEqual(grant.progressUpdates.first?.subtitle, "")
    }

    func testTeardownRejectsAPendingStartAndCompletesAnActiveTaskOnce() throws {
        let rejectedScheduler = FakeContinuedProcessingScheduler()
        let rejectingCoordinator = HealthKitSyncTaskCoordinator(scheduler: rejectedScheduler)
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []
        rejectingCoordinator.start(taskId: "pending") { outcomes.append($0) }

        rejectingCoordinator.teardown()

        XCTAssertEqual(outcomes, [.failure(.cancelledBeforeTeardown)])
        let lateGrant = try XCTUnwrap(rejectedScheduler.launch(taskId: "pending"))
        XCTAssertEqual(lateGrant.completions, [false])

        let activeScheduler = FakeContinuedProcessingScheduler()
        let activeCoordinator = HealthKitSyncTaskCoordinator(scheduler: activeScheduler)
        activeCoordinator.start(taskId: "active") { _ in }
        let activeGrant = try XCTUnwrap(activeScheduler.launch(taskId: "active"))

        activeCoordinator.teardown()
        activeCoordinator.teardown()
        activeCoordinator.complete(taskId: "active", success: true)

        XCTAssertEqual(activeGrant.completions, [false])
        XCTAssertNil(activeGrant.expirationHandler)
    }

    func testClearingTheExpirationCallbackKeepsNativeCompletionButStopsNotifications() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var expiredTaskIds: [String] = []
        coordinator.setExpirationCallback { expiredTaskIds.append($0) }
        coordinator.start(taskId: "sync-1") { _ in }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))

        coordinator.setExpirationCallback(nil)
        grant.expirationHandler?()

        XCTAssertEqual(grant.completions, [false])
        XCTAssertEqual(expiredTaskIds, [])
    }
}

private final class FakeContinuedProcessingScheduler: HealthKitContinuedProcessingScheduling {
    struct Submission: Equatable {
        let identifier: String
        let title: String
        let subtitle: String
        let strategy: HealthKitContinuedProcessingSubmissionStrategy
    }

    var isSupported = true
    var registrationSucceeds = true
    var submitError: Error?
    private(set) var registrations: [String] = []
    private(set) var submissions: [Submission] = []
    private var launchHandlers: [String: (HealthKitContinuedProcessingGrant) -> Void] = [:]

    func register(
        identifier: String,
        launchHandler: @escaping (HealthKitContinuedProcessingGrant) -> Void
    ) -> Bool {
        registrations.append(identifier)
        guard registrationSucceeds else { return false }
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
        launchHandler(grant)
        return grant
    }
}

private final class FakeContinuedProcessingGrant: HealthKitContinuedProcessingGrant {
    var expirationHandler: (() -> Void)?
    var progressUpdates: [(completed: Int, total: Int, subtitle: String)] = []
    var completions: [Bool] = []

    func setExpirationHandler(_ handler: (() -> Void)?) {
        expirationHandler = handler
    }

    func report(completed: Int, total: Int, subtitle: String) {
        progressUpdates.append((completed, total, subtitle))
    }

    func complete(success: Bool) {
        completions.append(success)
    }
}
