import XCTest
@testable import BackgroundRefreshLib

final class HealthKitSyncListenerLifecycleTests: XCTestCase {
    func testSameModuleListenerReplacementRejectsThePreviousGenerationsQueuedStart() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        let lifecycle = HealthKitSyncListenerLifecycle()

        let firstGeneration = lifecycle.begin()
        coordinator.activateOwner(ownerId: firstGeneration, onExpiration: { _ in })

        // startHealthKitSync captures the live generation before its main-queue hop.
        let queuedOwnerId = try XCTUnwrap(lifecycle.current())
        XCTAssertEqual(queuedOwnerId, firstGeneration)

        // OnStopObserving then OnStartObserving on the same module.
        let retiredGeneration = try XCTUnwrap(lifecycle.end())
        XCTAssertEqual(retiredGeneration, firstGeneration)
        let replacementGeneration = lifecycle.begin()
        XCTAssertNotEqual(replacementGeneration, firstGeneration)
        coordinator.activateOwner(ownerId: replacementGeneration, onExpiration: { _ in })

        // The delayed main block finally runs.
        var outcomes: [Result<HealthKitSyncStartOutcome, HealthKitSyncStartError>] = []
        coordinator.start(taskId: "queued", ownerId: queuedOwnerId) { outcomes.append($0) }

        XCTAssertEqual(outcomes, [.failure(.listenerUnavailable)])
        XCTAssertTrue(scheduler.registrations.isEmpty)
        XCTAssertTrue(scheduler.submissions.isEmpty)

        // The replacement generation still owns new work.
        coordinator.start(taskId: "replacement", ownerId: replacementGeneration) { outcomes.append($0) }
        let grant = try XCTUnwrap(scheduler.launch(taskId: "replacement"))
        XCTAssertEqual(outcomes.last, .success(.launched))
        XCTAssertNotNil(grant.expirationHandler)
    }

    func testRetiringOneGenerationCannotRetireTheNextGenerationsActiveTask() throws {
        let scheduler = FakeContinuedProcessingScheduler()
        let coordinator = HealthKitSyncTaskCoordinator(scheduler: scheduler)
        let lifecycle = HealthKitSyncListenerLifecycle()

        let firstGeneration = lifecycle.begin()
        coordinator.activateOwner(ownerId: firstGeneration, onExpiration: { _ in })
        coordinator.start(taskId: "old", ownerId: firstGeneration) { _ in }
        let oldGrant = try XCTUnwrap(scheduler.launch(taskId: "old"))
        let retiredGeneration = try XCTUnwrap(lifecycle.end())
        coordinator.deactivateOwner(ownerId: retiredGeneration)

        let replacementGeneration = lifecycle.begin()
        coordinator.activateOwner(ownerId: replacementGeneration, onExpiration: { _ in })
        coordinator.start(taskId: "new", ownerId: replacementGeneration) { _ in }
        let newGrant = try XCTUnwrap(scheduler.launch(taskId: "new"))

        // Stale cleanup for the retired generation cannot touch "new".
        coordinator.destroyOwner(ownerId: retiredGeneration)
        coordinator.deactivateOwner(ownerId: retiredGeneration)

        XCTAssertEqual(oldGrant.completions, [false])
        XCTAssertNil(oldGrant.expirationHandler)
        XCTAssertEqual(newGrant.completions, [])
        XCTAssertNotNil(newGrant.expirationHandler)
    }

    func testListenerLifecycleMintsAFreshGenerationForEveryActivation() {
        let lifecycle = HealthKitSyncListenerLifecycle()
        XCTAssertNil(lifecycle.current())

        let first = lifecycle.begin()
        XCTAssertEqual(lifecycle.current(), first)
        XCTAssertEqual(lifecycle.end(), first)
        XCTAssertNil(lifecycle.current())
        XCTAssertNil(lifecycle.end())

        let second = lifecycle.begin()
        XCTAssertNotEqual(second, first)
        XCTAssertEqual(lifecycle.current(), second)
    }
}
