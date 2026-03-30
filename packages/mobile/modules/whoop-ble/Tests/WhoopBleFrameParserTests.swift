import XCTest
@testable import WhoopBleLib

final class WhoopBleFrameParserTests: XCTestCase {

    // MARK: - Helpers

    /// Build a Maverick frame: 8-byte header + payload + optional CRC32 placeholder
    private func buildMaverickFrame(payload: Data) -> Data {
        let payloadLen = UInt16(payload.count)
        var frame = Data([
            0xAA,                                             // SOF
            0x01,                                             // version
            UInt8(payloadLen & 0xFF), UInt8(payloadLen >> 8),// payloadLen u16 LE
            0x00, 0x01,                                       // role1, role2
            0x00, 0x00,                                       // CRC16 placeholder
        ])
        frame.append(payload)
        return frame
    }

    private func writeInt16LE(_ data: inout Data, offset: Int, value: Int16) {
        let unsigned = UInt16(bitPattern: value)
        data[offset] = UInt8(unsigned & 0xFF)
        data[offset + 1] = UInt8(unsigned >> 8)
    }

    // MARK: - Frame parsing

    func testParseFrameRejectsEmptyData() {
        XCTAssertNil(WhoopBleFrameParser.parseFrame(Data()))
    }

    func testParseFrameRejectsTooShortData() {
        let data = Data([0xAA, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00])
        XCTAssertNil(WhoopBleFrameParser.parseFrame(data))
    }

    func testParseFrameRejectsBadStartOfFrame() {
        var data = Data([0xBB, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00])
        data.append(0x33)
        XCTAssertNil(WhoopBleFrameParser.parseFrame(data))
    }

