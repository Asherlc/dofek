import XCTest
@testable import HealthKitLib

final class HealthKitObserverUpdateCoordinatorTests: XCTestCase {
    func testCompletesRegisteredUpdateExactlyOnce() {
        var completionCount = 0
        let coordinator = HealthKitObserverUpdateCoordinator(timeout: 60)
        let updateId = coordinator.register {
            completionCount += 1
        }

        XCTAssertEqual(coordinator.complete(updateIds: [updateId]), 1)
        XCTAssertEqual(coordinator.complete(updateIds: [updateId]), 0)
        XCTAssertEqual(completionCount, 1)
    }

    func testCompletesCoalescedUpdatesTogether() {
        var completed: [String] = []
        let coordinator = HealthKitObserverUpdateCoordinator(timeout: 60)
        let firstId = coordinator.register {
            completed.append("first")
        }
        let secondId = coordinator.register {
            completed.append("second")
        }

        XCTAssertEqual(coordinator.complete(updateIds: [firstId, secondId]), 2)
        XCTAssertEqual(completed, ["first", "second"])
    }

    func testExpiresUpdateExactlyOnceAndReportsIt() {
        let completed = expectation(description: "completion called")
        let expired = expectation(description: "expiration reported")
        var completionCount = 0
        var expiredId: String?
        let coordinator = HealthKitObserverUpdateCoordinator(
            timeout: 0.01,
            reportExpiration: { updateId in
                expiredId = updateId
                expired.fulfill()
            }
        )
        let updateId = coordinator.register {
            completionCount += 1
            completed.fulfill()
        }

        wait(for: [completed, expired], timeout: 1)

        XCTAssertEqual(expiredId, updateId)
        XCTAssertEqual(coordinator.complete(updateIds: [updateId]), 0)
        XCTAssertEqual(completionCount, 1)
    }

    func testTeardownCompletesEveryPendingUpdateExactlyOnce() {
        var completionCount = 0
        let coordinator = HealthKitObserverUpdateCoordinator(timeout: 60)
        let firstId = coordinator.register {
            completionCount += 1
        }
        let secondId = coordinator.register {
            completionCount += 1
        }

        XCTAssertEqual(coordinator.completeAll(), 2)
        XCTAssertEqual(coordinator.completeAll(), 0)
        XCTAssertEqual(coordinator.complete(updateIds: [firstId, secondId]), 0)
        XCTAssertEqual(completionCount, 2)
    }
}
