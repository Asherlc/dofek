import XCTest
@testable import WhoopBLE

extension WhoopBleBackgroundUploaderTests {
    func testHTTP408KeepsDurableSensorReservationWithoutException() throws {
        var errors: [Error] = []
        let (uploader, store, transport) = try setup(reportError: { errors.append($0) })
        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: rows])
        try uploader.flush()
        try settle(uploader)
        let identity = try XCTUnwrap(transport.requests.first?.2)

        transport.complete(0, status: 408, body: "")
        try settle(uploader)

        XCTAssertEqual(try store.pendingBatches().map { $0.generation + "." + $0.id }, [identity])
        XCTAssertEqual(try uploader.diagnostics()["blockedUploadStreams"] as? [String], [])
        XCTAssertEqual(errors.count, 0, "A retriable HTTP 408 should not report an exception")
    }

    func testHTTP408CountsAttemptsAndRecoversOnlyTheSameBatch() throws {
        var now = Date(timeIntervalSince1970: 1_800_000_000)
        var errors: [Error] = []
        let (uploader, store, transport) = try setup(reportError: { errors.append($0) }, now: { now })
        let sensorRows = Array(repeating: rows[0], count: 16)
        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: sensorRows])
        try uploader.flush()
        try settle(uploader)
        let initial = try XCTUnwrap(transport.requests.first)
        let initialBody = try Data(contentsOf: initial.1)
        let initialAttempt = try XCTUnwrap(transport.attempts[initial.2])

        transport.complete(0, status: 408, body: "")
        try settle(uploader)
        XCTAssertEqual(try uploader.diagnostics()["http408ResponseCount"] as? Int, 1)
        XCTAssertEqual(try uploader.diagnostics()["http408RecoveredBatchCount"] as? Int, 0)

        now.addTimeInterval(31)
        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: sensorRows])
        try settle(uploader)
        let firstRetry = try XCTUnwrap(transport.requests.dropFirst().first)
        XCTAssertEqual(firstRetry.2, initial.2)
        XCTAssertEqual(try Data(contentsOf: firstRetry.1), initialBody)
        transport.onCompletion?(initial.2, 408, Data(), (initialAttempt, initial.0.url, 1, "test"), nil)
        try settle(uploader)
        XCTAssertEqual(try uploader.diagnostics()["http408ResponseCount"] as? Int, 1)
        transport.complete(1, status: 408, body: "")
        try settle(uploader)
        XCTAssertEqual(try uploader.diagnostics()["http408ResponseCount"] as? Int, 2)
        XCTAssertEqual(try uploader.diagnostics()["http408RecoveredBatchCount"] as? Int, 0)

        now.addTimeInterval(31)
        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: sensorRows])
        try settle(uploader)
        XCTAssertEqual(try XCTUnwrap(transport.requests.dropFirst(2).first).2, initial.2)
        transport.complete(2, body: "{\"result\":{\"data\":{\"inserted\":16}}}")
        try settle(uploader)
        XCTAssertEqual(try uploader.diagnostics()["http408ResponseCount"] as? Int, 2)
        XCTAssertEqual(try uploader.diagnostics()["http408RecoveredBatchCount"] as? Int, 1)
        XCTAssertFalse(try store.pendingBatches().contains { $0.generation + "." + $0.id == initial.2 })

        let successor = try XCTUnwrap(transport.requests.dropFirst(3).first)
        XCTAssertNotEqual(successor.2, initial.2)
        transport.complete(3)
        try settle(uploader)
        XCTAssertEqual(try uploader.diagnostics()["http408RecoveredBatchCount"] as? Int, 1)
        XCTAssertTrue(errors.isEmpty)
    }

    func testCrossOrigin408ReportsExceptionAndKeepsCountersZero() throws {
        var errors: [Error] = []
        let (uploader, store, transport) = try setup(reportError: { errors.append($0) })
        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: rows])
        try uploader.flush()
        try settle(uploader)
        let identity = try XCTUnwrap(transport.requests.first?.2)
        let foreignOrigin = try XCTUnwrap(URL(string: "https://other.example"))

        transport.complete(0, status: 408, body: "", responseURL: foreignOrigin)
        try settle(uploader)

        XCTAssertEqual(errors.count, 1)
        XCTAssertEqual(try uploader.diagnostics()["lastUploadError"] as? String,
                       "WHOOP upload response changed origin")
        XCTAssertEqual(try uploader.diagnostics()["http408ResponseCount"] as? Int, 0)
        XCTAssertEqual(try uploader.diagnostics()["http408RecoveredBatchCount"] as? Int, 0)
        XCTAssertEqual(try store.pendingBatches().map { $0.generation + "." + $0.id }, [identity])
    }

    func testHTTP408ThenInvalidAcknowledgmentLeavesBatchPendingWithoutRecovery() throws {
        var errors: [Error] = []
        let (uploader, store, transport) = try setup(reportError: { errors.append($0) })
        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: rows])
        try uploader.flush()
        try settle(uploader)
        let identity = try XCTUnwrap(transport.requests.first?.2)

        transport.complete(0, status: 408, body: "")
        try settle(uploader)
        try uploader.flush()
        try settle(uploader)
        let retryIndex = try XCTUnwrap(transport.requests.indices.dropFirst().last)
        XCTAssertEqual(transport.requests[retryIndex].2, identity)

        transport.complete(retryIndex, body: "{}")
        try settle(uploader)

        XCTAssertEqual(errors.count, 1)
        XCTAssertEqual(try uploader.diagnostics()["lastUploadError"] as? String,
                       "WHOOP upload returned an invalid acknowledgment")
        XCTAssertEqual(try uploader.diagnostics()["http408ResponseCount"] as? Int, 1)
        XCTAssertEqual(try uploader.diagnostics()["http408RecoveredBatchCount"] as? Int, 0)
        XCTAssertEqual(try store.pendingBatches().map { $0.generation + "." + $0.id }, [identity])
    }

    func testHTTP408ThenFailedRetirementLeavesBatchPendingWithoutRecovery() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory) }
        var errors: [Error] = []
        let transport = TestWhoopUploadTransport()
        let uploader = try WhoopBleBackgroundUploader(
            store: store, directory: directory.appendingPathComponent("bodies"), transport: transport,
            reportError: { errors.append($0) })
        try uploader.configure(userId: "alice", serverURL: "https://example.com", token: "token", headers: [:])
        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: rows])
        try uploader.flush()
        try settle(uploader)
        let identity = try XCTUnwrap(transport.requests.first?.2)

        transport.complete(0, status: 408, body: "")
        try settle(uploader)
        try uploader.flush()
        try settle(uploader)
        let retryIndex = try XCTUnwrap(transport.requests.indices.dropFirst().last)
        XCTAssertEqual(transport.requests[retryIndex].2, identity)
        try probe.executeFixture("""
            CREATE TEMP TRIGGER reject_retirement BEFORE DELETE ON batches
            BEGIN SELECT RAISE(ABORT, 'retirement rejected'); END
            """)

        transport.complete(retryIndex)
        try settle(uploader)

        XCTAssertEqual(errors.count, 1)
        XCTAssertEqual(try uploader.diagnostics()["http408ResponseCount"] as? Int, 1)
        XCTAssertEqual(try uploader.diagnostics()["http408RecoveredBatchCount"] as? Int, 0)
        XCTAssertEqual(try store.pendingBatches().map { $0.generation + "." + $0.id }, [identity])
        XCTAssertEqual(try store.queuedCount(stream: .sensorRecords), rows.count)
    }

    func testHTTP5xxResponsesCountWithoutSentryAndKeepDurableReservation() throws {
        var now = Date(timeIntervalSince1970: 1_800_000_000)
        var errors: [Error] = []
        let (uploader, store, transport) = try setup(reportError: { errors.append($0) }, now: { now })
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush(); try settle(uploader)

        let identity = try XCTUnwrap(transport.requests.first?.2)
        transport.complete(0, status: 500); try settle(uploader)
        XCTAssertEqual(errors.count, 0, "HTTP 500 is an operational status, not an exception alert")
        XCTAssertEqual(try uploader.diagnostics()["http5xxResponseCount"] as? Int, 1)
        XCTAssertEqual(try uploader.diagnostics()["lastUploadError"] as? String,
                       "WHOOP realtime upload returned HTTP 500")
        XCTAssertEqual(try store.pendingBatches().count, 1)

        now.addTimeInterval(29)
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows]); try settle(uploader)
        XCTAssertEqual(transport.requests.count, 1, "The existing 30-second backoff remains in force")
        now.addTimeInterval(5)
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows]); try settle(uploader)
        XCTAssertEqual(transport.requests.count, 2)
        guard transport.requests.count == 2 else { return }
        XCTAssertEqual(transport.requests.last?.2, identity)

        transport.complete(1, status: 599); try settle(uploader)
        XCTAssertEqual(errors.count, 0, "HTTP 599 is an operational status, not an exception alert")
        XCTAssertEqual(try uploader.diagnostics()["http5xxResponseCount"] as? Int, 2)
        XCTAssertEqual(try uploader.diagnostics()["lastUploadError"] as? String,
                       "WHOOP realtime upload returned HTTP 599")
        XCTAssertEqual(try store.pendingBatches().count, 1)
    }

    func testNon5xxHTTPStatusesAndTransportTimeoutRemainSentryErrors() throws {
        var errors: [Error] = []
        let (uploader, _, transport) = try setup(reportError: { errors.append($0) })
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush(); try settle(uploader)

        transport.complete(0, status: 499); try settle(uploader)
        XCTAssertEqual(errors.count, 1)
        XCTAssertEqual(try uploader.diagnostics()["http5xxResponseCount"] as? Int, 0)
        XCTAssertEqual(try uploader.diagnostics()["blockedUploadStreams"] as? [String], ["realtime"])

        try uploader.configure(userId: "alice", serverURL: "https://example.com", token: "new", headers: [:])
        try settle(uploader)
        let requestIndex = try XCTUnwrap(transport.requests.indices.last)
        let identity = transport.requests[requestIndex].2
        transport.complete(requestIndex, status: 600); try settle(uploader)
        XCTAssertEqual(errors.count, 2)
        XCTAssertEqual(try uploader.diagnostics()["http5xxResponseCount"] as? Int, 0)

        try uploader.flush(); try settle(uploader)
        transport.failOnePath(identity: identity, error: URLError(.timedOut))
        try settle(uploader)
        XCTAssertEqual(errors.count, 3, "A timeout without an HTTP 5xx response remains an exception")
        XCTAssertEqual(try uploader.diagnostics()["http5xxResponseCount"] as? Int, 0)
    }
}
