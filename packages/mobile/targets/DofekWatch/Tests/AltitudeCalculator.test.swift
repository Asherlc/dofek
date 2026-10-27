// @bacons/apple-targets includes all Swift files in the target directory as app
// target sources. XCTest is only available on the framework search path for test
// targets, so guard the entire file to prevent "no such module" errors during
// app builds (both device and simulator).
#if canImport(XCTest)
import XCTest

final class AltitudeCalculatorTests: XCTestCase {
    func testRelativeAltitudeIsZeroAtBaseline() {
        let altitude = AltitudeCalculator.relativeAltitudeMeters(pressureKPa: 101.325, baselinePressureKPa: 101.325)
        XCTAssertEqual(altitude, 0, accuracy: 0.001)
    }

    func testRelativeAltitudeIncreasesWhenPressureDrops() {
        let altitude = AltitudeCalculator.relativeAltitudeMeters(pressureKPa: 100.0, baselinePressureKPa: 101.325)
        XCTAssertGreaterThan(altitude, 0)
    }

    func testRelativeAltitudeDecreasesWhenPressureRises() {
        let altitude = AltitudeCalculator.relativeAltitudeMeters(pressureKPa: 102.0, baselinePressureKPa: 101.325)
        XCTAssertLessThan(altitude, 0)
    }

    func testRelativeAltitudeReturnsZeroForInvalidPressure() {
        XCTAssertEqual(
            AltitudeCalculator.relativeAltitudeMeters(pressureKPa: 0, baselinePressureKPa: 101.325),
            0
        )
        XCTAssertEqual(
            AltitudeCalculator.relativeAltitudeMeters(pressureKPa: 101.325, baselinePressureKPa: 0),
            0
        )
    }
}
#endif
