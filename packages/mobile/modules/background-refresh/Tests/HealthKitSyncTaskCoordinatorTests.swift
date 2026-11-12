import XCTest
@testable import BackgroundRefreshLib

final class HealthKitSyncTaskCoordinatorTests: XCTestCase {
    private let ownerA = UUID()
    private let ownerB = UUID()

    func testStartRegistersTheExactRequestIdentifierThenResolvesOnNativeLaunch() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { _ in })
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        coordinator.start(taskId: "sync-1", ownerId: ownerA) { outcomes.append($0) }

        XCTAssertEqual(scheduler.registrations, ["com.dofek.app.healthkit-sync.sync-1"])
        XCTAssertEqual(scheduler.submissions.count, 1)
        XCTAssertEqual(scheduler.submissions.first?.identifier, "com.dofek.app.healthkit-sync.sync-1")
        XCTAssertEqual(scheduler.submissions.first?.strategy, .fail)
        XCTAssertTrue(outcomes.isEmpty)

        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))

        XCTAssertEqual(outcomes, [.success(.launched)])
        XCTAssertNotNil(grant.expirationHandler)
    }

    func testUnsupportedPlatformResolvesWithoutARegisteredListenerOrSubmission() {
        let scheduler = FakeContinuedProcessingScheduler()
        scheduler.isSupported = false
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        coordinator.start(taskId: "sync-1", ownerId: ownerA) { outcomes.append($0) }

        XCTAssertEqual(outcomes, [.success(.unsupported)])
        XCTAssertTrue(scheduler.registrations.isEmpty)
        XCTAssertTrue(scheduler.submissions.isEmpty)
    }

    func testStartRequiresALiveExpirationListenerOwner() {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        coordinator.start(taskId: "sync-1", ownerId: ownerA) { outcomes.append($0) }

        XCTAssertEqual(outcomes, [.failure(.listenerUnavailable)])
        XCTAssertTrue(scheduler.registrations.isEmpty)
        XCTAssertTrue(scheduler.submissions.isEmpty)
    }

    func testQueuedStartFromARetiredOwnerRejectsAfterReplacementListenerAppears() {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var replacementExpirations: [String] = []
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { _ in })
        let queuedOwner = ownerA
        coordinator.deactivateOwner(ownerId: ownerA)
        coordinator.activateOwner(ownerId: ownerB, onExpiration: { replacementExpirations.append($0) })
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        // Simulates the main-queue block running after both listener changes.
        coordinator.start(taskId: "sync-old", ownerId: queuedOwner) { outcomes.append($0) }

        XCTAssertEqual(outcomes, [.failure(.listenerUnavailable)])
        XCTAssertTrue(scheduler.registrations.isEmpty)
        XCTAssertTrue(scheduler.submissions.isEmpty)
        XCTAssertEqual(replacementExpirations, [])

        coordinator.start(taskId: "sync-new", ownerId: ownerB) { outcomes.append($0) }
        XCTAssertNotNil(scheduler.launch(taskId: "sync-new"))
        XCTAssertEqual(outcomes.last, .success(.launched))
    }

    func testRejectsInvalidTaskIdentifiersBeforeRegistration() {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { _ in })
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        coordinator.start(taskId: "", ownerId: ownerA) { outcomes.append($0) }
        coordinator.start(taskId: "bad id/with spaces", ownerId: ownerA) { outcomes.append($0) }

        XCTAssertEqual(outcomes, [.failure(.invalidTaskId), .failure(.invalidTaskId)])
        XCTAssertTrue(scheduler.registrations.isEmpty)
        XCTAssertTrue(scheduler.submissions.isEmpty)
    }

    func testRejectsReusingASubmittedTaskIdentifier() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { _ in })
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        coordinator.start(taskId: "sync-1", ownerId: ownerA) { outcomes.append($0) }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))
        coordinator.complete(taskId: "sync-1", ownerId: ownerA, success: true)
        coordinator.start(taskId: "sync-1", ownerId: ownerA) { outcomes.append($0) }

        XCTAssertEqual(grant.completions, [true])
        XCTAssertEqual(outcomes, [.success(.launched), .failure(.taskIdAlreadyUsed)])
        XCTAssertEqual(scheduler.registrations, ["com.dofek.app.healthkit-sync.sync-1"])
        XCTAssertEqual(scheduler.submissions.count, 1)
    }

    func testRegistrationFailureRejectsTheStartWithoutSubmitting() {
        let scheduler = FakeContinuedProcessingScheduler()
        scheduler.registrationSucceeds = false
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { _ in })
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        coordinator.start(taskId: "sync-1", ownerId: ownerA) { outcomes.append($0) }

        XCTAssertEqual(outcomes, [.failure(.registrationFailed)])
        XCTAssertTrue(scheduler.submissions.isEmpty)
    }

    func testRejectsAStartWhileAnotherRequestIsPendingOrRunning() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { _ in })
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        coordinator.start(taskId: "sync-1", ownerId: ownerA) { outcomes.append($0) }
        coordinator.start(taskId: "sync-2", ownerId: ownerA) { outcomes.append($0) }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))
        coordinator.start(taskId: "sync-3", ownerId: ownerA) { outcomes.append($0) }

        XCTAssertEqual(outcomes, [
            .failure(.alreadyRunning),
            .success(.launched),
            .failure(.alreadyRunning),
        ])
        XCTAssertEqual(scheduler.registrations, ["com.dofek.app.healthkit-sync.sync-1"])
        XCTAssertEqual(scheduler.submissions.count, 1)
        XCTAssertEqual(grant.completions, [])
    }

    func testSubmissionFailureRejectsTheStartAndAllowsAFreshTaskIdRetry() {
        let scheduler = FakeContinuedProcessingScheduler()
        scheduler.submitError = NSError(
            domain: "BGTaskSchedulerErrorDomain",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "The operation could not be completed."]
        )
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { _ in })
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        coordinator.start(taskId: "sync-1", ownerId: ownerA) { outcomes.append($0) }

        guard case .failure(.submissionFailed(let description)) = outcomes.first else {
            return XCTFail("Expected a specific submission failure, got \(outcomes)")
        }
        XCTAssertTrue(description.contains("The operation could not be completed."))

        scheduler.submitError = nil
        coordinator.start(taskId: "sync-1-retry", ownerId: ownerA) { outcomes.append($0) }
        _ = scheduler.launch(taskId: "sync-1-retry")
        XCTAssertEqual(scheduler.registrations, [
            "com.dofek.app.healthkit-sync.sync-1",
            "com.dofek.app.healthkit-sync.sync-1-retry",
        ])
        XCTAssertEqual(scheduler.submissions.count, 1)
        XCTAssertEqual(outcomes.count, 2)
        XCTAssertEqual(outcomes.last, .success(.launched))
    }

    func testTeardownDuringLaunchHandlerInstallationRejectsTheStartAndLeavesNoHandler() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { _ in })
        scheduler.configureGrant = { grant in
            grant.onSetExpirationHandler = { handler in
                if handler != nil {
                    coordinator.deactivateOwner(ownerId: self.ownerA)
                }
            }
        }
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        coordinator.start(taskId: "sync-1", ownerId: ownerA) { outcomes.append($0) }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))

        XCTAssertEqual(outcomes, [.failure(.cancelledBeforeTeardown)])
        XCTAssertEqual(grant.completions, [false])
        XCTAssertNil(grant.expirationHandler)
    }

    func testExpirationDuringLaunchHandlerInstallationRejectsTheStartWithoutAnEvent() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var expiredTaskIds: [String] = []
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { expiredTaskIds.append($0) })
        scheduler.configureGrant = { grant in
            grant.onSetExpirationHandler = { handler in
                handler?()
            }
        }
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []

        coordinator.start(taskId: "sync-1", ownerId: ownerA) { outcomes.append($0) }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))

        XCTAssertEqual(outcomes, [.failure(.expiredBeforeLaunch)])
        XCTAssertEqual(expiredTaskIds, [])
        XCTAssertEqual(grant.completions, [false])
        XCTAssertNil(grant.expirationHandler)
    }

    func testExpirationCompletesTheActiveTaskExactlyOnceAndNotifiesWithTheTaskId() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var expiredTaskIds: [String] = []
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { expiredTaskIds.append($0) })
        coordinator.start(taskId: "sync-1", ownerId: ownerA) { _ in }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))

        grant.expirationHandler?()
        coordinator.complete(taskId: "sync-1", ownerId: ownerA, success: true)

        XCTAssertEqual(grant.completions, [false])
        XCTAssertEqual(expiredTaskIds, ["sync-1"])
        XCTAssertNil(grant.expirationHandler)
    }

    func testCompletionRunsOnceAndACapturedLateExpirationIsIgnored() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var expiredTaskIds: [String] = []
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { expiredTaskIds.append($0) })
        coordinator.start(taskId: "sync-1", ownerId: ownerA) { _ in }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))
        let lateExpiration = grant.expirationHandler

        coordinator.complete(taskId: "sync-1", ownerId: ownerA, success: true)
        coordinator.complete(taskId: "sync-1", ownerId: ownerA, success: false)
        lateExpiration?()

        XCTAssertEqual(grant.completions, [true])
        XCTAssertEqual(expiredTaskIds, [])
        XCTAssertNil(grant.expirationHandler)
    }

    func testLateLaunchFromAnAbandonedRequestCannotStartOrCompleteANewerTask() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var expiredTaskIds: [String] = []
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { expiredTaskIds.append($0) })
        coordinator.start(taskId: "sync-1", ownerId: ownerA) { _ in }
        let firstGrant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))
        let lateExpiration = firstGrant.expirationHandler
        coordinator.complete(taskId: "sync-1", ownerId: ownerA, success: true)

        coordinator.start(taskId: "sync-2", ownerId: ownerA) { _ in }
        let secondGrant = try XCTUnwrap(scheduler.launch(taskId: "sync-2"))
        lateExpiration?()
        _ = scheduler.launch(taskId: "sync-1")

        XCTAssertEqual(firstGrant.completions, [true])
        XCTAssertEqual(secondGrant.completions, [])
        XCTAssertEqual(expiredTaskIds, [])
    }

    func testProgressOnlyAppliesToTheMatchingOwnedActiveTaskAndReflectsCompletedWork() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { _ in })

        coordinator.updateProgress(
            taskId: "sync-1",
            ownerId: ownerA,
            completed: 1,
            total: 4,
            message: "Before launch"
        )

        coordinator.start(taskId: "sync-1", ownerId: ownerA) { _ in }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))

        coordinator.updateProgress(
            taskId: "sync-2",
            ownerId: ownerA,
            completed: 3,
            total: 4,
            message: "Other task"
        )
        coordinator.updateProgress(
            taskId: "sync-1",
            ownerId: ownerB,
            completed: 3,
            total: 4,
            message: "Other owner"
        )
        coordinator.updateProgress(
            taskId: "sync-1",
            ownerId: ownerA,
            completed: 2,
            total: 4,
            message: "Uploading workouts"
        )

        XCTAssertEqual(grant.progressUpdates.count, 1)
        XCTAssertEqual(grant.progressUpdates.first?.completed, 2)
        XCTAssertEqual(grant.progressUpdates.first?.total, 4)
        XCTAssertEqual(grant.progressUpdates.first?.subtitle, "Uploading workouts")
    }

    func testProgressClampsInvalidValuesBeforeReportingToTheSystem() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { _ in })
        coordinator.start(taskId: "sync-1", ownerId: ownerA) { _ in }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))

        coordinator.updateProgress(
            taskId: "sync-1",
            ownerId: ownerA,
            completed: 9,
            total: 0,
            message: ""
        )

        XCTAssertEqual(grant.progressUpdates.first?.completed, 1)
        XCTAssertEqual(grant.progressUpdates.first?.total, 1)
        XCTAssertEqual(grant.progressUpdates.first?.subtitle, "")
    }

    func testDeactivateRejectsAPendingStartAndCompletesAnActiveTaskOnce() throws {
        let pendingScheduler = FakeContinuedProcessingScheduler()
        let pendingCoordinator = HealthKitSyncTaskCoordinator(scheduler: pendingScheduler)
        pendingCoordinator.activateOwner(ownerId: ownerA, onExpiration: { _ in })
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []
        pendingCoordinator.start(taskId: "pending", ownerId: ownerA) { outcomes.append($0) }

        pendingCoordinator.deactivateOwner(ownerId: ownerA)

        XCTAssertEqual(outcomes, [.failure(.cancelledBeforeTeardown)])
        let lateGrant = try XCTUnwrap(pendingScheduler.launch(taskId: "pending"))
        XCTAssertEqual(lateGrant.completions, [false])

        let activeScheduler = FakeContinuedProcessingScheduler()
        let activeCoordinator = HealthKitSyncTaskCoordinator(scheduler: activeScheduler)
        activeCoordinator.activateOwner(ownerId: ownerA, onExpiration: { _ in })
        activeCoordinator.start(taskId: "active", ownerId: ownerA) { _ in }
        let activeGrant = try XCTUnwrap(activeScheduler.launch(taskId: "active"))

        activeCoordinator.deactivateOwner(ownerId: ownerA)
        activeCoordinator.deactivateOwner(ownerId: ownerA)
        activeCoordinator.complete(taskId: "active", ownerId: ownerA, success: true)

        XCTAssertEqual(activeGrant.completions, [false])
        XCTAssertNil(activeGrant.expirationHandler)
    }

    func testDestroyingAnOldOwnerDoesNotEndAReplacementOwnersRequest() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { _ in })
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []
        coordinator.start(taskId: "old", ownerId: ownerA) { outcomes.append($0) }
        coordinator.destroyOwner(ownerId: ownerA)
        XCTAssertEqual(outcomes, [.failure(.cancelledBeforeTeardown)])

        coordinator.activateOwner(ownerId: ownerB, onExpiration: { _ in })
        coordinator.start(taskId: "new", ownerId: ownerB) { outcomes.append($0) }
        let replacementGrant = try XCTUnwrap(scheduler.launch(taskId: "new"))

        coordinator.destroyOwner(ownerId: ownerA)
        XCTAssertEqual(replacementGrant.completions, [])

        coordinator.complete(taskId: "new", ownerId: ownerB, success: true)
        XCTAssertEqual(replacementGrant.completions, [true])
        XCTAssertEqual(outcomes, [.failure(.cancelledBeforeTeardown), .success(.launched)])
    }

    func testDestroyingAnOwnerCompletesItsActiveTaskOnce() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { _ in })
        coordinator.start(taskId: "active", ownerId: ownerA) { _ in }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "active"))

        coordinator.destroyOwner(ownerId: ownerA)
        coordinator.destroyOwner(ownerId: ownerA)

        XCTAssertEqual(grant.completions, [false])
        XCTAssertNil(grant.expirationHandler)
    }

    func testReplacementListenerRetiresThePreviousOwnersActiveTask() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { _ in })
        coordinator.start(taskId: "old", ownerId: ownerA) { _ in }
        let oldGrant = try XCTUnwrap(scheduler.launch(taskId: "old"))

        coordinator.activateOwner(ownerId: ownerB, onExpiration: { _ in })

        XCTAssertEqual(oldGrant.completions, [false])
        XCTAssertNil(oldGrant.expirationHandler)
    }

    func testDeactivationDoesNotNotifyExpirationForARetiredActiveTask() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        var expiredTaskIds: [String] = []
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { expiredTaskIds.append($0) })
        coordinator.start(taskId: "sync-1", ownerId: ownerA) { _ in }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))

        coordinator.deactivateOwner(ownerId: ownerA)

        XCTAssertEqual(grant.completions, [false])
        XCTAssertEqual(expiredTaskIds, [])
    }

    func testStaleRegistrationFailureCannotRejectANewerStartWithTheSameTaskId() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        coordinator.activateOwner(ownerId: ownerA, onExpiration: { _ in })
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []
        var registrationCalls = 0
        scheduler.onRegister = { _ in
            registrationCalls += 1
            guard registrationCalls == 1 else { return true }
            coordinator.deactivateOwner(ownerId: self.ownerA)
            coordinator.activateOwner(ownerId: self.ownerA, onExpiration: { _ in })
            coordinator.start(taskId: "sync-1", ownerId: self.ownerA) { outcomes.append($0) }
            return false
        }

        coordinator.start(taskId: "sync-1", ownerId: ownerA) { outcomes.append($0) }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "sync-1"))

        XCTAssertEqual(scheduler.registrations, [
            "com.dofek.app.healthkit-sync.sync-1",
            "com.dofek.app.healthkit-sync.sync-1",
        ])
        XCTAssertEqual(scheduler.submissions.count, 1)
        XCTAssertEqual(outcomes, [.failure(.cancelledBeforeTeardown), .success(.launched)])
        XCTAssertNotNil(grant.expirationHandler)
    }
}