    func testParseFrameExtractsPacketType() {
        let frame = buildMaverickFrame(payload: Data([0x33]))
        let parsed = WhoopBleFrameParser.parseFrame(frame)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.packetType, 0x33)
    }

    func testParseFrameExtractsTimestampAndSubSeconds() {
        // Payload: [type][record][pad][pad][pad][pad][pad][ts:4][sub:2][pad]
        var payload = Data(count: 14)
        payload[0] = 0x33  // type
        payload[1] = 0x05  // record type
        // Timestamp at payload offset 7 (u32 LE) = 1000
        payload[7] = 0xE8; payload[8] = 0x03; payload[9] = 0x00; payload[10] = 0x00
        // Sub-seconds at payload offset 11 (u16 LE) = 500
        payload[11] = 0xF4; payload[12] = 0x01

        let frame = buildMaverickFrame(payload: payload)
        let parsed = WhoopBleFrameParser.parseFrame(frame)

        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.packetType, 0x33)
        XCTAssertEqual(parsed?.dataTimestamp, 1000)
        XCTAssertEqual(parsed?.subSeconds, 500)
        XCTAssertEqual(parsed?.recordType, 5)
    }

    // MARK: - IMU sample extraction

    func testExtractImuSamplesFromRealtimeIMU() {
        var payload = Data(count: 28 + 2 * 12)
        payload[0] = WhoopBleConstants.packetTypeRealtimeIMU
        payload[1] = 0
        payload[7] = 0xE8; payload[8] = 0x03; payload[9] = 0x00; payload[10] = 0x00
        payload[11] = 0x64; payload[12] = 0x00
        payload[24] = 0x02; payload[25] = 0x00
        payload[26] = 0x02; payload[27] = 0x00
        writeInt16LE(&payload, offset: 28, value: 100)
        writeInt16LE(&payload, offset: 30, value: -200)
        writeInt16LE(&payload, offset: 32, value: 300)
        writeInt16LE(&payload, offset: 34, value: 10)
        writeInt16LE(&payload, offset: 36, value: -20)
        writeInt16LE(&payload, offset: 38, value: 30)
        writeInt16LE(&payload, offset: 40, value: 400)
        writeInt16LE(&payload, offset: 42, value: -500)
        writeInt16LE(&payload, offset: 44, value: 600)
        writeInt16LE(&payload, offset: 46, value: 40)
        writeInt16LE(&payload, offset: 48, value: -50)
        writeInt16LE(&payload, offset: 50, value: 60)

        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeRealtimeIMU,
            recordType: 0, dataTimestamp: 1000, subSeconds: 100, payload: payload
        )
        let samples = WhoopBleFrameParser.extractImuSamples(from: frame)

        XCTAssertEqual(samples.count, 2)
        XCTAssertEqual(samples[0].accelerometerX, 100)
        XCTAssertEqual(samples[0].accelerometerY, -200)
        XCTAssertEqual(samples[0].accelerometerZ, 300)
        XCTAssertEqual(samples[0].gyroscopeX, 10)
        XCTAssertEqual(samples[1].accelerometerX, 400)
        XCTAssertEqual(samples[1].gyroscopeZ, 60)
    }

    func testExtractImuSamplesFromHistoricalIMU() {
        var payload = Data(count: 28 + 12)
        payload[0] = WhoopBleConstants.packetTypeHistoricalIMU
        payload[24] = 0x01; payload[25] = 0x00
        payload[26] = 0x01; payload[27] = 0x00
        writeInt16LE(&payload, offset: 28, value: 42)
        writeInt16LE(&payload, offset: 30, value: -42)
        writeInt16LE(&payload, offset: 32, value: 84)
        writeInt16LE(&payload, offset: 34, value: 7)
        writeInt16LE(&payload, offset: 36, value: -7)
        writeInt16LE(&payload, offset: 38, value: 14)

        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeHistoricalIMU,
            recordType: 0, dataTimestamp: 2000, subSeconds: 0, payload: payload
        )
        let samples = WhoopBleFrameParser.extractImuSamples(from: frame)
        XCTAssertEqual(samples.count, 1)
        XCTAssertEqual(samples[0].accelerometerX, 42)
    }

    func testExtractImuSamplesReturnsEmptyForNonIMUPacket() {
        let frame = WhoopFrame(
            packetType: 0x28, recordType: 0, dataTimestamp: 0, subSeconds: 0,
            payload: Data(count: 116)
        )
        XCTAssertTrue(WhoopBleFrameParser.extractImuSamples(from: frame).isEmpty)
    }

    func testExtractImuSamplesCapsAt200() {
        var payload = Data(count: 28 + 200 * 12)
        payload[0] = WhoopBleConstants.packetTypeRealtimeIMU
        payload[24] = 0x2C; payload[25] = 0x01  // 300
        payload[26] = 0x2C; payload[27] = 0x01

        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeRealtimeIMU,
            recordType: 0, dataTimestamp: 0, subSeconds: 0, payload: payload
        )
        XCTAssertEqual(WhoopBleFrameParser.extractImuSamples(from: frame).count, 200)
    }

    func testExtractImuSamplesHandlesTruncatedPayload() {
        var payload = Data(count: 28 + 2 * 12)
        payload[0] = WhoopBleConstants.packetTypeRealtimeIMU
        payload[24] = 0x05; payload[25] = 0x00
        payload[26] = 0x05; payload[27] = 0x00

        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeRealtimeIMU,
            recordType: 0, dataTimestamp: 0, subSeconds: 0, payload: payload
        )
        XCTAssertEqual(WhoopBleFrameParser.extractImuSamples(from: frame).count, 2)
    }

    // MARK: - Command frame building

    func testBuildCommandFrameForToggleImuMode() {
        let data = WhoopBleFrameParser.buildCommandData(command: WhoopBleConstants.commandToggleImuMode)
        // 8-byte header + 8 command bytes + 4 CRC32 = 20 bytes
        XCTAssertEqual(data.count, 20)
        XCTAssertEqual(data[0], 0xAA)           // SOF
        XCTAssertEqual(data[1], 0x01)           // version
        XCTAssertEqual(data[2], 0x0C)           // payloadLen = 12
        XCTAssertEqual(data[3], 0x00)
        XCTAssertEqual(data[4], 0x00)           // role1
        XCTAssertEqual(data[5], 0x01)           // role2
        // Header CRC16 at bytes 6-7
        XCTAssertEqual(data[8], 0x23)           // COMMAND type
        XCTAssertEqual(data[10], 0x6A)          // TOGGLE_IMU_MODE
        // Parameters
        XCTAssertEqual(data[11], 0x01)
        XCTAssertEqual(data[12], 0x01)
    }

    func testBuildCommandFrameSequenceIncrements() {
        let data1 = WhoopBleFrameParser.buildCommandData(command: WhoopBleConstants.commandToggleImuMode)
        let data2 = WhoopBleFrameParser.buildCommandData(command: WhoopBleConstants.commandToggleImuMode)
        XCTAssertEqual(data2[9], data1[9] &+ 1)
    }

    func testBuildCommandFrameHeaderCRC16MatchesCapture() {
        // Verified from PacketLogger: header CRC16 of aa010c000001 = 0x41E7
        let crc = WhoopBleFrameParser.crc16modbus(Data([0xAA, 0x01, 0x0C, 0x00, 0x00, 0x01]))
        XCTAssertEqual(crc, 0x41E7)
    }

    func testBuildCommandFramePayloadCRC32MatchesCapture() {
        // Verified from PacketLogger capture:
        // Payload bytes: 23 f1 6a 01 01 00 00 00 → CRC32 = 0xFC61E958
        let payload = Data([0x23, 0xF1, 0x6A, 0x01, 0x01, 0x00, 0x00, 0x00])
        let crc = WhoopBleFrameParser.crc32ieee(payload)
        XCTAssertEqual(crc, 0xFC61E958)
    }

    // MARK: - Frame parser (stateful accumulator)

    func testFrameParserAccumulatesFragmentedNotifications() {
        let parser = WhoopBleFrameParser()

        // Build a Maverick frame: header(8) + payload(1) = 9 bytes
        let frame = buildMaverickFrame(payload: Data([0x33]))
        let firstHalf = Data(frame[0..<5])

        // First notification — incomplete
        XCTAssertTrue(parser.feed(firstHalf).isEmpty)

        // New SOF-bearing notification with a complete frame
        let newFrame = buildMaverickFrame(payload: Data([0x28]))
        let frames = parser.feed(newFrame)
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].packetType, 0x28)
    }

    func testFrameParserAccumulatesLargeIMUFrameAcrossNotifications() {
        let parser = WhoopBleFrameParser()

        // Build a Maverick frame with 2 IMU samples
        let payloadLen = 52
        var payload = Data(count: payloadLen)
        payload[0] = WhoopBleConstants.packetTypeRealtimeIMU
        payload[1] = 0
        payload[7] = 0xE8; payload[8] = 0x03; payload[9] = 0x00; payload[10] = 0x00
        payload[11] = 0x64; payload[12] = 0x00
        payload[24] = 0x02; payload[25] = 0x00
        payload[26] = 0x02; payload[27] = 0x00
        writeInt16LE(&payload, offset: 28, value: 100)
        writeInt16LE(&payload, offset: 30, value: -200)
        writeInt16LE(&payload, offset: 32, value: 300)
        writeInt16LE(&payload, offset: 34, value: 10)
        writeInt16LE(&payload, offset: 36, value: -20)
        writeInt16LE(&payload, offset: 38, value: 30)
        writeInt16LE(&payload, offset: 40, value: 400)
        writeInt16LE(&payload, offset: 42, value: -500)
        writeInt16LE(&payload, offset: 44, value: 600)
        writeInt16LE(&payload, offset: 46, value: 40)
        writeInt16LE(&payload, offset: 48, value: -50)
        writeInt16LE(&payload, offset: 50, value: 60)

        let fullFrame = buildMaverickFrame(payload: payload)

        // Split into 20-byte BLE notifications
        var allFrames: [WhoopFrame] = []
        for offset in stride(from: 0, to: fullFrame.count, by: 20) {
            let end = min(offset + 20, fullFrame.count)
            allFrames.append(contentsOf: parser.feed(Data(fullFrame[offset..<end])))
        }

        XCTAssertEqual(allFrames.count, 1)
        let samples = WhoopBleFrameParser.extractImuSamples(from: allFrames[0])
        XCTAssertEqual(samples.count, 2)
        XCTAssertEqual(samples[0].accelerometerX, 100)
        XCTAssertEqual(samples[1].accelerometerX, 400)
    }

    func testFrameParserResetClearsAccumulator() {
        let parser = WhoopBleFrameParser()
        _ = parser.feed(Data([0xAA, 0x01, 0x05, 0x00, 0x00, 0x01, 0x00, 0x00]))
        parser.reset()

        let frame = buildMaverickFrame(payload: Data([0x33]))
        let frames = parser.feed(frame)
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].packetType, 0x33)
    }
}
