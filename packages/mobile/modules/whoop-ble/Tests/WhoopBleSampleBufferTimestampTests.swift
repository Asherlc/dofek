import XCTest
@testable import WhoopBLE

final class WhoopBleSampleBufferTimestampTests: XCTestCase {
    private var buffer: WhoopBleSampleBuffer!

    override func setUp() {
        super.setUp()
        buffer = WhoopBleSampleBuffer()
    }

    private func capturedFrames() throws -> [WhoopFrame] {
        let capture = try XCTUnwrap(Bundle.module.url(
            forResource: "imu-activation-capture",
            withExtension: "tsv",
            subdirectory: "fixtures"
        ))
        let contents = try String(contentsOf: capture, encoding: .utf8)
        return contents.split(separator: "\n").compactMap { line in
            guard let hex = line.split(separator: "\t").last,
                  let bytes = Data(hexString: String(hex)) else { return nil }
            return WhoopBleFrameParser.parseFrame(bytes)
        }
    }

    func testCapturedPacketKeepsReportedHeartRateWithoutIntervals() throws {
        let sample = try XCTUnwrap(try capturedFrames().compactMap {
            WhoopBleFrameParser.extractRealtimeData(from: $0)
        }.first { $0.heartRate == 62 && $0.rrIntervalMs == 0 })
        buffer.appendRealtimeData([sample])

        let serialized = try XCTUnwrap(buffer.peekRealtimeData().first)
        XCTAssertEqual(serialized["heartRateBpm"] as? Int, 62)
        XCTAssertEqual(serialized["rrIntervalMs"] as? Int, 0)
    }

    func testCapturedHistoryAndLiveReadingStayInTheSameSecond() throws {
        let frames = try capturedFrames()
        let liveFrame = try XCTUnwrap(frames.first {
            $0.packetType == WhoopBleConstants.packetTypeRealtimeData
        })
        let historyFrame = try XCTUnwrap(frames.first {
            $0.packetType == WhoopBleConstants.packetTypeHistoricalData
                && $0.recordType == 18 && $0.dataTimestamp == liveFrame.dataTimestamp
        })
        let liveSample = try XCTUnwrap(WhoopBleFrameParser.extractRealtimeData(from: liveFrame))
        let historySample = try XCTUnwrap(WhoopBleFrameParser.extractRealtimeData(from: historyFrame))
        buffer.appendRealtimeData([liveSample, historySample])

        let serialized = buffer.peekRealtimeData()
        XCTAssertEqual(serialized[0]["timestamp"] as? String, "2026-03-29T15:28:29.000Z")
        XCTAssertEqual(serialized[1]["timestamp"] as? String, "2026-03-29T15:28:29.430Z")
    }

    func testImuTimestampKeepsFractionalClockAndSamplePosition() {
        buffer.appendImuSamples([WhoopImuSample(
            timestampSeconds: 1711000000,
            subSeconds: 16384,
            sampleIndex: 99,
            samplesInFrame: 100,
            accelerometerX: 0, accelerometerY: 0, accelerometerZ: 0,
            gyroscopeX: 0, gyroscopeY: 0, gyroscopeZ: 0
        )])

        XCTAssertEqual(
            buffer.peekImuSamples()[0]["timestamp"] as? String,
            "2024-03-21T05:46:41.490Z"
        )
    }

    func testErasureCutoffUsesTheFractionalClockForBothBuffers() {
        buffer.advanceErasureCutoff(to: Date(timeIntervalSince1970: 1711000000.75))
        buffer.appendRealtimeData([WhoopRealtimeDataSample(
            timestampSeconds: 1711000000,
            subSeconds: 16384,
            heartRate: 72,
            rrIntervalMs: 833,
            quaternionW: 0, quaternionX: 0, quaternionY: 0, quaternionZ: 0,
            opticalBytes: Data(count: 18)
        )])
        buffer.appendImuSamples([WhoopImuSample(
            timestampSeconds: 1711000000,
            subSeconds: 16384,
            sampleIndex: 0,
            samplesInFrame: 100,
            accelerometerX: 0, accelerometerY: 0, accelerometerZ: 0,
            gyroscopeX: 0, gyroscopeY: 0, gyroscopeZ: 0
        )])

        XCTAssertEqual(buffer.realtimeSampleCount, 0)
        XCTAssertEqual(buffer.imuSampleCount, 0)
    }

