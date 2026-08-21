import XCTest
@testable import CoreMotionLib

final class CoreMotionIsoDateParserTests: XCTestCase {
    func testParsesInternetDateTimeWithFractionalSeconds() throws {
        let date = try XCTUnwrap(CoreMotionIsoDateParser.parse("2026-07-24T12:34:56.789Z"))

        XCTAssertEqual(date.timeIntervalSince1970, 1_784_896_496.789, accuracy: 0.001)
    }

    func testParsesInternetDateTimeWithoutFractionalSeconds() throws {
        let date = try XCTUnwrap(CoreMotionIsoDateParser.parse("2026-07-24T12:34:56Z"))

        XCTAssertEqual(date.timeIntervalSince1970, 1_784_896_496)
    }

    func testRejectsInvalidDate() {
        XCTAssertNil(CoreMotionIsoDateParser.parse("not-a-date"))
    }
}
