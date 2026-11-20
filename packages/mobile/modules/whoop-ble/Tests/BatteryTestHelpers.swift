import XCTest
@testable import WhoopBLE

func capturedWhoopBatteryFrame() throws -> Data {
    let url = try XCTUnwrap(Bundle.module.url(
        forResource: "battery-events", withExtension: "tsv", subdirectory: "fixtures"))
    let contents = try String(contentsOf: url, encoding: .utf8)
    let line = try XCTUnwrap(contents.split(separator: "\n").first { $0.hasPrefix("whoop5\t") })
    return try XCTUnwrap(Data(hexString: String(line.dropFirst("whoop5\t".count))))
}

func syntheticChargingEvent(_ event: UInt8) -> Data {
    var payload = Data(repeating: 0, count: 12)
    payload[0] = 0x30
    payload[2] = event
    return syntheticBatteryFrame(payload: payload)
}

func syntheticBatteryFrame(payload: Data) -> Data {
    let length = UInt16(payload.count + 4)
    var frame = Data([0xAA, 1, UInt8(truncatingIfNeeded: length), UInt8(length >> 8), 1, 0])
    var headerCRC = WhoopBleFrameParser.crc16modbus(frame).littleEndian
    withUnsafeBytes(of: &headerCRC) { frame.append(contentsOf: $0) }
    frame.append(payload)
    var payloadCRC = WhoopBleFrameParser.crc32ieee(payload).littleEndian
    withUnsafeBytes(of: &payloadCRC) { frame.append(contentsOf: $0) }
    return frame
}
