import XCTest
@testable import WhoopBLE

extension WhoopBleSampleStoreTests {
    /// An older binary rotates ownership with INSERT OR REPLACE on the
    /// generation key. The durable trigger must drop staged rows on that path.
    func testLegacyGenerationRotationDropsStagedRows() throws {
        let url = try directory()
        var store: WhoopBleSampleStore? = try WhoopBleSampleStore(directory: url)
        let probe = try SQLiteWorkProbe.opening { try XCTUnwrap(store) }.1
        try store!.configure(owner)
        try store!.append(deviceId: "a", samplesByStream: [.realtime: samples([1])])
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples"), 1)

        // Exactly the writes a previous binary performed for an owner change.
        try probe.executeFixture("""
            BEGIN IMMEDIATE;
            DELETE FROM samples;
            DELETE FROM batches;
            UPDATE stats SET received = 0, confirmed = 0, erased = 0, cleared = 0, lastConfirmed = NULL;
            INSERT OR REPLACE INTO metadata VALUES ('binding', '{"userId":"bob","serverURL":"https://example.com"}');
            INSERT OR REPLACE INTO metadata VALUES ('generation', 'legacy-generation');
            COMMIT;
            """)
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples"), 0)
        store = nil

        let reopened = try WhoopBleSampleStore(directory: url)
        XCTAssertEqual(try reopened.binding, WhoopUploadBinding(userId: "bob", serverURL: "https://example.com"))
        XCTAssertEqual(try reopened.generation, "legacy-generation")
        XCTAssertEqual(try reopened.queuedCount(stream: .realtime, limit: Int.max), 0)
        XCTAssertNil(try reopened.reserve(stream: .realtime))
    }

