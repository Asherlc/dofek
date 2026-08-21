import XCTest
@testable import WhoopBLE

final class WhoopBleSampleBufferTimestampTests: XCTestCase {
    private var buffer: WhoopBleSampleBuffer!

    override func setUp() {
        super.setUp()
        buffer = WhoopBleSampleBuffer()
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
        let sub: UInt16 = 500
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
            timeIntervalSince1970: TimeInterval(timestampSeconds) + TimeInterval(sub) / 1000.0
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
        XCTAssertNil(dict["heartRate"])
        XCTAssertEqual(dict["rrIntervalMs"] as? Int, 833)
        XCTAssertEqual(dict["quaternionW"] as? Double, 1.0)
        XCTAssertNotNil(dict["opticalRawHex"] as? String)
    }
}
