import HealthKit
import XCTest

@testable import HealthKitLib

final class HealthKitAuthorizationErrorTests: XCTestCase {
    func testUserCanceledAuthorizationResolvesAsDeniedPermission() {
        let error = HKError(.errorUserCanceled)

        XCTAssertTrue(isUserCanceledHealthKitAuthorization(error))
    }
}
