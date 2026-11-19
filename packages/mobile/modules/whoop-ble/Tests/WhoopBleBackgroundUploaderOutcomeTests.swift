import XCTest
@testable import WhoopBLE

extension WhoopBleBackgroundUploaderTests {
    func testLiveConnectionLossWithSiblingRetainsDurableBatchWithoutException() throws {
        var instant = ContinuousClock.now
        var errors: [Error] = []
        var outcomes: [WhoopUploadOutcome] = []
        let (uploader, store, transport) = try setup(
            reportError: { errors.append($0) },
            reportUploadOutcome: { outcomes.append($0) },
            monotonicNow: { instant }
        )
        try uploader.append(deviceId: "a", samplesByStream: [.imu: Array(repeating: rows[0], count: 500)])
        try settle(uploader)

        let identity = try XCTUnwrap(transport.requests.first?.2)
        let pending = try XCTUnwrap(store.pendingBatches().first)
        transport.failOnePath(identity: identity)
        try settle(uploader)

        XCTAssertTrue(transport.tasks.contains(identity))
        XCTAssertEqual(try store.pendingBatches().map(\.id), [pending.id])
        XCTAssertEqual(outcomes.map(\.stage), ["path_failed_fallback_active"])
        XCTAssertTrue(errors.isEmpty, "A live -1005 with a sibling remaining is an operational outcome")
        XCTAssertEqual(outcomes.filter(\.transportConnectionLost).count, 1)
        XCTAssertTrue(outcomes.compactMap(\.connectionLossRecoveryDuration).isEmpty)

        instant = instant.advanced(by: .seconds(8))
        transport.fail(0, error: URLError(.networkConnectionLost))
        try settle(uploader)
        XCTAssertEqual(outcomes.filter(\.transportConnectionLost).count, 2)
        XCTAssertTrue(outcomes.compactMap(\.connectionLossRecoveryDuration).isEmpty)
        XCTAssertEqual(errors.count, 1, "The terminal path failure remains actionable")
        XCTAssertEqual(try store.pendingBatches().map(\.id), [pending.id])

        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: rows])
        try uploader.configure(userId: "alice", serverURL: "https://example.com", token: "refreshed", headers: [:])
        try settle(uploader)
        let retryIndex = try XCTUnwrap(transport.requests.indices.dropFirst().first { transport.requests[$0].2 == identity })
        let otherIndex = try XCTUnwrap(transport.requests.indices.first { transport.requests[$0].2 != identity })
        transport.complete(otherIndex)
        try settle(uploader)
        XCTAssertTrue(outcomes.compactMap(\.connectionLossRecoveryDuration).isEmpty)

        instant = instant.advanced(by: .milliseconds(19_250))
        transport.complete(retryIndex)
        try settle(uploader)
        XCTAssertTrue(try store.pendingBatches().isEmpty)
        XCTAssertEqual(outcomes.last?.stage, "outbox_retired")
        XCTAssertEqual(outcomes.last?.batchIdentity, identity)
        XCTAssertEqual(outcomes.compactMap(\.connectionLossRecoveryDuration), [.milliseconds(27_250)])
        XCTAssertEqual(outcomes.filter(\.transportConnectionLost).count, 2)
        XCTAssertEqual(errors.count, 1)
    }

    func testErasedReservationCannotRecoverFromConnectionLoss() throws {
        var outcomes: [WhoopUploadOutcome] = []
        let (uploader, store, transport) = try setup(reportUploadOutcome: { outcomes.append($0) })
        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: rows])
        try uploader.flush()
        try settle(uploader)
        let identity = try XCTUnwrap(transport.requests.first?.2)
        transport.failOnePath(identity: identity)
        try settle(uploader)
        XCTAssertEqual(outcomes.filter(\.transportConnectionLost).count, 1)

        try store.advanceErasureCutoff(to: Date(timeIntervalSince1970: 1_800_000_000))
        XCTAssertTrue(try store.pendingBatches().isEmpty)
        transport.complete(0)
        try settle(uploader)

        XCTAssertEqual(outcomes.last?.stage, "batch_not_found")
        XCTAssertTrue(outcomes.compactMap(\.connectionLossRecoveryDuration).isEmpty)
    }

    func testLiveFailureReportsBatchIdentityAndRetainedOutboxState() throws {
        var errors: [Error] = []
        var outcomes: [WhoopUploadOutcome] = []
        let (uploader, store, transport) = try setup(
            reportError: { errors.append($0) }, reportUploadOutcome: { outcomes.append($0) })
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush()
        try settle(uploader)

        let identity = try XCTUnwrap(transport.requests.first?.2)
        transport.failOnePath(identity: identity, error: NSError(domain: "OtherNetworkError", code: -1005))
        try settle(uploader)

        let outcome = try XCTUnwrap(outcomes.first)
        XCTAssertEqual(outcome.batchIdentity, identity)
        XCTAssertEqual(outcome.stream, "realtime")
        XCTAssertEqual(outcome.stage, "path_failed_fallback_active")
        XCTAssertNil(outcome.statusCode)
        XCTAssertFalse(outcome.acknowledgmentValidated)
        XCTAssertEqual(outcome.outboxState, "pending")
        XCTAssertFalse(outcome.transportConnectionLost)
        XCTAssertEqual(errors.count, 1)
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
        XCTAssertTrue(outcome.transportConnectionLost)
        XCTAssertNil(outcome.connectionLossRecoveryDuration)
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
        var instant = ContinuousClock.now
        var outcomes: [WhoopUploadOutcome] = []
        var reportOrder: [String] = []
        let (uploader, store, transport) = try setup(
            reportError: { _ in reportOrder.append("error") },
            reportUploadOutcome: { outcomes.append($0); reportOrder.append("outcome") },
            removeBodyFile: { _ in throw NSError(domain: "WhoopUploadTest", code: 1) },
            monotonicNow: { instant }
        )
        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: rows])
        try uploader.flush()
        try settle(uploader)

        let identity = try XCTUnwrap(transport.requests.first?.2)
        transport.failOnePath(identity: identity)
        try settle(uploader)
        transport.complete(0, status: 408, body: "")
        try settle(uploader)
        try uploader.flush()
        try settle(uploader)
        let retryIndex = try XCTUnwrap(transport.requests.indices.dropFirst().last)
        XCTAssertEqual(transport.requests[retryIndex].2, identity)
        instant = instant.advanced(by: .seconds(4))
        transport.complete(retryIndex)
        try settle(uploader)

        let outcome = try XCTUnwrap(outcomes.last)
        XCTAssertEqual(outcomes.count, 3)
        XCTAssertEqual(outcome.stage, "outbox_retired_cleanup_failed")
        XCTAssertEqual(outcome.statusCode, 200)
        XCTAssertTrue(outcome.acknowledgmentValidated)
        XCTAssertEqual(outcome.outboxState, "retired")
        XCTAssertEqual(outcomes.compactMap(\.connectionLossRecoveryDuration), [.seconds(4)])
        XCTAssertEqual(try uploader.diagnostics()["http408RecoveredBatchCount"] as? Int, 1)
        XCTAssertTrue(try store.pendingBatches().isEmpty)
        XCTAssertEqual(reportOrder, ["outcome", "outcome", "outcome", "error"])
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

        let identity = try XCTUnwrap(transport.requests.first?.2)
        transport.failOnePath(identity: identity)
        try settle(uploader)
        transport.complete(0, body: "{")
        try settle(uploader)

        let outcome = try XCTUnwrap(outcomes.last)
        XCTAssertEqual(outcome.stage, "acknowledgment_invalid")
        XCTAssertEqual(outcome.responseOriginValidated, true)
        XCTAssertFalse(outcome.acknowledgmentValidated)
        XCTAssertTrue(outcomes.compactMap(\.connectionLossRecoveryDuration).isEmpty)
        XCTAssertEqual(errors.count, 1)
        XCTAssertEqual(try store.pendingBatches().count, 1)
        XCTAssertEqual(try uploader.diagnostics()["blockedUploadStreams"] as? [String], ["sensorRecords"])
    }

    private func outcome(stage: String, status: Int, originValidated: Bool?) -> WhoopUploadOutcome {
        WhoopUploadOutcome(
            batchIdentity: "generation.batch", stream: "sensorRecords",
            route: "whoopBleSync.pushSensorRecords", stage: stage, statusCode: status,
            responseOriginValidated: originValidated, acknowledgmentValidated: false, outboxState: "pending",
            batchSampleCount: nil, attempt: nil, taskIdentifier: nil, transportPath: nil,
            siblingTaskPending: nil, occurredAt: "2026-11-17T00:00:00Z")
    }
}
