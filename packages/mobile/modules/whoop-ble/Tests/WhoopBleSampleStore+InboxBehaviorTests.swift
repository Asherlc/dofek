import XCTest
@testable import WhoopBLE

extension WhoopBleSampleStoreTests {
    func testStagedRowsSurviveReopenAndAppearInSnapshotsBeforeIndexing() throws {
        let url = try directory()
        var store: WhoopBleSampleStore? = try WhoopBleSampleStore(directory: url)
        try store!.configure(owner)
        try store!.append(deviceId: "a", samplesByStream: [.realtime: samples([1, 3]), .imu: samples([2])])
        store = nil

        let reopened = try WhoopBleSampleStore(directory: url)
        let stats = try reopened.statistics(stream: .realtime)
        XCTAssertEqual(stats["count"] as? Int, 2)
        XCTAssertEqual(stats["receivedCount"] as? Int, 2)
        XCTAssertEqual(stats["oldestTimestamp"] as? String, "2026-10-28T00:00:01.000Z")
        XCTAssertEqual(stats["newestTimestamp"] as? String, "2026-10-28T00:00:03.000Z")
        XCTAssertEqual(try reopened.queuedCount(stream: .realtime), 2)

        let batch = try XCTUnwrap(reopened.reserve(stream: .realtime))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: batch.body) as? [String: Any])
        let payloads = try XCTUnwrap(body["samples"] as? [[String: Any]])
        XCTAssertEqual(payloads.count, 2)
        XCTAssertEqual(payloads.first?["timestamp"] as? String, "2026-10-28T00:00:01.000Z")
        XCTAssertEqual(try reopened.statistics(stream: .imu)["count"] as? Int, 1)
    }

    func testErasureCutoffCoversStagedAndIndexedRowsAtomically() throws {
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory()) }
        try store.configure(owner)
        try store.append(deviceId: "a", samplesByStream: [.realtime: samples([1])])
        try store.drainInbox()
        try store.append(deviceId: "a", samplesByStream: [.realtime: samples([2, 4])])
        try store.advanceErasureCutoff(to: XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-28T00:00:02Z")))

        XCTAssertEqual(try store.queuedCount(stream: .realtime, limit: Int.max), 1)
        let stats = try store.statistics(stream: .realtime)
        XCTAssertEqual(stats["receivedCount"] as? Int, 3)
        XCTAssertEqual(stats["erasureDiscardedCount"] as? Int, 2)
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM samples"), 0)
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples"), 1)

        let batch = try XCTUnwrap(store.reserve(stream: .realtime))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: batch.body) as? [String: Any])
        let payloads = try XCTUnwrap(body["samples"] as? [[String: Any]])
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(payloads.first?["timestamp"] as? String, "2026-10-28T00:00:04.000Z")
    }

    func testOwnerChangeAndPurgeClearStagedRowsWithoutLeakingCounts() throws {
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory()) }
        try store.configure(owner)
        try store.append(deviceId: "a", samplesByStream: [.realtime: samples([1, 2])])
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples"), 1)

        try store.configure(WhoopUploadBinding(userId: "bob", serverURL: owner.serverURL))
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples"), 0)
        XCTAssertEqual(try store.queuedCount(stream: .realtime, limit: Int.max), 0)
        XCTAssertEqual(try store.statistics(stream: .realtime)["receivedCount"] as? Int, 0)
        XCTAssertEqual(try store.statistics(stream: .realtime)["erasureDiscardedCount"] as? Int, 0)

        try store.append(deviceId: "a", samplesByStream: [.realtime: samples([3])])
        try store.purge()
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples"), 0)
        XCTAssertNil(try store.binding)
        XCTAssertEqual(try store.queuedCount(stream: .realtime, limit: Int.max), 0)
        XCTAssertEqual(try store.statistics(stream: .realtime)["receivedCount"] as? Int, 0)
    }

    func testFailedPromotionRollsBackAndRetriesWithoutDuplicates() throws {
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory()) }
        try store.configure(owner)
        try store.append(deviceId: "a", samplesByStream: [.realtime: samples([1, 2])])
        try probe.executeFixture("""
            CREATE TRIGGER reject_index BEFORE INSERT ON samples
            BEGIN SELECT RAISE(ABORT, 'index rejected'); END
            """)
        XCTAssertThrowsError(try store.drainInbox())
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM samples"), 0)
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples"), 1)
        XCTAssertEqual(try store.queuedCount(stream: .realtime, limit: Int.max), 2)

        try probe.executeFixture("DROP TRIGGER reject_index")
        XCTAssertTrue(try store.drainInbox())
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM samples"), 2)
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples"), 0)
        XCTAssertFalse(try store.drainInbox())
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM samples"), 2)
        XCTAssertEqual(try XCTUnwrap(store.reserve(stream: .realtime)).sampleCount, 2)
    }

    func testReserveDrainsStagedRowsAfterExistingQueuedRows() throws {
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory()) }
        try store.configure(owner)
        try store.append(deviceId: "a", samplesByStream: [.realtime: samples([9])])
        XCTAssertTrue(try store.drainInbox())
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples"), 0)

        try store.append(deviceId: "a", samplesByStream: [.realtime: samples([1, 2])])
        let existing = try XCTUnwrap(store.reserve(stream: .realtime, limit: 1))
        let existingBody = try XCTUnwrap(JSONSerialization.jsonObject(with: existing.body) as? [String: Any])
        let existingPayloads = try XCTUnwrap(existingBody["samples"] as? [[String: Any]])
        XCTAssertEqual(existingPayloads.count, 1)
        XCTAssertEqual(existingPayloads.first?["timestamp"] as? String, "2026-10-28T00:00:09.000Z")
        XCTAssertTrue(try store.acknowledge(id: existing.id, generation: existing.generation))

        let next = try XCTUnwrap(store.reserve(stream: .realtime, limit: 1))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: next.body) as? [String: Any])
        let payloads = try XCTUnwrap(body["samples"] as? [[String: Any]])
        XCTAssertEqual(payloads.first?["timestamp"] as? String, "2026-10-28T00:00:01.000Z")
        // Reservations do not retire rows; queued counts remain lifecycle counters.
        XCTAssertEqual(try store.queuedCount(stream: .realtime, limit: Int.max), 2)
    }

    /// One erasure pass must cover several whole chunks and rewrite several
    /// straddling chunks in rowid order, without losing their capture order.
    func testErasureCutoffHandlesMultipleCoveredAndStraddlingChunks() throws {
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory()) }
        try store.configure(owner)
        for second in [1, 2] { try store.append(deviceId: "a", samplesByStream: [.realtime: samples([second])]) }
        for seconds in [[1, 4], [2, 5], [6]] {
            try store.append(deviceId: "a", samplesByStream: [.realtime: samples(seconds)])
        }
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples"), 5)

        try store.advanceErasureCutoff(to: XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-28T00:00:03Z")))

        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM incoming_samples"), 3)
        let stats = try store.statistics(stream: .realtime)
        XCTAssertEqual(stats["receivedCount"] as? Int, 7)
        XCTAssertEqual(stats["erasureDiscardedCount"] as? Int, 4)
        XCTAssertEqual(stats["oldestTimestamp"] as? String, "2026-10-28T00:00:04.000Z")
        XCTAssertEqual(stats["newestTimestamp"] as? String, "2026-10-28T00:00:06.000Z")
        XCTAssertEqual(try store.queuedCount(stream: .realtime, limit: Int.max), 3)

        XCTAssertTrue(try store.drainInbox())
        let batch = try XCTUnwrap(store.reserve(stream: .realtime, limit: 3))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: batch.body) as? [String: Any])
        let payloads = try XCTUnwrap(body["samples"] as? [[String: Any]])
        XCTAssertEqual(payloads.map { $0["timestamp"] as? String }, [
            "2026-10-28T00:00:04.000Z", "2026-10-28T00:00:05.000Z", "2026-10-28T00:00:06.000Z",
        ])
    }
}