    /// A previous binary advanced the cutoff without knowing about the inbox.
    /// Reopen must reconcile a staged row that straddles the persisted cutoff.
    func testReopenAppliesLegacyCutoffToStagedStraddlingRow() throws {
        let url = try directory()
        var store: WhoopBleSampleStore? = try WhoopBleSampleStore(directory: url)
        let probe = try SQLiteWorkProbe.opening { try XCTUnwrap(store) }.1
        try store!.configure(owner)
        try store!.append(deviceId: "a", samplesByStream: [.realtime: samples([1, 3])])
        let cutoff = ISO8601DateFormatter().date(from: "2026-10-28T00:00:02Z")!
        try probe.executeFixture("""
            BEGIN IMMEDIATE;
            INSERT OR REPLACE INTO metadata VALUES ('cutoff', '\(cutoff.timeIntervalSince1970)');
            UPDATE stats SET erased = erased +
                (SELECT COUNT(*) FROM samples WHERE stream = 'realtime' AND timestamp <= \(cutoff.timeIntervalSince1970))
                WHERE stream = 'realtime';
            DELETE FROM samples WHERE timestamp <= \(cutoff.timeIntervalSince1970);
            COMMIT;
            """)
        store = nil

        let reopened = try WhoopBleSampleStore(directory: url)
        XCTAssertEqual(try reopened.queuedCount(stream: .realtime, limit: Int.max), 1)
        let stats = try reopened.statistics(stream: .realtime)
        XCTAssertEqual(stats["receivedCount"] as? Int, 2)
        XCTAssertEqual(stats["erasureDiscardedCount"] as? Int, 1)
        XCTAssertEqual(stats["oldestTimestamp"] as? String, "2026-10-28T00:00:03.000Z")
        XCTAssertEqual(stats["newestTimestamp"] as? String, "2026-10-28T00:00:03.000Z")
        let batch = try XCTUnwrap(reopened.reserve(stream: .realtime))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: batch.body) as? [String: Any])
        let payloads = try XCTUnwrap(body["samples"] as? [[String: Any]])
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(payloads.first?["timestamp"] as? String, "2026-10-28T00:00:03.000Z")
    }

    func testUpgradeFromLegacySchemaPreservesPendingBatch() throws {
        let url = try directory()
        var store: WhoopBleSampleStore? = try WhoopBleSampleStore(directory: url)
        let probe = try SQLiteWorkProbe.opening { try XCTUnwrap(store) }.1
        try store!.configure(owner)
        try store!.append(deviceId: "a", samplesByStream: [.realtime: samples([1, 2])])
        let batch = try XCTUnwrap(store!.reserve(stream: .realtime))
        try probe.executeFixture("""
            DROP TRIGGER IF EXISTS incoming_samples_clear_on_generation;
            DROP TABLE incoming_samples;
            """)
        store = nil

        let reopened = try WhoopBleSampleStore(directory: url)
        let reopenedProbe = try SQLiteWorkProbe.opening { reopened }.1
        XCTAssertEqual(try reopenedProbe.integer("""
            SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'
                AND name = 'incoming_samples_clear_on_generation'
            """), 1)
        let recovered = try XCTUnwrap(reopened.reserve(stream: .realtime))
        XCTAssertEqual(recovered.id, batch.id)
        XCTAssertEqual(recovered.body, batch.body)
        XCTAssertEqual(try reopened.queuedCount(stream: .realtime, limit: Int.max), 2)
    }

    /// A valid reserved retry and a nonpositive limit must not touch the inbox.
    func testExistingReservationBypassesUnreadableInbox() throws {
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory()) }
        try store.configure(owner)
        try store.append(deviceId: "a", samplesByStream: [.realtime: samples([1])])
        let batch = try XCTUnwrap(store.reserve(stream: .realtime))
        try probe.executeFixture("DROP TABLE incoming_samples")

        let retry = try XCTUnwrap(store.reserve(stream: .realtime))
        XCTAssertEqual(retry.id, batch.id)
        XCTAssertEqual(retry.body, batch.body)
        XCTAssertNil(try store.reserve(stream: .imu, limit: 0))
    }

    /// Whole-account erase must cover a malformed chunk without decompressing it.
    func testWholeEraseIgnoresMalformedInboxPayload() throws {
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory()) }
        try store.configure(owner)
        try store.append(deviceId: "a", samplesByStream: [.realtime: samples([1])])
        try probe.executeFixture("UPDATE incoming_samples SET payload = X'00010203'")

        let cutoff = ISO8601DateFormatter().date(from: "2026-10-28T00:00:02Z")!
        try store.advanceErasureCutoff(to: cutoff, discardInbox: true)

        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples"), 0)
        XCTAssertEqual(try store.statistics(stream: .realtime)["receivedCount"] as? Int, 1)
        XCTAssertEqual(try store.statistics(stream: .realtime)["erasureDiscardedCount"] as? Int, 1)
        XCTAssertEqual(try store.queuedCount(stream: .realtime, limit: Int.max), 0)
        XCTAssertEqual(try probe.integer("SELECT value FROM metadata WHERE key = 'cutoff'"), Int(cutoff.timeIntervalSince1970))
    }

    /// The original cold-start finding: a corrupt staged chunk straddling the
    /// persisted cutoff blocks ordinary reopen, but the cleanup-only store and
    /// uploader purge it without decoding and leave the cutoff protecting later data.
    func testColdCorruptStraddlingChunkPurgesWithoutDecoding() throws {
        let url = try directory()
        var store: WhoopBleSampleStore? = try WhoopBleSampleStore(directory: url)
        let probe = try SQLiteWorkProbe.opening { try XCTUnwrap(store) }.1
        try store!.configure(WhoopUploadBinding(userId: "alice", serverURL: "https://example.com"))
        try store!.append(deviceId: "a", samplesByStream: [.realtime: samples([1, 3])])
        let cutoff = ISO8601DateFormatter().date(from: "2026-10-28T00:00:02Z")!
        try probe.executeFixture("""
            BEGIN IMMEDIATE;
            UPDATE incoming_samples SET payload = X'00010203';
            INSERT OR REPLACE INTO metadata VALUES ('cutoff', '\(cutoff.timeIntervalSince1970)');
            COMMIT;
            """)
        store = nil

        XCTAssertThrowsError(try WhoopBleSampleStore(directory: url)) { error in
            XCTAssertEqual(
                (error as? WhoopBleSampleStore.StoreError)?.errorDescription,
                "WHOOP inbox payload could not be decompressed"
            )
        }

        let bootstrap = WhoopBleUploadBootstrap(
            makeUploader: {
                XCTFail("Cold cleanup must not create a normal uploader")
                throw NSError(domain: "WhoopInboxFence", code: 1)
            },
            reportError: { XCTFail("Unexpected bootstrap error: \($0)") }
        )
        try bootstrap.withUploaderForCleanup(
            makeCleanupUploader: {
                let coldStore = try WhoopBleSampleStore(directory: url, skipInboxCutoffReconciliation: true)
                return try WhoopBleBackgroundUploader(
                    store: coldStore,
                    directory: url.appendingPathComponent("bodies"),
                    transport: TestWhoopUploadTransport(),
                    reportError: { XCTFail("Unexpected uploader error: \($0)") },
                    skipStartupInboxIndexing: true
                )
            },
            operation: { uploader in try uploader.purge(cutoff: cutoff) }
        )

        let reopened = try WhoopBleSampleStore(directory: url)
        XCTAssertNil(try reopened.binding)
        let reopenedProbe = try SQLiteWorkProbe.opening { reopened }.1
        XCTAssertEqual(try reopenedProbe.integer("SELECT COUNT(*) FROM incoming_samples"), 0)

        try reopened.configure(WhoopUploadBinding(userId: "bob", serverURL: "https://example.com"))
        try reopened.append(deviceId: "a", samplesByStream: [.realtime: samples([1, 3])])
        XCTAssertEqual(try reopenedProbe.integer("SELECT COUNT(*) FROM incoming_samples"), 1)
        XCTAssertEqual(try reopenedProbe.integer("SELECT count FROM incoming_samples"), 1)
        XCTAssertEqual(try reopened.queuedCount(stream: .realtime, limit: Int.max), 1)
        let stats = try reopened.statistics(stream: .realtime)
        XCTAssertEqual(stats["oldestTimestamp"] as? String, "2026-10-28T00:00:03.000Z")
        XCTAssertEqual(stats["newestTimestamp"] as? String, "2026-10-28T00:00:03.000Z")
        XCTAssertEqual(stats["erasureDiscardedCount"] as? Int, 1)
    }
}
