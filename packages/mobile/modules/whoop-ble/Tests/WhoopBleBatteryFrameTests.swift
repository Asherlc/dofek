import XCTest
@testable import WhoopBLE

final class WhoopBleBatteryFrameTests: XCTestCase {
    func testCapturedMaverickFrameDecodesFractionalPercentageAndExplicitChargingOff() throws {
        let frame = try XCTUnwrap(WhoopBleFrameParser.parseFrame(capturedWhoopBatteryFrame()))
        XCTAssertEqual(WhoopBleFrameParser.extractBatteryStatus(from: frame),
                       WhoopBleBatteryStatus(percentage: 49.9, isCharging: false))
    }

    func testSyntheticFrameDecodesChargingFromBitZeroAndAcceptsPercentageBounds() throws {
        for decipercent: UInt16 in [0, 1_000] {
            var payload = try batteryPayload()
            payload[13] = UInt8(truncatingIfNeeded: decipercent)
            payload[14] = UInt8(decipercent >> 8)
            payload[22] = 0xA5
            let frame = try XCTUnwrap(WhoopBleFrameParser.parseFrame(syntheticBatteryFrame(payload: payload)))
            XCTAssertEqual(WhoopBleFrameParser.extractBatteryStatus(from: frame),
                           WhoopBleBatteryStatus(percentage: Double(decipercent) / 10, isCharging: true))
        }
        var payload = try batteryPayload()
        payload[22] = 0x04
        let frame = try XCTUnwrap(WhoopBleFrameParser.parseFrame(syntheticBatteryFrame(payload: payload)))
        XCTAssertEqual(WhoopBleFrameParser.extractBatteryStatus(from: frame)?.isCharging, false)
    }

    func testSyntheticChargingEventsCarryNoPercentage() throws {
        for (event, isCharging) in [(UInt8(7), true), (UInt8(8), false)] {
            let frame = try XCTUnwrap(WhoopBleFrameParser.parseFrame(syntheticChargingEvent(event)))
            XCTAssertEqual(WhoopBleFrameParser.extractBatteryStatus(from: frame),
                           WhoopBleBatteryStatus(percentage: nil, isCharging: isCharging))
        }
    }

    func testSyntheticChargingEventsRejectMissingOrMismatchedBodyLength() throws {
        for event: UInt8 in [7, 8] {
            var payload = Data(repeating: 0, count: 10)
            payload[0] = 0x30
            payload[2] = event
            let truncated = try XCTUnwrap(WhoopBleFrameParser.parseFrame(syntheticBatteryFrame(payload: payload)))
            XCTAssertNil(WhoopBleFrameParser.extractBatteryStatus(from: truncated))

            payload.append(contentsOf: [1, 0])
            let mismatched = try XCTUnwrap(WhoopBleFrameParser.parseFrame(syntheticBatteryFrame(payload: payload)))
            XCTAssertNil(WhoopBleFrameParser.extractBatteryStatus(from: mismatched))
        }
    }

    func testSyntheticValidCRCDoesNotMakeMalformedBodiesValid() throws {
        let capturedPayload = try batteryPayload()
        var truncated = Data(capturedPayload.prefix(22))
        truncated[10] = 10
        var shortLength = capturedPayload
        shortLength[10] -= 1
        var longLength = capturedPayload
        longLength[10] += 1
        var above100Percent = capturedPayload
        above100Percent[13] = 0xE9
        above100Percent[14] = 0x03
        var nonBatteryEvent = capturedPayload
        nonBatteryEvent[2] = 14
        var nonEvent = capturedPayload
        nonEvent[0] = 0x28
        for payload in [truncated, shortLength, longLength, above100Percent, nonBatteryEvent, nonEvent,
                        Data([0x30, 0x00, 7])] {
            let frame = try XCTUnwrap(WhoopBleFrameParser.parseFrame(syntheticBatteryFrame(payload: payload)))
            XCTAssertNil(WhoopBleFrameParser.extractBatteryStatus(from: frame))
        }
    }

    func testCorruptCapturedCRCIsRejectedAndValidFragmentsAreReassembled() throws {
        let captured = try capturedWhoopBatteryFrame()
        var corrupt = captured
        corrupt[corrupt.count - 1] ^= 1
        let parser = WhoopBleFrameParser()
        XCTAssertTrue(parser.feed(corrupt).isEmpty)
        XCTAssertTrue(parser.feed(Data(captured.prefix(23))).isEmpty)
        let frame = try XCTUnwrap(parser.feed(Data(captured.dropFirst(23))).first)
        XCTAssertEqual(WhoopBleFrameParser.extractBatteryStatus(from: frame)?.percentage, 49.9)
    }

    private func batteryPayload() throws -> Data {
        Data(try capturedWhoopBatteryFrame().dropFirst(8).dropLast(4))
    }
}
