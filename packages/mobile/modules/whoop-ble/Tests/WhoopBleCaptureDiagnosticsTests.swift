import XCTest
@testable import WhoopBLE

final class WhoopBleCaptureDiagnosticsTests: XCTestCase {
    func testNotificationDoesNotClaimParsedOrValidHeartRateCoverage() {
        var diagnostics = WhoopBleCaptureDiagnostics()
        diagnostics.recordNotification(at: Date(timeIntervalSince1970: 1_800_000_000))

        XCTAssertEqual(diagnostics.payload["lastDataNotificationAt"] as? String, "2027-01-15T08:00:00.000Z")
        XCTAssertTrue(diagnostics.payload["lastParsedImuAt"] is NSNull)
        XCTAssertTrue(diagnostics.payload["lastParsedRealtimeAt"] is NSNull)
        XCTAssertTrue(diagnostics.payload["lastValidHeartRateAt"] is NSNull)
    }

    func testParsedFrameSeparatesArrivalTimeFromValidHeartRateSampleTime() {
        var diagnostics = WhoopBleCaptureDiagnostics()
        let observed = Date(timeIntervalSince1970: 1_800_000_000)
        diagnostics.recordParsed(imuCount: 100, realtimeSamples: [sample(heartRate: 0)], at: observed)

        XCTAssertEqual(diagnostics.payload["lastParsedImuAt"] as? String, "2027-01-15T08:00:00.000Z")
        XCTAssertEqual(diagnostics.payload["lastParsedRealtimeAt"] as? String, "2027-01-15T08:00:00.000Z")
        XCTAssertTrue(diagnostics.payload["lastValidHeartRateAt"] is NSNull)

        diagnostics.recordParsed(imuCount: 0, realtimeSamples: [sample(heartRate: 60)], at: observed)
        XCTAssertEqual(diagnostics.payload["lastValidHeartRateAt"] as? String, "2024-03-21T05:46:40.500Z")
    }

    func testEmptyExtractionDoesNotAdvanceParsedTimestamps() {
        var diagnostics = WhoopBleCaptureDiagnostics()
        diagnostics.recordParsed(imuCount: 0, realtimeSamples: [])

        XCTAssertTrue(diagnostics.payload["lastParsedImuAt"] is NSNull)
        XCTAssertTrue(diagnostics.payload["lastParsedRealtimeAt"] is NSNull)
    }

    func testFutureDeviceClockDoesNotPoisonSubsequentValidHeartRateWatermark() {
        var diagnostics = WhoopBleCaptureDiagnostics()
        let observed = Date(timeIntervalSince1970: 1_800_000_000)
        diagnostics.recordParsed(
            imuCount: 0,
            realtimeSamples: [sample(heartRate: 60, timestampSeconds: UInt32.max)],
            at: observed
        )
        XCTAssertTrue(diagnostics.payload["lastValidHeartRateAt"] is NSNull)

        diagnostics.recordParsed(imuCount: 0, realtimeSamples: [sample(heartRate: 60)], at: observed)
        XCTAssertEqual(diagnostics.payload["lastValidHeartRateAt"] as? String, "2024-03-21T05:46:40.500Z")
    }

    func testValidHeartRateWatermarkAcceptsClockBoundariesAndRejectsOutsideThem() {
        var diagnostics = WhoopBleCaptureDiagnostics()
        let observed = Date(timeIntervalSince1970: 1_800_000_000)
        diagnostics.recordParsed(
            imuCount: 0,
            realtimeSamples: [sample(heartRate: 60, timestampSeconds: 946_684_799, subSeconds: 0)],
            at: observed
        )
        XCTAssertTrue(diagnostics.payload["lastValidHeartRateAt"] is NSNull)

        diagnostics.recordParsed(
            imuCount: 0,
            realtimeSamples: [sample(heartRate: 60, timestampSeconds: 946_684_800, subSeconds: 0)],
            at: observed
        )
        XCTAssertEqual(diagnostics.payload["lastValidHeartRateAt"] as? String, "2000-01-01T00:00:00.000Z")

        diagnostics.recordParsed(
            imuCount: 0,
            realtimeSamples: [sample(heartRate: 60, timestampSeconds: 1_800_000_300, subSeconds: 0)],
            at: observed
        )
        XCTAssertEqual(diagnostics.payload["lastValidHeartRateAt"] as? String, "2027-01-15T08:05:00.000Z")
        diagnostics.recordParsed(
            imuCount: 0,
            realtimeSamples: [sample(heartRate: 60, timestampSeconds: 1_800_000_300)],
            at: observed
        )
        XCTAssertEqual(diagnostics.payload["lastValidHeartRateAt"] as? String, "2027-01-15T08:05:00.000Z")
    }

    private func sample(
        heartRate: UInt8,
        timestampSeconds: UInt32 = 1_711_000_000,
        subSeconds: UInt16 = 16_384
    ) -> WhoopRealtimeDataSample {
        WhoopRealtimeDataSample(
            timestampSeconds: timestampSeconds,
            subSeconds: subSeconds,
            heartRate: heartRate,
            rrIntervalMs: 0,
            quaternionW: 1,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
            opticalBytes: Data()
        )
    }
}
