import XCTest
@testable import WhoopBLE

extension WhoopBleBackgroundUploaderTests {
    func testCredentialRefreshKeepsTheAttemptOfAnAcknowledgmentAlreadyInFlight() throws {
        let (uploader, store, transport) = try setup()
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush(); try settle(uploader)

        transport.afterAllTasks = {
            transport.afterAllTasks = nil
            transport.terminalResultPending = true
            transport.complete(0)
        }
        try uploader.configure(userId: "alice", serverURL: "https://example.com", token: "secret", headers: [:])
        try settle(uploader)
        XCTAssertEqual(transport.requests.count, 1)
        XCTAssertTrue(try store.pendingBatches().isEmpty)
        XCTAssertEqual(try store.queuedCount(stream: .realtime), 0)
    }

    func testOnlyCompressesAfterAnAcknowledgmentAdvertisesGzip() throws {
        let (uploader, store, transport) = try setup()
        let samples = Array(repeating: rows[0], count: 20)
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: samples])
        try uploader.flush(); try settle(uploader)

        let first = try XCTUnwrap(transport.requests.first)
        XCTAssertNil(first.0.value(forHTTPHeaderField: "Content-Encoding"))
        let plain = try Data(contentsOf: first.1)
        XCTAssertEqual(plain, try store.pendingBatches().first?.body)
        transport.complete(0, responseURL: URL(string: "https://example.com/other-upload"), acceptsGzip: true)
        try settle(uploader)

        try uploader.append(deviceId: "a", samplesByStream: [.realtime: samples])
        try uploader.flush(); try settle(uploader)
        let direct = try XCTUnwrap(transport.requests.dropFirst().first)
        XCTAssertNil(direct.0.value(forHTTPHeaderField: "Content-Encoding"))
        transport.complete(1, acceptsGzip: true)
        try settle(uploader)

        try uploader.append(deviceId: "a", samplesByStream: [.realtime: samples, .imu: samples])
        try uploader.flush(); try settle(uploader)

        let upload = try XCTUnwrap(transport.requests.dropFirst(2).first { $0.0.url == first.0.url })
        let imu = try XCTUnwrap(transport.requests.first { $0.0.url != first.0.url })
        XCTAssertNil(imu.0.value(forHTTPHeaderField: "Content-Encoding"))
        XCTAssertEqual(upload.0.value(forHTTPHeaderField: "Content-Encoding"), "gzip")
        let compressed = try Data(contentsOf: upload.1)
        XCTAssertEqual(Array(compressed.prefix(2)), [0x1f, 0x8b])
        XCTAssertLessThan(compressed.count, plain.count)
    }

    func testGzipRejectionRetriesTheSameReservationUsingPlainJSON() throws {
        let (uploader, store, transport) = try setup()
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush(); try settle(uploader)
        transport.complete(0, acceptsGzip: true)
        try settle(uploader)

        try uploader.append(deviceId: "a", samplesByStream: [.realtime: Array(repeating: rows[0], count: 20)])
        try uploader.flush(); try settle(uploader)
        let encoded = try XCTUnwrap(transport.requests.dropFirst().first)
        XCTAssertEqual(encoded.0.value(forHTTPHeaderField: "Content-Encoding"), "gzip")
        let reserved = try XCTUnwrap(store.pendingBatches().first)
        transport.complete(1, status: 400, body: "")
        try settle(uploader)

        let retry = try XCTUnwrap(transport.requests.dropFirst(2).first)
        XCTAssertEqual(retry.2, encoded.2)
        XCTAssertNil(retry.0.value(forHTTPHeaderField: "Content-Encoding"))
        XCTAssertNotEqual(retry.1, encoded.1)
        XCTAssertEqual(try Data(contentsOf: retry.1), reserved.body)
        transport.complete(2)
        try settle(uploader)
        XCTAssertTrue(try store.pendingBatches().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: encoded.1.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: retry.1.path))
    }

    func testConnectionLossRecoveryMeasuresUntilTheSameBatchIsAcknowledged() throws {
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
        transport.fail(0, error: URLError(.networkConnectionLost))
        try settle(uploader)

        XCTAssertTrue(transport.tasks.isEmpty)
        XCTAssertEqual(try store.pendingBatches().map(\.id), [pending.id])
        XCTAssertEqual(outcomes.map(\.stage), ["transport_error"])
        XCTAssertEqual(outcomes.filter(\.transportConnectionLost).count, 1)
        XCTAssertTrue(outcomes.compactMap(\.connectionLossRecoveryDuration).isEmpty)
        XCTAssertEqual(errors.count, 1)

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
        XCTAssertEqual(outcomes.compactMap(\.connectionLossRecoveryDuration), [.milliseconds(19_250)])
        XCTAssertEqual(outcomes.filter(\.transportConnectionLost).count, 1)
        XCTAssertEqual(errors.count, 1)
    }

    func testErasedReservationCannotRecoverFromConnectionLoss() throws {
        var outcomes: [WhoopUploadOutcome] = []
        let (uploader, store, transport) = try setup(reportUploadOutcome: { outcomes.append($0) })
        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: rows])
        try uploader.flush()
        try settle(uploader)
        transport.fail(0, error: URLError(.networkConnectionLost))
        try settle(uploader)
        XCTAssertEqual(outcomes.filter(\.transportConnectionLost).count, 1)
        try uploader.flush()
        try settle(uploader)

        try store.advanceErasureCutoff(to: Date(timeIntervalSince1970: 1_800_000_000))
        XCTAssertTrue(try store.pendingBatches().isEmpty)
        transport.complete(1)
        try settle(uploader)

        XCTAssertEqual(outcomes.last?.stage, "batch_not_found")
        XCTAssertTrue(outcomes.compactMap(\.connectionLossRecoveryDuration).isEmpty)
    }

    func testUnrelatedErrorDomainDoesNotCountAsConnectionLoss() throws {
        var errors: [Error] = []
        var outcomes: [WhoopUploadOutcome] = []
        let (uploader, store, transport) = try setup(
            reportError: { errors.append($0) }, reportUploadOutcome: { outcomes.append($0) })
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush()
        try settle(uploader)

        let identity = try XCTUnwrap(transport.requests.first?.2)
        transport.fail(0, error: NSError(domain: "OtherNetworkError", code: -1005))
        try settle(uploader)

        let outcome = try XCTUnwrap(outcomes.first)
        XCTAssertEqual(outcome.batchIdentity, identity)
        XCTAssertEqual(outcome.stream, "realtime")
        XCTAssertEqual(outcome.stage, "transport_error")
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
        transport.fail(0, error: URLError(.networkConnectionLost))
        try settle(uploader)
        try uploader.flush()
        try settle(uploader)
        transport.complete(1, status: 408, body: "")
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
        XCTAssertEqual(reportOrder, ["outcome", "error", "outcome", "outcome", "error"])
    }

    func testOnlyValidatedHttp5xxIsExcludedFromOutcomeBreadcrumbs() {
        XCTAssertTrue(outcome(stage: "http_status_rejected", status: 503, originValidated: true)
            .isValidatedHttp5xxRejection)
        XCTAssertFalse(outcome(stage: "response_origin_rejected", status: 503, originValidated: false)
            .isValidatedHttp5xxRejection)
        XCTAssertFalse(outcome(stage: "transport_error", status: 503, originValidated: nil)
            .isValidatedHttp5xxRejection)
    }

    func testCrossOriginCompletionRetainsRowsAndBlocksUntilConfigure() throws {
        let (uploader, store, transport) = try setup()
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush(); try settle(uploader)
        let identity = try XCTUnwrap(transport.requests.first?.2)
        transport.tasks.removeAll()
        transport.onCompletion?(identity, 200, Data("{\"result\":{\"data\":{\"inserted\":1}}}".utf8),
                                WhoopUploadCompletionContext(
                                    attempt: transport.attempts[identity],
                                    responseURL: URL(string: "https://other.example/api/trpc/whoopBleSync.pushRealtimeData"),
                                    taskIdentifier: nil, transportPath: nil
                                ), nil)
        try settle(uploader)
        XCTAssertEqual(try store.queuedCount(stream: .realtime), 1)
        XCTAssertEqual(try store.pendingBatches().count, 1)
        XCTAssertEqual(try uploader.diagnostics()["blockedUploadStreams"] as? [String], ["realtime"])
        try uploader.flush(); try settle(uploader)
        XCTAssertEqual(transport.requests.count, 1)
        try uploader.configure(userId: "alice", serverURL: "https://example.com", token: "new", headers: [:])
        try settle(uploader)
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertEqual(transport.requests.last?.2, identity)
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
            occurredAt: "2026-11-17T00:00:00Z")
    }
}
