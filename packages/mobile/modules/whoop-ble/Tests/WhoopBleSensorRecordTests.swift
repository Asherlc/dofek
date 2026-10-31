import XCTest
@testable import WhoopBLE

final class WhoopBleSensorRecordTests: XCTestCase {
    func testAdditionalSensorFramesRequireBothPacketTypeAndLayoutBytes() throws {
        for packetType: UInt8 in [43, 47] {
            for payload in [Data([packetType]), Data([packetType, 18])] {
                var bytes = Data([0xAA, 1, UInt8(payload.count + 4), 0, 0, 1])
                let headerCrc = WhoopBleFrameParser.crc16modbus(bytes)
                bytes.append(contentsOf: [UInt8(truncatingIfNeeded: headerCrc), UInt8(headerCrc >> 8)])
                bytes.append(payload)
                let payloadCrc = WhoopBleFrameParser.crc32ieee(payload)
                for index in 0..<4 { bytes.append(UInt8(truncatingIfNeeded: payloadCrc >> (index * 8))) }
                let frame = try XCTUnwrap(WhoopBleFrameParser.parseFrame(bytes))
                let record = WhoopBleSensorRecord.serialize(frame: frame, deviceInfo: [:])
                if bytes.count == 13 {
                    XCTAssertNil(record, "A CRC-valid frame without a layout must not poison an upload batch")
                } else {
                    XCTAssertEqual(bytes.count, 14)
                    XCTAssertNotNil(record, "The minimum server-accepted sensor frame must be retained")
                }
            }
        }
    }

    func testFullRealtimeFramesRetainTheirOtherwiseDiscardedOpticalRegion() throws {
        // A constructed transport-route variant, not a new optical field map.
        var bytes = try capturedWhoopR18Data()
        bytes[8] = 40
        let crc = WhoopBleFrameParser.crc32ieee(Data(bytes[8..<(bytes.count - 4)]))
        for index in 0..<4 { bytes[bytes.count - 4 + index] = UInt8(truncatingIfNeeded: crc >> (index * 8)) }
        let frame = try XCTUnwrap(WhoopBleFrameParser.parseFrame(bytes))
        let record = try XCTUnwrap(WhoopBleSensorRecord.serialize(frame: frame, deviceInfo: [:]))
        XCTAssertEqual(record["frameHex"] as? String, bytes.map { String(format: "%02x", $0) }.joined())
    }
    func testFragmentedCaptureRetainsExactFrameAndIndependentReceptionTime() throws {
        let original = try capturedWhoopR18Data()
        let parser = WhoopBleFrameParser()
        XCTAssertTrue(parser.feed(Data(original.prefix(30))).isEmpty)
        let frame = try XCTUnwrap(parser.feed(Data(original.dropFirst(30))).first)
        XCTAssertEqual(frame.rawData, original)
        let record = try XCTUnwrap(WhoopBleSensorRecord.serialize(
            frame: frame, deviceInfo: ["name": "WHOOP", "firmware": "50.42.1.0"],
            receivedAt: Date(timeIntervalSince1970: 1_800_000_000)
        ))
        XCTAssertEqual(record["timestamp"] as? String, "2027-01-15T08:00:00.000Z")
        XCTAssertEqual(record["frameHex"] as? String, original.map { String(format: "%02x", $0) }.joined())
        XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(record["captureId"] as? String)))
        XCTAssertEqual((record["deviceInfo"] as? [String: String])?["firmware"], "50.42.1.0")
    }

    func testDeviceInformationReadsKeepReportedValuesAndIgnoreOtherCharacteristics() {
        let manager = WhoopBleConnectionManager()
        XCTAssertTrue(manager.recordDeviceInformation(uuid: "2A26", data: Data("50.42.1.0".utf8)))
        XCTAssertTrue(manager.recordDeviceInformation(uuid: "2A24", data: Data("WHOOP MG".utf8)))
        XCTAssertFalse(manager.recordDeviceInformation(uuid: "FFFF", data: Data("unused".utf8)))
        XCTAssertEqual(manager.deviceInfo, ["firmware": "50.42.1.0", "model": "WHOOP MG"])
        manager.resetConnectionReferences()
        XCTAssertTrue(manager.deviceInfo.isEmpty)
    }
}