    func testRealtimeDrainClampsFutureTimestamp() {
        let sample = WhoopRealtimeDataSample(
            timestampSeconds: 4294967295,
            subSeconds: 0,
            heartRate: 72,
            rrIntervalMs: 800,
            quaternionW: 1.0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
            opticalBytes: Data(count: 18)
        )
        buffer.appendRealtimeData([sample])

        let drained = buffer.drainRealtimeData()
        XCTAssertEqual(drained.count, 1)
        let timestamp = try? XCTUnwrap(drained[0]["timestamp"] as? String)
        XCTAssertNotNil(timestamp)

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: timestamp!)
        XCTAssertNotNil(date)
        let fiveMinFromNow = Date().addingTimeInterval(300)
        XCTAssertGreaterThan(fiveMinFromNow.timeIntervalSince1970, date!.timeIntervalSince1970 - 1)
    }

    func testRealtimeDrainClampsPreEpochTimestamp() {
        let sample = WhoopRealtimeDataSample(
            timestampSeconds: 100000,
            subSeconds: 0,
            heartRate: 72,
            rrIntervalMs: 800,
            quaternionW: 1.0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
            opticalBytes: Data(count: 18)
        )
        buffer.appendRealtimeData([sample])

        let drained = buffer.drainRealtimeData()
        XCTAssertEqual(drained.count, 1)
        let timestamp = try? XCTUnwrap(drained[0]["timestamp"] as? String)
        XCTAssertNotNil(timestamp)

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: timestamp!)
        XCTAssertNotNil(date)
        XCTAssertGreaterThanOrEqual(date!, Date(timeIntervalSince1970: 946684800))
    }

    func testImuDrainClampsFutureTimestamp() {
        let sample = WhoopImuSample(
            timestampSeconds: 4294967295,
            subSeconds: 0,
            sampleIndex: 0,
            samplesInFrame: 1,
            accelerometerX: 0.1,
            accelerometerY: 0,
            accelerometerZ: 1.0,
            gyroscopeX: 0,
            gyroscopeY: 0,
            gyroscopeZ: 0
        )
        buffer.appendImuSamples([sample])

        let drained = buffer.drainImuSamples()
        XCTAssertEqual(drained.count, 1)
        let timestamp = try? XCTUnwrap(drained[0]["timestamp"] as? String)
        XCTAssertNotNil(timestamp)

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: timestamp!)
        XCTAssertNotNil(date)
        let fiveMinFromNow = Date().addingTimeInterval(300)
        XCTAssertGreaterThan(fiveMinFromNow.timeIntervalSince1970, date!.timeIntervalSince1970 - 1)
    }

    func testValidTimestampPassesThroughUnchanged() {
        let timestampSeconds: UInt32 = 1711000000
        let sub: UInt16 = 16384
        let sample = WhoopRealtimeDataSample(
            timestampSeconds: timestampSeconds,
            subSeconds: sub,
            heartRate: 72,
            rrIntervalMs: 800,
            quaternionW: 1.0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
            opticalBytes: Data(count: 18)
        )
        buffer.appendRealtimeData([sample])

        let drained = buffer.drainRealtimeData()
        XCTAssertEqual(drained.count, 1)
        let timestamp = try? XCTUnwrap(drained[0]["timestamp"] as? String)
        XCTAssertNotNil(timestamp)

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: timestamp!)
        XCTAssertNotNil(date)
        let expected = Date(
            timeIntervalSince1970: 1711000000.5
        )
        XCTAssertEqual(date, expected)
    }

    func testDrainRealtimeDataSerializesCorrectFields() {
        let sample = WhoopRealtimeDataSample(
            timestampSeconds: 1711000000,
            subSeconds: 0,
            heartRate: 72,
            rrIntervalMs: 833,
            quaternionW: 1.0,
            quaternionX: 0.0,
            quaternionY: 0.0,
            quaternionZ: 0.0,
            opticalBytes: Data(count: 18)
        )
        buffer.appendRealtimeData([sample])

        let drained = buffer.drainRealtimeData()
        XCTAssertEqual(drained.count, 1)
        let dict = drained[0]
        XCTAssertNotNil(dict["timestamp"] as? String)
        XCTAssertEqual(dict["heartRateBpm"] as? Int, 72)
        XCTAssertEqual(dict["rrIntervalMs"] as? Int, 833)
        XCTAssertEqual(dict["quaternionW"] as? Double, 1.0)
        XCTAssertNotNil(dict["opticalRawHex"] as? String)
    }
}
