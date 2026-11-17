import HealthKit
import XCTest

@testable import HealthKitLib

final class HealthKitAuthorizationErrorTests: XCTestCase {
    func testBackgroundInterruptedAuthorizationResolvesWithoutGrantingPermission() {
        let error = HKError(.errorAuthorizationNotDetermined)

        XCTAssertTrue(isCanceledHealthKitAuthorization(error, didEnterBackground: true))
        XCTAssertFalse(isCanceledHealthKitAuthorization(error, didEnterBackground: false))
    }

    func testBackgroundStateDoesNotHideOtherErrors() {
        XCTAssertFalse(isCanceledHealthKitAuthorization(
            HKError(.errorAuthorizationDenied), didEnterBackground: true
        ))
        XCTAssertFalse(isCanceledHealthKitAuthorization(
            NSError(domain: NSCocoaErrorDomain, code: 5), didEnterBackground: true
        ))
    }

    func testUserCanceledAuthorizationResolvesAsDeniedPermission() {
        let error = HKError(.errorUserCanceled)

        XCTAssertTrue(isCanceledHealthKitAuthorization(error, didEnterBackground: false))
    }

    func testNSErrorUserCanceledAuthorizationResolvesAsDeniedPermission() {
        let error = NSError(
            domain: HKError.errorDomain,
            code: HKError.Code.errorUserCanceled.rawValue
        )

        XCTAssertTrue(isCanceledHealthKitAuthorization(error, didEnterBackground: false))
    }

    func testUnrelatedErrorDoesNotResolveAsDeniedPermission() {
        let error = NSError(
            domain: NSCocoaErrorDomain,
            code: CocoaError.fileNoSuchFile.rawValue
        )

        XCTAssertFalse(isCanceledHealthKitAuthorization(error, didEnterBackground: false))
    }

    func testDifferentHealthKitErrorDoesNotResolveAsDeniedPermission() {
        let error = HKError(.errorAuthorizationDenied)

        XCTAssertFalse(isCanceledHealthKitAuthorization(error, didEnterBackground: false))
    }
}
