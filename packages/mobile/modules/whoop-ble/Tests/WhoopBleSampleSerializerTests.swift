import XCTest
@testable import WhoopBLE

final class WhoopBleSampleSerializerTests: XCTestCase {
    func testRealtimePreservesReportedHeartRateAndFractionalClock() throws {
        let sample = WhoopRealtimeDataSample(
            timestampSeconds: 1_711_000_000, subSeconds: 16_384,
            heartRate: 132, rrIntervalMs: 0, quaternionW: 1, quaternionX: 0,
            quaternionY: 0, quaternionZ: 0, opticalBytes: Data(count: 18)
        )
        let rows = WhoopBleSampleSerializer.realtime([sample])
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row["timestamp"] as? String, "2024-03-21T05:46:40.500Z")
        XCTAssertEqual(row["heartRateBpm"] as? Int, Int(sample.heartRate))
        XCTAssertEqual(row["rrIntervalMs"] as? Int, Int(sample.rrIntervalMs))
        XCTAssertEqual(row["opticalRawHex"] as? String, sample.opticalBytes.map { String(format: "%02x", $0) }.joined())
        XCTAssertTrue(JSONSerialization.isValidJSONObject(rows))
    }

    func testImuUsesFrameSampleRateAndServerAxisNames() throws {
        let sample = WhoopImuSample(
            timestampSeconds: 1_711_000_000, subSeconds: 0, sampleIndex: 1, samplesInFrame: 50,
            accelerometerX: 0.5, accelerometerY: 0, accelerometerZ: 1,
            gyroscopeX: 2, gyroscopeY: 0, gyroscopeZ: 0
        )
        let row = try XCTUnwrap(WhoopBleSampleSerializer.imu([sample]).first)
        XCTAssertEqual(row["timestamp"] as? String, "2024-03-21T05:46:40.020Z")
        XCTAssertEqual(row["x"] as? Double, Double(sample.accelerometerX))
        XCTAssertEqual(row["y"] as? Double, Double(sample.accelerometerY))
        XCTAssertEqual(row["z"] as? Double, Double(sample.accelerometerZ))
        XCTAssertEqual(row["gyroscopeX"] as? Double, Double(sample.gyroscopeX))
    }

    private func capturedFrames() throws -> [WhoopFrame] {
        let capture = try XCTUnwrap(Bundle.module.url(
            forResource: "imu-activation-capture", withExtension: "tsv", subdirectory: "fixtures"
        ))
        return try String(contentsOf: capture, encoding: .utf8).split(separator: "\n").compactMap { line in
            guard let hex = line.split(separator: "\t").last, let bytes = Data(hexString: String(hex)) else { return nil }
            return WhoopBleFrameParser.parseFrame(bytes)
        }
    }

    func testCapturedPacketKeepsReportedHeartRateWithoutIntervals() throws {
        let sample = try XCTUnwrap(try capturedFrames().compactMap {
            WhoopBleFrameParser.extractRealtimeData(from: $0)
        }.first { $0.heartRate == 62 && $0.rrIntervalMs == 0 })
        let row = try XCTUnwrap(WhoopBleSampleSerializer.realtime([sample]).first)
        XCTAssertEqual(row["heartRateBpm"] as? Int, 62)
        XCTAssertEqual(row["rrIntervalMs"] as? Int, 0)
    }

    func testCapturedHistoryAndLiveReadingStayInTheSameSecond() throws {
        let frames = try capturedFrames()
        let live = try XCTUnwrap(frames.first { $0.packetType == WhoopBleConstants.packetTypeRealtimeData })
        let history = try XCTUnwrap(frames.first {
            $0.packetType == WhoopBleConstants.packetTypeHistoricalData && $0.recordType == 18 && $0.dataTimestamp == live.dataTimestamp
        })
        let rows = WhoopBleSampleSerializer.realtime([
            try XCTUnwrap(WhoopBleFrameParser.extractRealtimeData(from: live)),
            try XCTUnwrap(WhoopBleFrameParser.extractRealtimeData(from: history)),
        ])
        XCTAssertEqual(rows[0]["timestamp"] as? String, "2026-03-29T15:28:29.000Z")
        XCTAssertEqual(rows[1]["timestamp"] as? String, "2026-03-29T15:28:29.430Z")
    }

    func testClockBoundsAndImuSamplePosition() throws {
        let rows = WhoopBleSampleSerializer.realtime([
            makeRealtimeSample(timestampSeconds: 100_000),
            makeRealtimeSample(timestampSeconds: UInt32.max),
        ])
        XCTAssertEqual(rows[0]["timestamp"] as? String, "2000-01-01T00:00:00.000Z")
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let timestamp = try XCTUnwrap(rows[1]["timestamp"] as? String)
        let date = try XCTUnwrap(formatter.date(from: timestamp))
        // The wire timestamp rounds to milliseconds, while Date retains finer precision.
        XCTAssertLessThanOrEqual(date.timeIntervalSince1970, Date().addingTimeInterval(300.001).timeIntervalSince1970)
        let sample = WhoopImuSample(
            timestampSeconds: 1_711_000_000, subSeconds: 16_384, sampleIndex: 99, samplesInFrame: 100,
            accelerometerX: 0, accelerometerY: 0, accelerometerZ: 0,
            gyroscopeX: 0, gyroscopeY: 0, gyroscopeZ: 0
        )
        XCTAssertEqual(WhoopBleSampleSerializer.imu([sample])[0]["timestamp"] as? String, "2024-03-21T05:46:41.490Z")
    }

    func testFutureImuClockBoundsIncludeFinalSampleOffset() throws {
        let sample = WhoopImuSample(
            timestampSeconds: UInt32.max, subSeconds: 16_384, sampleIndex: 99, samplesInFrame: 100,
            accelerometerX: 0, accelerometerY: 0, accelerometerZ: 0,
            gyroscopeX: 0, gyroscopeY: 0, gyroscopeZ: 0
        )
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let row = try XCTUnwrap(WhoopBleSampleSerializer.imu([sample]).first)
        let timestamp = try XCTUnwrap(row["timestamp"] as? String)
        let date = try XCTUnwrap(formatter.date(from: timestamp))
        XCTAssertLessThanOrEqual(date.timeIntervalSince1970, Date().addingTimeInterval(300.001).timeIntervalSince1970)
    }
}
