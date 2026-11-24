import XCTest
@testable import WhoopBLE

extension WhoopBleSampleStoreTests {
    func testAutomaticCheckpointRetainsFourMegabyteTarget() throws {
        let url = try directory()
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: url) }
        defer { withExtendedLifetime(store) {} }
        try probe.executeFixture("CREATE TABLE checkpoint_probe(payload BLOB NOT NULL)")
        try probe.executeFixture("PRAGMA wal_checkpoint(TRUNCATE)")
        let databasePath = url.appendingPathComponent("samples.sqlite")
        let initialSize = try Data(contentsOf: databasePath).count

        try probe.executeFixture("INSERT INTO checkpoint_probe VALUES (zeroblob(2 * 1024 * 1024))")
        XCTAssertEqual(try Data(contentsOf: databasePath).count, initialSize, "2 MiB should stay in the WAL")

        try probe.executeFixture("INSERT INTO checkpoint_probe VALUES (zeroblob(3 * 1024 * 1024))")
        XCTAssertGreaterThan(try Data(contentsOf: databasePath).count, 5 * 1024 * 1024)
    }

    func testFreshQueueWritesFewerWALBytesPerNotification() throws {
        let currentDirectory = try directory()
        let legacyDirectory = try directory()
        let (current, currentProbe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: currentDirectory) }
        let (legacy, legacyProbe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: legacyDirectory) }
        try setFixturePageSize(4096, probe: legacyProbe)
        for (store, probe) in [(current, currentProbe), (legacy, legacyProbe)] {
            try store.configure(owner)
            try probe.executeFixture("PRAGMA wal_checkpoint(TRUNCATE)")
            for second in 1...20 {
                let realtime = samples([second])
                var record = realtime[0]
                record["frameHex"] = String(repeating: "a1", count: 124)
                try store.append(deviceId: "watch", samplesByStream: [.sensorRecords: [record], .realtime: realtime])
            }
            XCTAssertEqual(try store.queuedCount(stream: .sensorRecords), 20)
            XCTAssertEqual(try store.queuedCount(stream: .realtime), 20)
        }

        let currentBytes = try walBytes(directory: currentDirectory)
        let legacyBytes = try walBytes(directory: legacyDirectory)
        XCTAssertLessThan(currentBytes, legacyBytes * 6 / 10)
    }

    func testPageUpgradePreservesPendingBatchesAndErasureState() throws {
        let url = try directory()
        let batch = try seedPageUpgradeFixture(directory: url)
        try assertUpgradedQueue(directory: url, originalBatch: batch)
    }

    func testPageUpgradeResumesFromRollbackJournalOnEitherSideOfRebuild() throws {
        for pageSize in [4096, 1024] {
            let url = try directory()
            let batch = try seedPageUpgradeFixture(directory: url, pageSize: pageSize, journalMode: "DELETE")
            try assertUpgradedQueue(directory: url, originalBatch: batch)
        }
    }

    func testPageUpgradeRetriesAfterReaderReleasesLegacyWAL() throws {
        let url = try directory()
        let batch = try seedPageUpgradeFixture(directory: url)
        try SQLiteWorkProbe.withReadSnapshot(directory: url) {
            XCTAssertThrowsError(try WhoopBleSampleStore(directory: url))
        }
        try assertUpgradedQueue(directory: url, originalBatch: batch)
    }

    private func seedPageUpgradeFixture(
        directory: URL,
        pageSize: Int = 4096,
        journalMode: String = "WAL"
    ) throws -> WhoopStoredBatch {
        var store: WhoopBleSampleStore? = try WhoopBleSampleStore(directory: directory)
        let probe = try SQLiteWorkProbe.opening { try XCTUnwrap(store) }.1
        try setFixturePageSize(pageSize, probe: probe, journalMode: journalMode)
        try XCTUnwrap(store).configure(owner)
        let cutoff = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-28T00:00:02Z"))
        try XCTUnwrap(store).advanceErasureCutoff(to: cutoff)

        guard journalMode == "WAL" else { return try captureFixtureSamples(in: XCTUnwrap(store)) }
        try probe.executeFixture("PRAGMA wal_checkpoint(TRUNCATE)")
        let databasePath = directory.appendingPathComponent("samples.sqlite")
        let checkpointed = try Data(contentsOf: databasePath)
        // Keep a read-only snapshot of the empty queue until the writer closes.
        // Closing the last writable connection cannot checkpoint past the reader.
        let batch = try SQLiteWorkProbe.withReadSnapshot(directory: directory) {
            let batch = try captureFixtureSamples(in: XCTUnwrap(store))
            store = nil
            return batch
        }
        XCTAssertEqual(try Data(contentsOf: databasePath), checkpointed)
        XCTAssertGreaterThan(try walBytes(directory: directory), 32)
        return batch
    }

    private func captureFixtureSamples(in store: WhoopBleSampleStore) throws -> WhoopStoredBatch {
        try store.append(deviceId: "watch", samplesByStream: [.realtime: samples([1, 3, 4])])
        return try XCTUnwrap(store.reserve(stream: .realtime, limit: 1))
    }

    private func assertUpgradedQueue(directory: URL, originalBatch: WhoopStoredBatch) throws {
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory) }
        XCTAssertEqual(try probe.integer("PRAGMA page_size"), 1024)
        XCTAssertEqual(try store.rows("PRAGMA journal_mode").first?["journal_mode"] as? String, "wal")
        XCTAssertEqual(try probe.integer("PRAGMA synchronous"), 2)
        XCTAssertEqual(try store.binding, owner)
        XCTAssertEqual(try store.generation, originalBatch.generation)
        let recovered = try XCTUnwrap(store.reserve(stream: .realtime))
        XCTAssertEqual(recovered.id, originalBatch.id)
        XCTAssertEqual(recovered.body, originalBatch.body)
        XCTAssertTrue(try store.acknowledge(id: recovered.id, generation: recovered.generation))
        XCTAssertEqual(try store.queuedCount(stream: .realtime), 1)
        try store.append(deviceId: "watch", samplesByStream: [.realtime: samples([2])])
        XCTAssertEqual(try store.queuedCount(stream: .realtime), 1)
        XCTAssertEqual(try store.statistics(stream: .realtime)["receivedCount"] as? Int, 4)
        XCTAssertEqual(try store.statistics(stream: .realtime)["erasureDiscardedCount"] as? Int, 2)
        let remaining = try XCTUnwrap(store.reserve(stream: .realtime))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: remaining.body) as? [String: Any])
        let samples = try XCTUnwrap(body["samples"] as? [[String: Any]])
        XCTAssertEqual(samples.count, 1)
        XCTAssertEqual(samples.first?["timestamp"] as? String, "2026-10-28T00:00:04.000Z")
    }

    private func setFixturePageSize(_ size: Int, probe: SQLiteWorkProbe, journalMode: String = "WAL") throws {
        try probe.executeFixture("PRAGMA journal_mode = DELETE; PRAGMA page_size = \(size); VACUUM; PRAGMA journal_mode = \(journalMode)")
        XCTAssertEqual(try probe.integer("PRAGMA page_size"), size)
    }

    private func walBytes(directory: URL) throws -> Int {
        let wal = directory.appendingPathComponent("samples.sqlite-wal")
        return try XCTUnwrap(wal.resourceValues(forKeys: [.fileSizeKey]).fileSize)
    }
}
