import XCTest
@testable import WhoopBleLib

final class WhoopBleFrameParserTests: XCTestCase {

    // MARK: - Frame parsing

    func testParseFrameRejectsEmptyData() {
        XCTAssertNil(WhoopBleFrameParser.parseFrame(Data()))
    }

    func testParseFrameRejectsTooShortData() {
        let data = Data([0xAA, 0x01, 0x00, 0x00])
        XCTAssertNil(WhoopBleFrameParser.parseFrame(data))
    }

    func testParseFrameRejectsBadStartOfFrame() {
        // Wrong SOF byte
        let data = Data([0xBB, 0x01, 0x00, 0x00, 0x33, 0x00, 0x00, 0x00, 0x00])
        XCTAssertNil(WhoopBleFrameParser.parseFrame(data))
    }

    func testParseFrameExtractsPacketType() {
        // Format: [SOF:0xAA] [version:0x01] [payloadLen:u16 LE=1] [payload:0x33] [crc32 x4]
        var data = Data([0xAA, 0x01, 0x01, 0x00])  // header: SOF, version, len=1
        data.append(0x33)  // payload: packet type = REALTIME_IMU
        data.append(contentsOf: [0x00, 0x00, 0x00, 0x00])  // CRC32 placeholder
        let frame = WhoopBleFrameParser.parseFrame(data)
        XCTAssertNotNil(frame)
        XCTAssertEqual(frame?.packetType, 0x33)
    }

    func testParseFrameExtractsTimestampAndSubSeconds() {
        // Format: [SOF:0xAA] [version:0x01] [payloadLen:u16 LE] [payload...] [crc32]
        // Payload = 14 bytes
        let data = Data([
            0xAA,                           // [0]  SOF
            0x01,                           // [1]  version
            0x0E, 0x00,                     // [2-3] payload length = 14
            // Payload starts at [4]:
            0x33,                           // [4]  packet type = REALTIME_IMU
            0x05,                           // [5]  record type = 5
            0x00,                           // [6]  reserved
            0xE8, 0x03, 0x00, 0x00,         // [7-10] timestamp = 1000 (LE)
            0x00, 0x00, 0x00, 0x00,         // [11-14] reserved
            0xF4, 0x01,                     // [15-16] sub-seconds = 500 (LE)
            0x00,                           // [17] padding
            // CRC32 placeholder:
            0x00, 0x00, 0x00, 0x00,         // [18-21]
        ])

        let frame = WhoopBleFrameParser.parseFrame(data)
        XCTAssertNotNil(frame)
        XCTAssertEqual(frame?.packetType, 0x33)
        XCTAssertEqual(frame?.dataTimestamp, 1000)
        XCTAssertEqual(frame?.subSeconds, 500)
        XCTAssertEqual(frame?.recordType, 5)
    }

    // MARK: - IMU sample extraction

    func testExtractImuSamplesFromRealtimeIMU() {
        // Build a REALTIME_IMU frame with 2 interleaved samples
        var payload = Data(count: 28 + 2 * 12)  // header + 2 samples
        payload[0] = WhoopBleConstants.packetTypeRealtimeIMU  // 0x33
        payload[1] = 0  // record type

        // Timestamp at offset 3 (u32 LE) = 1000
        payload[3] = 0xE8; payload[4] = 0x03; payload[5] = 0x00; payload[6] = 0x00

        // Sub-seconds at offset 11 (u16 LE) = 100
        payload[11] = 0x64; payload[12] = 0x00

        // Sample count A at offset 24 (u16 LE) = 2
        payload[24] = 0x02; payload[25] = 0x00
        // Sample count B at offset 26 (u16 LE) = 2
        payload[26] = 0x02; payload[27] = 0x00

        // Sample 1 at offset 28: ax=100, ay=-200, az=300, bx=10, by=-20, bz=30
        writeInt16LE(&payload, offset: 28, value: 100)
        writeInt16LE(&payload, offset: 30, value: -200)
        writeInt16LE(&payload, offset: 32, value: 300)
        writeInt16LE(&payload, offset: 34, value: 10)
        writeInt16LE(&payload, offset: 36, value: -20)
        writeInt16LE(&payload, offset: 38, value: 30)

        // Sample 2 at offset 40: ax=400, ay=-500, az=600, bx=40, by=-50, bz=60
        writeInt16LE(&payload, offset: 40, value: 400)
        writeInt16LE(&payload, offset: 42, value: -500)
        writeInt16LE(&payload, offset: 44, value: 600)
        writeInt16LE(&payload, offset: 46, value: 40)
        writeInt16LE(&payload, offset: 48, value: -50)
        writeInt16LE(&payload, offset: 50, value: 60)

        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeRealtimeIMU,
            recordType: 0,
            dataTimestamp: 1000,
            subSeconds: 100,
            payload: payload
        )

