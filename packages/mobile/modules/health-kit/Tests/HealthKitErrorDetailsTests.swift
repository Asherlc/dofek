import HealthKit
import XCTest

@testable import HealthKitLib

final class HealthKitErrorDetailsTests: XCTestCase {
    func testAuthorizationNotDeterminedMatchesOnlyHealthKitCode() {
        let authorizationError = NSError(
            domain: HKErrorDomain,
            code: HKError.Code.errorAuthorizationNotDetermined.rawValue
        )
        let unrelatedHealthKitError = NSError(
            domain: HKErrorDomain,
            code: HKError.Code.errorInvalidArgument.rawValue
        )
        let sameCodeFromAnotherDomain = NSError(
            domain: "HealthKitTest",
            code: HKError.Code.errorAuthorizationNotDetermined.rawValue
        )

        XCTAssertTrue(HealthKitErrorDetails.isAuthorizationNotDetermined(authorizationError))
        XCTAssertFalse(HealthKitErrorDetails.isAuthorizationNotDetermined(unrelatedHealthKitError))
        XCTAssertFalse(HealthKitErrorDetails.isAuthorizationNotDetermined(sameCodeFromAnotherDomain))
    }

    func testObserverReportingSkipsExpectedAuthorizationStateOnly() {
        let authorizationError = NSError(
            domain: HKErrorDomain,
            code: HKError.Code.errorAuthorizationNotDetermined.rawValue
        )
        let unexpectedError = NSError(
            domain: HKErrorDomain,
            code: HKError.Code.errorInvalidArgument.rawValue
        )

        XCTAssertFalse(HealthKitErrorDetails.shouldReportObserverError(authorizationError))
        XCTAssertTrue(HealthKitErrorDetails.shouldReportObserverError(unexpectedError))
    }

    func testDatabaseInaccessibleUsesStableCodeAndNativeContext() {
        let nativeError = NSError(
            domain: HKErrorDomain,
            code: HKError.Code.errorDatabaseInaccessible.rawValue,
            userInfo: [NSLocalizedDescriptionKey: "Protected health data is inaccessible"]
        )

        let details = HealthKitErrorDetails(
            operation: "queryQuantitySamples(HKQuantityTypeIdentifierHeartRate)",
            fallbackCode: "QUERY_ERROR",
            error: nativeError
        )

        XCTAssertEqual(details.code, "HEALTHKIT_DATABASE_INACCESSIBLE")
        XCTAssertEqual(
            details.reason,
            "queryQuantitySamples(HKQuantityTypeIdentifierHeartRate) failed: " +
                "Protected health data is inaccessible (com.apple.healthkit:6)"
        )
    }

    func testUnexpectedErrorKeepsFallbackCodeAndNativeContext() {
        let nativeError = NSError(
            domain: "HealthKitTest",
            code: 42,
            userInfo: [NSLocalizedDescriptionKey: "Unexpected query failure"]
        )

        let details = HealthKitErrorDetails(
            operation: "queryWorkouts",
            fallbackCode: "QUERY_ERROR",
            error: nativeError
        )

        XCTAssertEqual(details.code, "QUERY_ERROR")
        XCTAssertEqual(
            details.reason,
            "queryWorkouts failed: Unexpected query failure (HealthKitTest:42)"
        )
    }
}
