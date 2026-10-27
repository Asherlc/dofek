import XCTest
@testable import BleHeartRateLib

final class BleHeartRateMeasurementParserTests: XCTestCase {
    func testParsesUInt8HeartRateWithoutRrIntervals() {
        // flags 0x00 (uint8, no RR), bpm 60
        let data = Data([0x00, 0x3C])
        let measurement = BleHeartRateMeasurementParser.parse(data)
        XCTAssertEqual(measurement, BleHeartRateMeasurement(heartRateBpm: 60, rrIntervalsMs: []))
    }

    func testParsesUInt16HeartRate() {
        // flags 0x01 (uint16), bpm 300 = 0x012C little-endian
        let data = Data([0x01, 0x2C, 0x01])
        let measurement = BleHeartRateMeasurementParser.parse(data)
        XCTAssertEqual(measurement?.heartRateBpm, 300)
        XCTAssertEqual(measurement?.rrIntervalsMs, [])
    }

    func testParsesSingleRrInterval() {
        // flags 0x10 (RR present), bpm 60, RR raw 1024 (= 1000 ms) = 0x0400 little-endian
        let data = Data([0x10, 0x3C, 0x00, 0x04])
        let measurement = BleHeartRateMeasurementParser.parse(data)
        XCTAssertEqual(measurement, BleHeartRateMeasurement(heartRateBpm: 60, rrIntervalsMs: [1000]))
    }

    func testParsesMultipleRrIntervals() {
        // flags 0x10, bpm 60, RR raw 1024 (1000 ms) and 512 (500 ms)
        let data = Data([0x10, 0x3C, 0x00, 0x04, 0x00, 0x02])
        let measurement = BleHeartRateMeasurementParser.parse(data)
        XCTAssertEqual(measurement?.rrIntervalsMs, [1000, 500])
    }

    func testSkipsEnergyExpendedBeforeRrIntervals() {
        // flags 0x18 (energy expended + RR), bpm 60, energy 0x01F4, RR raw 1024
        let data = Data([0x18, 0x3C, 0xF4, 0x01, 0x00, 0x04])
        let measurement = BleHeartRateMeasurementParser.parse(data)
        XCTAssertEqual(measurement, BleHeartRateMeasurement(heartRateBpm: 60, rrIntervalsMs: [1000]))
    }

    func testRoundsRrIntervalConversion() {
        // RR raw 1000 units → 1000 * 1000 / 1024 = 976.5625 ms → rounds to 977
        let data = Data([0x10, 0x3C, 0xE8, 0x03])
        let measurement = BleHeartRateMeasurementParser.parse(data)
        XCTAssertEqual(measurement?.rrIntervalsMs, [977])
    }

    func testReturnsNilWhenEnergyExpendedFieldIsTruncated() {
        // flags 0x08 (energy expended present), bpm 60, but only one energy byte.
        let data = Data([0x08, 0x3C, 0xF4])
        XCTAssertNil(BleHeartRateMeasurementParser.parse(data))
    }

    func testReturnsNilForOddTrailingRrByte() {
        // flags 0x10 (RR present), bpm 60, then 3 bytes (one and a half UInt16s).
        let data = Data([0x10, 0x3C, 0x00, 0x04, 0x00])
        XCTAssertNil(BleHeartRateMeasurementParser.parse(data))
    }

    func testReturnsNilForEmptyData() {
        XCTAssertNil(BleHeartRateMeasurementParser.parse(Data()))
    }

    func testReturnsNilWhenTooShortForHeartRateValue() {
        // Only the flags byte, no heart-rate value.
        XCTAssertNil(BleHeartRateMeasurementParser.parse(Data([0x00])))
    }

    func testParsesDataSliceThatIsNotZeroBased() {
        // A Data slice may have a non-zero startIndex; parsing must still work.
        let full = Data([0xFF, 0xFF, 0x00, 0x3C])
        let slice = full.subdata(in: 2..<4)
        let measurement = BleHeartRateMeasurementParser.parse(slice)
        XCTAssertEqual(measurement, BleHeartRateMeasurement(heartRateBpm: 60, rrIntervalsMs: []))
    }
}
