import XCTest

@testable import HealthKitLib

final class HealthKitBackgroundDeliveryCoordinatorTests: XCTestCase {
    func testCompletesRegisteredDeliveryExactlyOnce() {
        let coordinator = HealthKitBackgroundDeliveryCoordinator()
        var completionCount = 0
        let deliveryId = coordinator.register {
            completionCount += 1
        }

        XCTAssertEqual(coordinator.pendingCount, 1)
        XCTAssertTrue(coordinator.complete(deliveryId))
        XCTAssertEqual(completionCount, 1)
        XCTAssertEqual(coordinator.pendingCount, 0)
        XCTAssertFalse(coordinator.complete(deliveryId))
        XCTAssertEqual(completionCount, 1)
    }

    func testCompleteAllReleasesEveryPendingDelivery() {
        let coordinator = HealthKitBackgroundDeliveryCoordinator()
        var completedDeliveryIds: Set<String> = []
        let firstDeliveryId = coordinator.register {
            completedDeliveryIds.insert("first")
        }
        let secondDeliveryId = coordinator.register {
            completedDeliveryIds.insert("second")
        }

        XCTAssertNotEqual(firstDeliveryId, secondDeliveryId)
        coordinator.completeAll()

        XCTAssertEqual(completedDeliveryIds, ["first", "second"])
        XCTAssertEqual(coordinator.pendingCount, 0)
        XCTAssertFalse(coordinator.complete(firstDeliveryId))
        XCTAssertFalse(coordinator.complete(secondDeliveryId))
    }
}
