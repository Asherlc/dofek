import HealthKit
import XCTest

@testable import HealthKitLib

final class HealthKitAuthorizationErrorTests: XCTestCase {
    func testUserCanceledAuthorizationResolvesAsDeniedPermission() {
        let error = HKError(.errorUserCanceled)

        XCTAssertTrue(isUserCanceledHealthKitAuthorization(error))
    }

    func testNSErrorUserCanceledAuthorizationResolvesAsDeniedPermission() {
        let error = NSError(
            domain: HKError.errorDomain,
            code: HKError.Code.errorUserCanceled.rawValue
        )

        XCTAssertTrue(isUserCanceledHealthKitAuthorization(error))
    }

    func testUnrelatedErrorDoesNotResolveAsDeniedPermission() {
        XCTAssertFalse(isUserCanceledHealthKitAuthorization(NSError()))
    }

    func testDifferentHealthKitErrorDoesNotResolveAsDeniedPermission() {
        let error = HKError(.errorAuthorizationDenied)

        XCTAssertFalse(isUserCanceledHealthKitAuthorization(error))
    }
}
