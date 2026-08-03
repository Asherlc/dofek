import XCTest
@testable import HealthKitLib

final class HealthKitObserverUpdateCoordinatorTests: XCTestCase {
    func testCompletesRegisteredUpdateExactlyOnce() {
        var completionCount = 0
        let coordinator = HealthKitObserverUpdateCoordinator(timeout: 60)
        let updateId = coordinator.register(typeIdentifier: "HKQuantityTypeIdentifierStepCount") {
            completionCount += 1
        }

        XCTAssertEqual(coordinator.complete(updateIds: [updateId]), 1)
        XCTAssertEqual(coordinator.complete(updateIds: [updateId]), 0)
        XCTAssertEqual(completionCount, 1)
    }

    func testCompletesCoalescedUpdatesTogether() {
        var completed: [String] = []
        let coordinator = HealthKitObserverUpdateCoordinator(timeout: 60)
        let firstId = coordinator.register(typeIdentifier: "HKQuantityTypeIdentifierStepCount") {
            completed.append("first")
        }
        let secondId = coordinator.register(typeIdentifier: "HKQuantityTypeIdentifierHeartRate") {
            completed.append("second")
        }

        XCTAssertEqual(coordinator.complete(updateIds: [firstId, secondId]), 2)
        XCTAssertEqual(completed, ["first", "second"])
    }

    func testExpiresUpdateExactlyOnceAndReportsIt() {
        let completed = expectation(description: "completion called")
        let expired = expectation(description: "expiration reported")
        var completionCount = 0
        var expiration: HealthKitObserverUpdateExpiration?
        let coordinator = HealthKitObserverUpdateCoordinator(
            timeout: 0.01,
            reportExpiration: { updateExpiration in
                expiration = updateExpiration
                expired.fulfill()
            }
        )
        let updateId = coordinator.register(typeIdentifier: "HKQuantityTypeIdentifierHeartRate") {
            completionCount += 1
            completed.fulfill()
        }

        wait(for: [completed, expired], timeout: 1)

        XCTAssertEqual(expiration?.updateId, updateId)
        XCTAssertEqual(expiration?.typeIdentifier, "HKQuantityTypeIdentifierHeartRate")
        XCTAssertGreaterThanOrEqual(expiration?.ageMilliseconds ?? 0, 10)
        XCTAssertEqual(coordinator.complete(updateIds: [updateId]), 0)
        XCTAssertEqual(completionCount, 1)
    }

    func testHasPendingUpdatesReflectsRegistrationAndCompletion() {
        let coordinator = HealthKitObserverUpdateCoordinator(timeout: 60)
        XCTAssertFalse(coordinator.hasPendingUpdates)

        let updateId = coordinator.register(typeIdentifier: "HKQuantityTypeIdentifierStepCount") {}
        XCTAssertTrue(coordinator.hasPendingUpdates)

        XCTAssertEqual(coordinator.complete(updateIds: [updateId]), 1)
        XCTAssertFalse(coordinator.hasPendingUpdates)
    }

    func testHasPendingUpdatesStaysTrueUntilLastUpdateCompletes() {
        let coordinator = HealthKitObserverUpdateCoordinator(timeout: 60)
        let firstId = coordinator.register(typeIdentifier: "HKQuantityTypeIdentifierStepCount") {}
        let secondId = coordinator.register(typeIdentifier: "HKQuantityTypeIdentifierHeartRate") {}

        XCTAssertTrue(coordinator.hasPendingUpdates)

        XCTAssertEqual(coordinator.complete(updateIds: [firstId]), 1)
        XCTAssertTrue(coordinator.hasPendingUpdates)

        XCTAssertEqual(coordinator.complete(updateIds: [secondId]), 1)
        XCTAssertFalse(coordinator.hasPendingUpdates)
    }

    func testTeardownCompletesEveryPendingUpdateExactlyOnce() {
        var completionCount = 0
        let coordinator = HealthKitObserverUpdateCoordinator(timeout: 60)
        let firstId = coordinator.register(typeIdentifier: "HKQuantityTypeIdentifierStepCount") {
            completionCount += 1
        }
        let secondId = coordinator.register(typeIdentifier: "HKQuantityTypeIdentifierHeartRate") {
            completionCount += 1
        }

        XCTAssertEqual(coordinator.completeAll(), 2)
        XCTAssertEqual(coordinator.completeAll(), 0)
        XCTAssertEqual(coordinator.complete(updateIds: [firstId, secondId]), 0)
        XCTAssertEqual(completionCount, 2)
    }
}
