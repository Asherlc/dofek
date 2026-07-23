import HealthKit
import XCTest

@testable import HealthKitLib

final class HealthKitErrorDetailsTests: XCTestCase {
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
