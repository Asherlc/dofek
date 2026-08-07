import XCTest
@testable import BleHeartRateLib

final class BleHeartRateConstantsTests: XCTestCase {
    func testHeartRateServiceUsesAssignedNumber180D() {
        XCTAssertEqual(BleHeartRateConstants.heartRateServiceUUID.uuidString, "180D")
    }

    func testHeartRateMeasurementUsesAssignedNumber2A37() {
        XCTAssertEqual(BleHeartRateConstants.heartRateMeasurementUUID.uuidString, "2A37")
    }
}
