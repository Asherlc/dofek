import XCTest
@testable import WhoopBLE

extension WhoopBleBackgroundUploaderTests {
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
