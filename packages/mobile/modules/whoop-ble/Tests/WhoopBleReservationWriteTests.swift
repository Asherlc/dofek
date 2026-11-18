import XCTest
@testable import WhoopBLE

extension WhoopBleBackgroundUploaderTests {
    func testReservationWriteMeasurementUsesCounterDeltas() {
        let previous = WhoopSQLiteWriteMeasurement(walPagesWritten: 18, walPagesSpilled: 4)
        let current = WhoopSQLiteWriteMeasurement(walPagesWritten: 25, walPagesSpilled: 6)
        XCTAssertEqual(
            current.delta(since: previous),
            WhoopSQLiteWriteMeasurement(walPagesWritten: 7, walPagesSpilled: 2)
        )
        XCTAssertNil(WhoopSQLiteWriteMeasurement(walPagesWritten: 2, walPagesSpilled: 0).delta(since: previous))
    }

    func testSubmitAvailableAccumulatesReservationWriteSummary() throws {
        let (uploader, _, transport) = try setup()

        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush()
        try settle(uploader)

        let firstSummary = try XCTUnwrap(try uploader.diagnostics()["reservationWriteSummary"] as? [String: Int])
        XCTAssertEqual(firstSummary["measuredReservationCount"], 1)
        let firstWriteCount = try XCTUnwrap(firstSummary["walPagesWritten"])
        XCTAssertGreaterThan(firstWriteCount, 0)
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(firstSummary["walPagesSpilled"]), 0)
        XCTAssertGreaterThan(try XCTUnwrap(firstSummary["maxWalPagesWritten"]), 0)
        XCTAssertEqual(firstSummary["measurementFailureCount"], 0)

        transport.complete(0)
        try settle(uploader)
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush()
        try settle(uploader)

        let summary = try XCTUnwrap(try uploader.diagnostics()["reservationWriteSummary"] as? [String: Int])
        XCTAssertEqual(summary["measuredReservationCount"], 2)
        XCTAssertGreaterThan(try XCTUnwrap(summary["walPagesWritten"]), firstWriteCount)
        XCTAssertEqual(summary["measurementFailureCount"], 0)
        XCTAssertEqual(transport.requests.count, 2)
    }
}
