import XCTest
@testable import WhoopBLE

final class WhoopBleConnectionStateTests: XCTestCase {
    func testNotificationSubscriptionFailureHasActionableRejection() {
        let rejection = WhoopBleConnectionError
            .notificationSubscriptionFailed("DATA_FROM_STRAP is not notifying")
            .rejection

        XCTAssertEqual(rejection.code, "NOTIFICATION_SUBSCRIPTION_FAILED")
        XCTAssertEqual(rejection.message, "DATA_FROM_STRAP is not notifying")
    }
}