        let samples = WhoopBleFrameParser.extractImuSamples(from: frame)

        XCTAssertEqual(samples.count, 2)

        XCTAssertEqual(samples[0].timestampSeconds, 1000)
        XCTAssertEqual(samples[0].subSeconds, 100)
        XCTAssertEqual(samples[0].accelerometerX, 100)
        XCTAssertEqual(samples[0].accelerometerY, -200)
        XCTAssertEqual(samples[0].accelerometerZ, 300)
        XCTAssertEqual(samples[0].gyroscopeX, 10)
        XCTAssertEqual(samples[0].gyroscopeY, -20)
        XCTAssertEqual(samples[0].gyroscopeZ, 30)

        XCTAssertEqual(samples[1].accelerometerX, 400)
        XCTAssertEqual(samples[1].accelerometerY, -500)
        XCTAssertEqual(samples[1].accelerometerZ, 600)
        XCTAssertEqual(samples[1].gyroscopeX, 40)
        XCTAssertEqual(samples[1].gyroscopeY, -50)
        XCTAssertEqual(samples[1].gyroscopeZ, 60)
    }

    func testExtractImuSamplesFromHistoricalIMU() {
        // Historical IMU (0x34) should work the same way
        var payload = Data(count: 28 + 12)  // 1 sample
        payload[0] = WhoopBleConstants.packetTypeHistoricalIMU
        payload[24] = 0x01; payload[25] = 0x00  // countA = 1
        payload[26] = 0x01; payload[27] = 0x00  // countB = 1
        writeInt16LE(&payload, offset: 28, value: 42)
        writeInt16LE(&payload, offset: 30, value: -42)
        writeInt16LE(&payload, offset: 32, value: 84)
        writeInt16LE(&payload, offset: 34, value: 7)
        writeInt16LE(&payload, offset: 36, value: -7)
        writeInt16LE(&payload, offset: 38, value: 14)

        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeHistoricalIMU,
            recordType: 0,
            dataTimestamp: 2000,
            subSeconds: 0,
            payload: payload
        )

        let samples = WhoopBleFrameParser.extractImuSamples(from: frame)
        XCTAssertEqual(samples.count, 1)
        XCTAssertEqual(samples[0].accelerometerX, 42)
        XCTAssertEqual(samples[0].accelerometerY, -42)
        XCTAssertEqual(samples[0].accelerometerZ, 84)
    }

    func testExtractImuSamplesReturnsEmptyForNonIMUPacket() {
        let frame = WhoopFrame(
            packetType: 0x28,  // REALTIME_DATA, not IMU
            recordType: 0,
            dataTimestamp: 0,
            subSeconds: 0,
            payload: Data(count: 116)
        )
        let samples = WhoopBleFrameParser.extractImuSamples(from: frame)
        XCTAssertTrue(samples.isEmpty)
    }

    func testExtractImuSamplesCapsAt200() {
        // countA = 300, but parser should cap at 200
        var payload = Data(count: 28 + 200 * 12)
        payload[0] = WhoopBleConstants.packetTypeRealtimeIMU
        // countA = 300 (LE)
        payload[24] = 0x2C; payload[25] = 0x01
        // countB = 300
        payload[26] = 0x2C; payload[27] = 0x01

        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeRealtimeIMU,
            recordType: 0,
            dataTimestamp: 0,
            subSeconds: 0,
            payload: payload
        )

        let samples = WhoopBleFrameParser.extractImuSamples(from: frame)
        XCTAssertEqual(samples.count, 200)
    }

    func testExtractImuSamplesHandlesTruncatedPayload() {
        // Say countA=5 but payload only has space for 2 samples
        var payload = Data(count: 28 + 2 * 12)
        payload[0] = WhoopBleConstants.packetTypeRealtimeIMU
        payload[24] = 0x05; payload[25] = 0x00  // countA = 5
        payload[26] = 0x05; payload[27] = 0x00  // countB = 5

        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeRealtimeIMU,
            recordType: 0,
            dataTimestamp: 0,
            subSeconds: 0,
            payload: payload
        )

        let samples = WhoopBleFrameParser.extractImuSamples(from: frame)
        XCTAssertEqual(samples.count, 2)  // truncated to what fits
    }

    // MARK: - Command frame building

    func testBuildCommandFrameForToggleImuMode() {
        let data = WhoopBleFrameParser.buildCommandData(command: WhoopBleConstants.commandToggleImuMode)

        // Format: [SOF:0xAA] [version:0x01] [payloadLen:u16 LE=2] [0x23] [0x6A]
        XCTAssertEqual(data.count, 6)
        XCTAssertEqual(data[0], 0xAA)  // SOF
        XCTAssertEqual(data[1], 0x01)  // version
        XCTAssertEqual(data[2], 0x02)  // payload length low
        XCTAssertEqual(data[3], 0x00)  // payload length high
        XCTAssertEqual(data[4], 0x23)  // COMMAND packet type
        XCTAssertEqual(data[5], 0x6A)  // TOGGLE_IMU_MODE
    }

    func testBuildCommandFrameForStopRawData() {
        let data = WhoopBleFrameParser.buildCommandData(command: WhoopBleConstants.commandStopRawData)

        XCTAssertEqual(data[5], 0x52)  // STOP_RAW_DATA
    }

    // MARK: - Frame parser (stateful accumulator)

    func testFrameParserAccumulatesFragmentedNotifications() {
        let parser = WhoopBleFrameParser()

        // Build a complete frame: [SOF] [version] [len=1] [payload:0x33] [crc32]
        var fullFrame = Data([0xAA, 0x01, 0x01, 0x00])  // header
        fullFrame.append(0x33)  // payload
        fullFrame.append(contentsOf: [0x00, 0x00, 0x00, 0x00])  // CRC32

        let firstHalf = fullFrame[0..<5]
        let secondHalf = fullFrame[5...]

        // First notification — incomplete frame
        let frames1 = parser.feed(Data(firstHalf))
        XCTAssertTrue(frames1.isEmpty)

        // Send a new SOF-bearing notification that triggers parsing of accumulated data
        // and starts a new frame
        var newFrame = Data([0xAA, 0x01, 0x01, 0x00, 0x28])
        newFrame.append(contentsOf: [0x00, 0x00, 0x00, 0x00])

        // The accumulated data won't form a valid frame (it was truncated),
        // but the new frame should parse
        let frames2 = parser.feed(newFrame)
        // The new frame should be parsed
        XCTAssertEqual(frames2.count, 1)
        XCTAssertEqual(frames2[0].packetType, 0x28)
    }

    func testFrameParserAccumulatesLargeIMUFrameAcrossNotifications() {
        // Regression test: a large IMU frame arrives in 20-byte BLE notifications.
        let parser = WhoopBleFrameParser()

        // Build a realistic IMU frame: header(4) + payload(52) + CRC(4) = 60 bytes
        let payloadLen = 52  // 28 header bytes + 2*12 sample bytes
        var fullFrame = Data([
            0xAA,                                                 // SOF
            0x01,                                                 // version
            UInt8(payloadLen & 0xFF), UInt8(payloadLen >> 8),     // payload length
        ])
        var payload = Data(count: payloadLen)
        payload[0] = WhoopBleConstants.packetTypeRealtimeIMU  // 0x33
        payload[1] = 0  // record type
        // Timestamp at payload offset 3
        payload[3] = 0xE8; payload[4] = 0x03; payload[5] = 0x00; payload[6] = 0x00  // 1000
        // Sub-seconds at payload offset 11
        payload[11] = 0x64; payload[12] = 0x00  // 100
        // Sample counts at payload offsets 24-27
        payload[24] = 0x02; payload[25] = 0x00  // countA = 2
        payload[26] = 0x02; payload[27] = 0x00  // countB = 2
        // Sample 1 at offset 28: accel XYZ = 100, -200, 300
        writeInt16LE(&payload, offset: 28, value: 100)
        writeInt16LE(&payload, offset: 30, value: -200)
        writeInt16LE(&payload, offset: 32, value: 300)
        writeInt16LE(&payload, offset: 34, value: 10)
        writeInt16LE(&payload, offset: 36, value: -20)
        writeInt16LE(&payload, offset: 38, value: 30)
        // Sample 2 at offset 40
        writeInt16LE(&payload, offset: 40, value: 400)
        writeInt16LE(&payload, offset: 42, value: -500)
        writeInt16LE(&payload, offset: 44, value: 600)
        writeInt16LE(&payload, offset: 46, value: 40)
        writeInt16LE(&payload, offset: 48, value: -50)
        writeInt16LE(&payload, offset: 50, value: 60)

        fullFrame.append(payload)
        fullFrame.append(contentsOf: [0x00, 0x00, 0x00, 0x00])  // CRC32

        // Split into 20-byte BLE notifications (typical MTU)
        let notificationSize = 20
        var allFrames: [WhoopFrame] = []
        for offset in stride(from: 0, to: fullFrame.count, by: notificationSize) {
            let end = min(offset + notificationSize, fullFrame.count)
            let notification = Data(fullFrame[offset..<end])
            allFrames.append(contentsOf: parser.feed(notification))
        }

        // Must get exactly 1 frame with 2 IMU samples
        XCTAssertEqual(allFrames.count, 1, "Expected 1 frame from fragmented notifications")

        let samples = WhoopBleFrameParser.extractImuSamples(from: allFrames[0])
        XCTAssertEqual(samples.count, 2, "Expected 2 IMU samples from the assembled frame")
        XCTAssertEqual(samples[0].accelerometerX, 100)
        XCTAssertEqual(samples[0].accelerometerY, -200)
        XCTAssertEqual(samples[1].accelerometerX, 400)
    }

    func testFrameParserResetClearsAccumulator() {
        let parser = WhoopBleFrameParser()

        // Feed partial data
        let partial = Data([0xAA, 0x01, 0x05, 0x00])
        _ = parser.feed(partial)

        // Reset
        parser.reset()

        // New frame should parse cleanly (no leftover bytes)
        var frame = Data([0xAA, 0x01, 0x01, 0x00, 0x33])
        frame.append(contentsOf: [0x00, 0x00, 0x00, 0x00])
        let frames = parser.feed(frame)
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].packetType, 0x33)
    }

    // MARK: - Helpers

    private func writeInt16LE(_ data: inout Data, offset: Int, value: Int16) {
        let unsigned = UInt16(bitPattern: value)
        data[offset] = UInt8(unsigned & 0xFF)
        data[offset + 1] = UInt8(unsigned >> 8)
    }
}
