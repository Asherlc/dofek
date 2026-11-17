import XCTest
@testable import WhoopBLE

extension WhoopBleBackgroundUploaderTests {
    func testLiveFailureReportsBatchIdentityAndRetainedOutboxState() throws {
        var outcomes: [WhoopUploadOutcome] = []
        let (uploader, store, transport) = try setup(reportUploadOutcome: { outcomes.append($0) })
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush()
        try settle(uploader)

        let identity = try XCTUnwrap(transport.requests.first?.2)
        transport.failOnePath(identity: identity)
        try settle(uploader)

        let outcome = try XCTUnwrap(outcomes.first)
        XCTAssertEqual(outcome.batchIdentity, identity)
        XCTAssertEqual(outcome.stream, "realtime")
        XCTAssertEqual(outcome.stage, "path_failed_fallback_active")
        XCTAssertNil(outcome.statusCode)
        XCTAssertFalse(outcome.acknowledgmentValidated)
        XCTAssertEqual(outcome.outboxState, "pending")
        XCTAssertEqual(try store.pendingBatches().count, 1)
    }

    func testTransportFailureReportsBatchIdentityAndTerminalPendingState() throws {
        var outcomes: [WhoopUploadOutcome] = []
        var reportOrder: [String] = []
        let (uploader, store, transport) = try setup(
            reportError: { _ in reportOrder.append("error") },
            reportUploadOutcome: { outcomes.append($0); reportOrder.append("outcome") }
        )
        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: rows])
        try uploader.flush()
        try settle(uploader)

        transport.fail(0, error: URLError(.networkConnectionLost))
        try settle(uploader)

        let outcome = try XCTUnwrap(outcomes.first)
        XCTAssertEqual(outcome.batchIdentity, try XCTUnwrap(transport.requests.first?.2))
        XCTAssertEqual(outcome.stream, "sensorRecords")
        XCTAssertEqual(outcome.route, "whoopBleSync.pushSensorRecords")
        XCTAssertEqual(outcome.stage, "transport_error")
        XCTAssertNil(outcome.statusCode)
        XCTAssertFalse(outcome.acknowledgmentValidated)
        XCTAssertEqual(outcome.outboxState, "pending")
        XCTAssertEqual(try store.pendingBatches().count, 1)
        XCTAssertEqual(reportOrder, ["outcome", "error"])
    }

    func testValidAcknowledgmentReportsOutboxRetirement() throws {
        var outcomes: [WhoopUploadOutcome] = []
        let (uploader, store, transport) = try setup(reportUploadOutcome: { outcomes.append($0) })
        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: rows])
        try uploader.flush()
        try settle(uploader)

        transport.complete(0)
        try settle(uploader)

        let outcome = try XCTUnwrap(outcomes.first)
        XCTAssertEqual(outcome.batchIdentity, try XCTUnwrap(transport.requests.first?.2))
        XCTAssertEqual(outcome.stage, "outbox_retired")
        XCTAssertEqual(outcome.statusCode, 200)
        XCTAssertEqual(outcome.responseOriginValidated, true)
        XCTAssertTrue(outcome.acknowledgmentValidated)
        XCTAssertEqual(outcome.outboxState, "retired")
        XCTAssertTrue(try store.pendingBatches().isEmpty)
    }

    func testBodyFileCleanupFailureReportsRetirementBeforeError() throws {
        var outcomes: [WhoopUploadOutcome] = []
        var reportOrder: [String] = []
        let (uploader, store, transport) = try setup(
            reportError: { _ in reportOrder.append("error") },
            reportUploadOutcome: { outcomes.append($0); reportOrder.append("outcome") },
            removeBodyFile: { _ in throw NSError(domain: "WhoopUploadTest", code: 1) }
        )
        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: rows])
        try uploader.flush()
        try settle(uploader)

        transport.complete(0)
        try settle(uploader)

        let outcome = try XCTUnwrap(outcomes.first)
        XCTAssertEqual(outcomes.count, 1)
        XCTAssertEqual(outcome.stage, "outbox_retired_cleanup_failed")
        XCTAssertEqual(outcome.statusCode, 200)
        XCTAssertTrue(outcome.acknowledgmentValidated)
        XCTAssertEqual(outcome.outboxState, "retired")
        XCTAssertTrue(try store.pendingBatches().isEmpty)
        XCTAssertEqual(reportOrder, ["outcome", "error"])
    }

    func testOnlyValidatedHttp5xxIsExcludedFromOutcomeBreadcrumbs() {
        XCTAssertTrue(outcome(stage: "http_status_rejected", status: 503, originValidated: true)
            .isValidatedHttp5xxRejection)
        XCTAssertFalse(outcome(stage: "response_origin_rejected", status: 503, originValidated: false)
            .isValidatedHttp5xxRejection)
        XCTAssertFalse(outcome(stage: "transport_error", status: 503, originValidated: nil)
            .isValidatedHttp5xxRejection)
    }

    func testNonHTTPSResponseOriginReportsRejectionAndBlocksStream() throws {
        var outcomes: [WhoopUploadOutcome] = []
        var errors: [Error] = []
        let (uploader, store, transport) = try setup(
            reportError: { errors.append($0) },
            reportUploadOutcome: { outcomes.append($0) }
        )
        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: rows])
        try uploader.flush()
        try settle(uploader)

        transport.complete(0, status: 503, responseURL: URL(string: "http://example.com"))
        try settle(uploader)

        let outcome = try XCTUnwrap(outcomes.first)
        XCTAssertEqual(outcome.stage, "response_origin_rejected")
        XCTAssertEqual(outcome.responseOriginValidated, false)
        XCTAssertEqual(errors.count, 1)
        XCTAssertEqual(try store.pendingBatches().count, 1)
        XCTAssertEqual(try uploader.diagnostics()["blockedUploadStreams"] as? [String], ["sensorRecords"])
    }

    func testMalformedJSONAcknowledgmentReportsInvalidStageAndBlocksStream() throws {
        var outcomes: [WhoopUploadOutcome] = []
        var errors: [Error] = []
        let (uploader, store, transport) = try setup(
            reportError: { errors.append($0) },
            reportUploadOutcome: { outcomes.append($0) }
        )
        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: rows])
        try uploader.flush()
        try settle(uploader)

        transport.complete(0, body: "{")
        try settle(uploader)

        let outcome = try XCTUnwrap(outcomes.first)
        XCTAssertEqual(outcome.stage, "acknowledgment_invalid")
        XCTAssertEqual(outcome.responseOriginValidated, true)
        XCTAssertFalse(outcome.acknowledgmentValidated)
        XCTAssertEqual(errors.count, 1)
        XCTAssertEqual(try store.pendingBatches().count, 1)
        XCTAssertEqual(try uploader.diagnostics()["blockedUploadStreams"] as? [String], ["sensorRecords"])
    }

    private func outcome(stage: String, status: Int, originValidated: Bool?) -> WhoopUploadOutcome {
        WhoopUploadOutcome(
            batchIdentity: "generation.batch", stream: "sensorRecords",
            route: "whoopBleSync.pushSensorRecords", stage: stage, statusCode: status,
            responseOriginValidated: originValidated, acknowledgmentValidated: false, outboxState: "pending")
    }
}
