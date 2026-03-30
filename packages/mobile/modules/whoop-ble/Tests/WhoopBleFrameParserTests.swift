import XCTest
@testable import WhoopBleLib

extension Data {
    init?(hexString: String) {
        let len = hexString.count / 2
        var data = Data(capacity: len)
        var index = hexString.startIndex
        for _ in 0..<len {
            let nextIndex = hexString.index(index, offsetBy: 2)
            guard let byte = UInt8(hexString[index..<nextIndex], radix: 16) else { return nil }
            data.append(byte)
            index = nextIndex
        }
        self = data
    }
}

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

        // Values are normalized: accel in g (raw / 4096), gyro in rad/s (raw / 16.4 * π/180)
        let accelScale: Float = 1.0 / 4096.0
        let gyroScale: Float = (1.0 / 16.4) * (.pi / 180.0)

        XCTAssertEqual(samples.count, 2)
        XCTAssertEqual(samples[0].accelerometerX, 100 * accelScale, accuracy: 0.0001)
        XCTAssertEqual(samples[0].accelerometerY, -200 * accelScale, accuracy: 0.0001)
        XCTAssertEqual(samples[0].accelerometerZ, 300 * accelScale, accuracy: 0.0001)
        XCTAssertEqual(samples[0].gyroscopeX, 10 * gyroScale, accuracy: 0.0001)
        XCTAssertEqual(samples[1].accelerometerX, 400 * accelScale, accuracy: 0.0001)
        XCTAssertEqual(samples[1].gyroscopeZ, 60 * gyroScale, accuracy: 0.0001)
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
        XCTAssertEqual(samples[0].accelerometerX, 42.0 / 4096.0, accuracy: 0.0001)
    }

    func testExtractImuSamplesNormalizesGravityToOneG() {
        // Raw value of 4096 on Z axis = 1g (device at rest, Z pointing up)
        var payload = Data(count: 28 + 12)
        payload[0] = WhoopBleConstants.packetTypeRealtimeIMU
        payload[24] = 0x01; payload[25] = 0x00 // 1 sample
        payload[26] = 0x01; payload[27] = 0x00
        writeInt16LE(&payload, offset: 28, value: 0)    // ax = 0
        writeInt16LE(&payload, offset: 30, value: 0)    // ay = 0
        writeInt16LE(&payload, offset: 32, value: 4096) // az = 1g
        writeInt16LE(&payload, offset: 34, value: 0)    // gx = 0
        writeInt16LE(&payload, offset: 36, value: 0)    // gy = 0
        writeInt16LE(&payload, offset: 38, value: 0)    // gz = 0

        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeRealtimeIMU,
            recordType: 0, dataTimestamp: 0, subSeconds: 0, payload: payload
        )
        let samples = WhoopBleFrameParser.extractImuSamples(from: frame)
        XCTAssertEqual(samples.count, 1)
        XCTAssertEqual(samples[0].accelerometerX, 0.0, accuracy: 0.001)
        XCTAssertEqual(samples[0].accelerometerY, 0.0, accuracy: 0.001)
        XCTAssertEqual(samples[0].accelerometerZ, 1.0, accuracy: 0.001) // 1g
        XCTAssertEqual(samples[0].gyroscopeX, 0.0, accuracy: 0.001)
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
        XCTAssertEqual(samples[0].accelerometerX, 100.0 / 4096.0, accuracy: 0.0001)
        XCTAssertEqual(samples[1].accelerometerX, 400.0 / 4096.0, accuracy: 0.0001)
    }

    // MARK: - Realtime data extraction (0x28 packets)

    /// Build a realistic 0x28 REALTIME_DATA payload with HR and quaternion.
    /// Minimum 57 bytes, typically 116 bytes from the strap.
    private func buildRealtimeDataPayload(heartRate: UInt8, qW: Float, qX: Float, qY: Float, qZ: Float) -> Data {
        var payload = Data(count: 116) // typical real-world size
        payload[0] = WhoopBleConstants.packetTypeRealtimeData // 0x28

        // Record type and timestamp fields (payload offsets 1-12)
        payload[1] = 0x00 // record type
        // Timestamp at offset 7 (u32 LE) = 1711814400 (2024-03-30T16:00:00Z)
        let timestamp: UInt32 = 1711814400
        payload[7] = UInt8(timestamp & 0xFF)
        payload[8] = UInt8((timestamp >> 8) & 0xFF)
        payload[9] = UInt8((timestamp >> 16) & 0xFF)
        payload[10] = UInt8((timestamp >> 24) & 0xFF)
        // Sub-seconds at offset 11 = 500
        payload[11] = 0xF4; payload[12] = 0x01

        // HR at offset 22
        payload[WhoopBleConstants.realtimeDataHeartRateOffset] = heartRate

        // Quaternion W at offset 41 (float32 LE)
        writeFloat32LE(&payload, offset: WhoopBleConstants.realtimeDataQuaternionWOffset, value: qW)
        // Quaternion X at offset 45
        writeFloat32LE(&payload, offset: WhoopBleConstants.realtimeDataQuaternionXOffset, value: qX)
        // Quaternion Y at offset 49
        writeFloat32LE(&payload, offset: WhoopBleConstants.realtimeDataQuaternionYOffset, value: qY)
        // Quaternion Z at offset 53
        writeFloat32LE(&payload, offset: WhoopBleConstants.realtimeDataQuaternionZOffset, value: qZ)

        return payload
    }

    private func writeFloat32LE(_ data: inout Data, offset: Int, value: Float) {
        let bits = value.bitPattern
        data[offset] = UInt8(bits & 0xFF)
        data[offset + 1] = UInt8((bits >> 8) & 0xFF)
        data[offset + 2] = UInt8((bits >> 16) & 0xFF)
        data[offset + 3] = UInt8((bits >> 24) & 0xFF)
    }

    func testExtractRealtimeDataReturnsNilForNonRealtimePacket() {
        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeRealtimeIMU, // 0x33, not 0x28
            recordType: 0, dataTimestamp: 1000, subSeconds: 0,
            payload: Data(count: 116)
        )
        XCTAssertNil(WhoopBleFrameParser.extractRealtimeData(from: frame))
    }

    func testExtractRealtimeDataReturnsNilForTooShortPayload() {
        // Payload of 56 bytes — one byte short of the minimum (57)
        let shortPayload = Data(count: 56)
        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeRealtimeData,
            recordType: 0, dataTimestamp: 1000, subSeconds: 0,
            payload: shortPayload
        )
        XCTAssertNil(WhoopBleFrameParser.extractRealtimeData(from: frame))
    }

    func testExtractRealtimeDataExtractsHeartRate() {
        let payload = buildRealtimeDataPayload(heartRate: 72, qW: 0.0, qX: 0.0, qY: 0.0, qZ: 0.0)
        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeRealtimeData,
            recordType: 0, dataTimestamp: 1711814400, subSeconds: 500,
            payload: payload
        )

        let sample = WhoopBleFrameParser.extractRealtimeData(from: frame)
        XCTAssertNotNil(sample)
        XCTAssertEqual(sample?.heartRate, 72)
        XCTAssertEqual(sample?.timestampSeconds, 1711814400)
        XCTAssertEqual(sample?.subSeconds, 500)
    }

    func testExtractRealtimeDataExtractsQuaternion() {
        // Realistic quaternion from resting capture
        let payload = buildRealtimeDataPayload(heartRate: 66, qW: 0.02, qX: 0.68, qY: -0.71, qZ: 0.20)
        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeRealtimeData,
            recordType: 0, dataTimestamp: 1000, subSeconds: 0,
            payload: payload
        )

        let sample = WhoopBleFrameParser.extractRealtimeData(from: frame)
        XCTAssertNotNil(sample)
        XCTAssertEqual(sample!.quaternionW, 0.02, accuracy: 0.001)
        XCTAssertEqual(sample!.quaternionX, 0.68, accuracy: 0.001)
        XCTAssertEqual(sample!.quaternionY, -0.71, accuracy: 0.001)
        XCTAssertEqual(sample!.quaternionZ, 0.20, accuracy: 0.001)
    }

    func testExtractRealtimeDataExtractsAllFields() {
        let payload = buildRealtimeDataPayload(heartRate: 80, qW: 1.0, qX: 0.0, qY: 0.0, qZ: 0.0)
        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeRealtimeData,
            recordType: 0, dataTimestamp: 1000, subSeconds: 0,
            payload: payload
        )

        let sample = WhoopBleFrameParser.extractRealtimeData(from: frame)
        XCTAssertNotNil(sample)
        XCTAssertEqual(sample?.heartRate, 80)
        XCTAssertEqual(sample!.quaternionW, 1.0, accuracy: 0.001)
        XCTAssertEqual(sample!.quaternionX, 0.0, accuracy: 0.001)
    }

    func testExtractRealtimeDataWorksWithMinimumPayloadSize() {
        // Exactly 57 bytes — minimum to contain quaternion Z
        var payload = Data(count: WhoopBleConstants.realtimeDataMinPayloadSize)
        payload[0] = WhoopBleConstants.packetTypeRealtimeData
        payload[WhoopBleConstants.realtimeDataHeartRateOffset] = 90

        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeRealtimeData,
            recordType: 0, dataTimestamp: 2000, subSeconds: 100,
            payload: payload
        )

        let sample = WhoopBleFrameParser.extractRealtimeData(from: frame)
        XCTAssertNotNil(sample)
        XCTAssertEqual(sample?.heartRate, 90)
    }

    // MARK: - Optical/PPG byte extraction from 0x28 packets

    func testExtractRealtimeDataIncludesOpticalBytes() {
        var payload = buildRealtimeDataPayload(heartRate: 72, qW: 1.0, qX: 0.0, qY: 0.0, qZ: 0.0)

        // Write known pattern into optical bytes (offsets 23-40)
        let opticalStart = WhoopBleConstants.realtimeDataOpticalStartOffset
        for i in 0..<WhoopBleConstants.realtimeDataOpticalByteCount {
            payload[opticalStart + i] = UInt8(0xA0 + i)
        }

        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeRealtimeData,
            recordType: 0, dataTimestamp: 1000, subSeconds: 0,
            payload: payload
        )

        let sample = WhoopBleFrameParser.extractRealtimeData(from: frame)
        XCTAssertNotNil(sample)
        XCTAssertEqual(sample!.opticalBytes.count, WhoopBleConstants.realtimeDataOpticalByteCount)
        XCTAssertEqual(sample!.opticalBytes[0], 0xA0)
        XCTAssertEqual(sample!.opticalBytes[17], 0xB1)
    }

    func testExtractRealtimeDataFromCompactPacket() {
        // Real 0x28 compact packet from PacketLogger capture (24-byte payload)
        // HR=60 bpm, PPG value=0x03b0=944
        let frameHex = "aa011800010022e128021d45c9690a373c01b00300000000000001000655e2c5"
        let frameData = Data(hexString: frameHex)!
        let frame = WhoopBleFrameParser.parseFrame(frameData)
        XCTAssertNotNil(frame)
        XCTAssertEqual(frame?.packetType, 0x28)

        let sample = WhoopBleFrameParser.extractRealtimeData(from: frame!)
        XCTAssertNotNil(sample)
        XCTAssertEqual(sample?.heartRate, 60) // byte 8 of payload = 0x3c = 60
    }

    func testExtractRealtimeDataFromCompactPacketWithDifferentHR() {
        // Second packet from capture: HR=61 bpm (byte 8 = 0x3d)
        let frameHex = "aa011800010022e128021f45c9690a373d01ae030000000000000100b1c3f462"
        let frameData = Data(hexString: frameHex)!
        let frame = WhoopBleFrameParser.parseFrame(frameData)!
        let sample = WhoopBleFrameParser.extractRealtimeData(from: frame)
        XCTAssertNotNil(sample)
        XCTAssertEqual(sample?.heartRate, 61)
    }

    func testExtractRealtimeDataFromCompactPacketZeroHR() {
        // Packet 6 from capture: HR=62, flag=0x00 (no valid reading for PPG)
        let frameHex = "aa011800010022e128022245c9690a373e0000000000000000000100e5e3b6da"
        let frameData = Data(hexString: frameHex)!
        let frame = WhoopBleFrameParser.parseFrame(frameData)!
        let sample = WhoopBleFrameParser.extractRealtimeData(from: frame)
        XCTAssertNotNil(sample)
        XCTAssertEqual(sample?.heartRate, 62) // byte 8 = 0x3e = 62
    }

    func testExtractRealtimeDataOpticalBytesAllZeroWhenEmpty() {
        // Default payload has zeros in the optical region
        let payload = buildRealtimeDataPayload(heartRate: 65, qW: 1.0, qX: 0.0, qY: 0.0, qZ: 0.0)
        let frame = WhoopFrame(
            packetType: WhoopBleConstants.packetTypeRealtimeData,
            recordType: 0, dataTimestamp: 1000, subSeconds: 0,
            payload: payload
        )

        let sample = WhoopBleFrameParser.extractRealtimeData(from: frame)
        XCTAssertNotNil(sample)
        XCTAssertEqual(sample!.opticalBytes.count, WhoopBleConstants.realtimeDataOpticalByteCount)
        XCTAssertTrue(sample!.opticalBytes.allSatisfy { $0 == 0 })
    }

    func testExtractRealtimeDataFromFullFrame() {
        // Build a full Maverick frame around a 0x28 payload
        let payload = buildRealtimeDataPayload(heartRate: 75, qW: 0.5, qX: 0.5, qY: 0.5, qZ: 0.5)
        let frame = buildMaverickFrame(payload: payload)
        let parsed = WhoopBleFrameParser.parseFrame(frame)

        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.packetType, WhoopBleConstants.packetTypeRealtimeData)

        let sample = WhoopBleFrameParser.extractRealtimeData(from: parsed!)
        XCTAssertNotNil(sample)
        XCTAssertEqual(sample?.heartRate, 75)
        XCTAssertEqual(sample!.quaternionW, 0.5, accuracy: 0.001)
    }

    // MARK: - readFloat32LE

    func testReadFloat32LEReadsCorrectValue() {
        var data = Data(count: 4)
        let value: Float = 3.14
        let bits = value.bitPattern
        data[0] = UInt8(bits & 0xFF)
        data[1] = UInt8((bits >> 8) & 0xFF)
        data[2] = UInt8((bits >> 16) & 0xFF)
        data[3] = UInt8((bits >> 24) & 0xFF)

        XCTAssertEqual(data.readFloat32LE(at: 0), value, accuracy: 0.001)
    }

    func testReadFloat32LEReturnsZeroForOutOfBounds() {
        let data = Data(count: 2) // too short for float32
        XCTAssertEqual(data.readFloat32LE(at: 0), 0.0)
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
