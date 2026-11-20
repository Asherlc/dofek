import XCTest
@testable import WhoopBLE

extension WhoopBleBackgroundUploaderTests {
    /// Promotion must use the existing reconciliation path: startup and the
    /// coalesced capture trigger must move staged rows even without a token.
    func testCaptureIndexesStagedSamplesThroughExistingScheduleWithoutToken() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory) }
        try store.configure(WhoopUploadBinding(userId: "alice", serverURL: "https://example.com"))
        let transport = TestWhoopUploadTransport()
        let uploader = try WhoopBleBackgroundUploader(
            store: store, directory: directory.appendingPathComponent("bodies"),
            transport: transport, reportError: { XCTFail("Unexpected uploader error: \($0)") }
        )

        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try settle(uploader)

        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM samples WHERE stream = 'realtime'"), 1)
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples"), 0)
        XCTAssertEqual(try store.queuedCount(stream: .realtime), 1)
        XCTAssertTrue(transport.requests.isEmpty)
    }

    /// An ACK-only reconciliation counts and reserves indexed rows only. A
    /// size-ready stream staged outside the capture trigger stays in the inbox.
    func testAckOnlyReconciliationLeavesStagedSecondStreamUntilFlush() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory) }
        let transport = TestWhoopUploadTransport()
        let uploader = try WhoopBleBackgroundUploader(
            store: store, directory: directory.appendingPathComponent("bodies"),
            transport: transport, reportError: { XCTFail("Unexpected uploader error: \($0)") }
        )
        try uploader.configure(userId: "alice", serverURL: "https://example.com", token: "secret", headers: [:])
        try settle(uploader)

        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush()
        try settle(uploader)
        XCTAssertEqual(transport.requests.count, 1)

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let base = Date(timeIntervalSince1970: 1_793_000_000)
        let imu = (0..<500).map { index in
            ["timestamp": formatter.string(from: base.addingTimeInterval(Double(index) * 0.01)), "x": 1.0, "y": 2.0, "z": 3.0]
        }
        try store.append(deviceId: "a", samplesByStream: [.imu: imu])
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples WHERE stream = 'imu'"), 1)

        transport.complete(0)
        try settle(uploader)
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples WHERE stream = 'imu'"), 1)
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM samples WHERE stream = 'imu'"), 0)
        XCTAssertEqual(transport.requests.count, 1)

        try uploader.flush()
        try settle(uploader)
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples WHERE stream = 'imu'"), 0)
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM samples WHERE stream = 'imu'"), 500)
        XCTAssertEqual(transport.requests.count, 2)
    }

    /// A malformed staged chunk must not block the separately durable cutoff
    /// stage that precedes whole-account purge.
    func testDisableWithMalformedInboxKeepsCutoffBeforePurge() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory) }
        let transport = TestWhoopUploadTransport()
        let uploader = try WhoopBleBackgroundUploader(
            store: store, directory: directory.appendingPathComponent("bodies"),
            transport: transport, reportError: { _ in }
        )
        try uploader.configure(userId: "alice", serverURL: "https://example.com", token: "secret", headers: [:])
        try settle(uploader)

        try store.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try probe.executeFixture("UPDATE incoming_samples SET payload = X'00010203'")
        let stages = CleanupStageRecorder()
        try uploader.disable(cutoff: Date(timeIntervalSince1970: 1_800_000_000)) { stages.append($0) }

        try assertUploaderCutoffStageOrder(stages.snapshot)
        XCTAssertNil(try store.binding)
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples"), 0)
    }
}
