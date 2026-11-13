import XCTest
import SQLite3
@testable import WhoopBLE

extension WhoopBleSampleStoreTests {
    func testPurgeRestoresExactSecureDeleteModeOnSuccessAndRollback() throws {
        for (setting, expected) in [("OFF", 0), ("ON", 1), ("FAST", 2)] {
            for fails in [false, true] {
                let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory()) }
                try store.configure(owner)
                try store.append(deviceId: "a", samplesByStream: [.realtime: samples([3])])
                try probe.executeFixture("PRAGMA secure_delete = \(setting)")
                if fails {
                    try probe.executeFixture("""
                        CREATE TRIGGER reject_purge BEFORE DELETE ON samples
                        BEGIN SELECT RAISE(ABORT, 'purge rejected'); END
                        """)
                    XCTAssertThrowsError(try store.purge())
                    XCTAssertEqual(try store.binding, owner)
                    XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM metadata WHERE key = 'purge_pending'"), 0)
                } else {
                    try store.purge()
                }
                XCTAssertEqual(try probe.integer("PRAGMA secure_delete"), expected, "\(setting), failure=\(fails)")
            }
        }
    }

    func testFailedSecureDeleteRestorationBlocksWritesUntilRetryRestoresOriginalMode() throws {
        for (setting, expected) in [("OFF", 0), ("ON", 1)] {
            let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory()) }
            try store.configure(owner)
            try store.append(deviceId: "a", samplesByStream: [.realtime: samples([3])])
            let generation = try store.generation
            try probe.executeFixture("PRAGMA secure_delete = \(setting)")
            try probe.withDeniedSecureDeleteRestoration {
                XCTAssertThrowsError(try store.purge())
                XCTAssertEqual(try store.binding, owner)
                XCTAssertEqual(try store.generation, generation)
                XCTAssertEqual(try store.queuedCount(stream: .realtime), 1)
                XCTAssertThrowsError(try store.configure(WhoopUploadBinding(userId: "bob", serverURL: owner.serverURL)))
            }
            try store.purge()
            XCTAssertEqual(try probe.integer("PRAGMA secure_delete"), expected)
        }
    }

    func testFailedVacuumRemainsPendingAndBlocksAccountReplacementUntilRetry() throws {
        let url = try directory()
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: url) }
        try store.configure(owner)
        let cutoff = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-28T00:00:02Z"))
        try store.advanceErasureCutoff(to: cutoff)
        try seedPersistedSamples(1_000, stream: .realtime, second: 3, probe: probe)
        let old = try XCTUnwrap(store.reserve(stream: .realtime))
        try probe.executeFixture("PRAGMA secure_delete = ON; PRAGMA wal_checkpoint(TRUNCATE)")
        try probe.withDeniedVacuum {
            XCTAssertThrowsError(try store.purge())
            XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM metadata WHERE key = 'purge_pending'"), 1)
            XCTAssertGreaterThan(try probe.integer("PRAGMA freelist_count"), 0)
            XCTAssertThrowsError(try store.configure(WhoopUploadBinding(userId: "bob", serverURL: owner.serverURL)))
        }
        let purgedGeneration = try store.generation
        XCTAssertNotEqual(purgedGeneration, old.generation)
        try store.purge()
        XCTAssertEqual(try store.generation, purgedGeneration)
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM metadata WHERE key = 'purge_pending'"), 0)
        XCTAssertEqual(try probe.integer("PRAGMA freelist_count"), 0)
        XCTAssertFalse(try store.acknowledge(id: old.id, generation: old.generation))
        let reopened = try WhoopBleSampleStore(directory: url)
        try reopened.configure(WhoopUploadBinding(userId: "bob", serverURL: owner.serverURL))
        try reopened.append(deviceId: "a", samplesByStream: [.realtime: samples([1, 3])])
        XCTAssertEqual(try reopened.queuedCount(stream: .realtime), 1)
        XCTAssertEqual(try reopened.statistics(stream: .realtime)["erasureDiscardedCount"] as? Int, 1)
    }

    func testPendingPurgeMustFinishCheckpointBeforeStoreCanReopen() throws {
        let url = try directory()
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: url) }
        try store.configure(owner)
        try seedPersistedSamples(1_000, stream: .realtime, second: 3, probe: probe)
        try probe.executeFixture("PRAGMA secure_delete = ON; PRAGMA wal_checkpoint(TRUNCATE)")
        let generation = try store.generation
        try SQLiteWorkProbe.withReadSnapshot(directory: url) {
            XCTAssertThrowsError(try store.purge())
            XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM metadata WHERE key = 'purge_pending'"), 1)
            XCTAssertThrowsError(try WhoopBleSampleStore(directory: url))
        }
        let (reopened, recoveredProbe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: url) }
        XCTAssertNil(try reopened.binding)
        XCTAssertNotEqual(try reopened.generation, generation)
        XCTAssertEqual(try recoveredProbe.integer("SELECT COUNT(*) FROM metadata WHERE key = 'purge_pending'"), 0)
        XCTAssertEqual(try recoveredProbe.integer("PRAGMA freelist_count"), 0)
        XCTAssertEqual(try reopened.queuedCount(stream: .realtime), 0)
        let payloadMarker = Data("heartRateBpm".utf8)
        for name in ["samples.sqlite", "samples.sqlite-wal"] {
            let path = url.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: path.path) {
                XCTAssertNil(try Data(contentsOf: path).range(of: payloadMarker))
            }
        }
    }

    func testPurgeWritesFewPagesAndLeavesNoFreedPagesUnderSecureDelete() throws {
        let url = try directory()
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: url) }
        try store.configure(owner)
        try probe.executeFixture("PRAGMA secure_delete = ON")
        for stream in WhoopUploadStream.allCases {
            try seedPersistedSamples(10_000, stream: stream, second: 3, probe: probe)
            XCTAssertNotNil(try store.reserve(stream: stream))
        }
        try probe.executeFixture("PRAGMA wal_checkpoint(TRUNCATE)")
        let pages = try probe.integer("PRAGMA page_count")
        let pageSize = try probe.integer("PRAGMA page_size")
        let before = probe.cacheWrites

        try store.purge()

        XCTAssertLessThan((probe.cacheWrites - before) * 10, pages)
        XCTAssertEqual(try probe.integer("PRAGMA freelist_count"), 0)
        XCTAssertLessThan(try probe.integer("PRAGMA page_count") * 10, pages)
        XCTAssertEqual(try probe.integer("PRAGMA secure_delete"), 1)
        let file = try FileManager.default.attributesOfItem(atPath: url.appendingPathComponent("samples.sqlite").path)
        XCTAssertLessThan(try XCTUnwrap(file[.size] as? Int) * 10, pages * pageSize)
    }

    func testPurgeIdentifiesFailedSqliteOperationAndRollsBackTheStore() throws {
        let failures = [
            ("""
            CREATE TRIGGER reject_sample_delete BEFORE DELETE ON samples
            BEGIN SELECT RAISE(ABORT, 'purge fixture rejected delete'); END;
            """, "store_delete_samples", "purge fixture rejected delete"),
            ("""
            PRAGMA foreign_keys = ON;
            CREATE TABLE purge_commit_guard (
                stream TEXT REFERENCES stats(stream) DEFERRABLE INITIALLY DEFERRED);
            CREATE TRIGGER reject_purge_commit AFTER DELETE ON samples
            BEGIN INSERT INTO purge_commit_guard VALUES ('missing'); END;
            """, "store_commit", "FOREIGN KEY constraint failed"),
        ]
        for (fixture, failedStage, message) in failures {
            let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory()) }
            try store.configure(owner)
            try store.append(deviceId: "a", samplesByStream: [.realtime: samples([1])])
            let binding = try store.binding
            let generation = try store.generation
            try probe.executeFixture(fixture)
            let stages = CleanupStageRecorder()

            XCTAssertThrowsError(try store.purge(onStage: stages.append)) { error in
                XCTAssertTrue(error.localizedDescription.contains(message))
            }

            XCTAssertEqual(stages.snapshot.last, failedStage)
            XCTAssertFalse(stages.snapshot.contains("store_completed"))
            XCTAssertEqual(try store.binding, binding)
            XCTAssertEqual(try store.generation, generation)
            XCTAssertEqual(try store.queuedCount(stream: .realtime), 1)
            XCTAssertEqual(try store.statistics(stream: .realtime)["receivedCount"] as? Int, 1)
            XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM samples"), 1)
        }
    }
}
