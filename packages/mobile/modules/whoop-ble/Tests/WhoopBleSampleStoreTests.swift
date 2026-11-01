import XCTest
import SQLite3
@testable import WhoopBLE

final class WhoopBleSampleStoreTests: XCTestCase {
    func testUnknownRecordMarkerDoesNotAcquireAnUnverifiedErasureClock() throws {
        let store = try WhoopBleSampleStore(directory: directory())
        try store.configure(owner)
        try store.advanceErasureCutoff(to: XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-28T00:00:00Z")))
        var bytes = try capturedWhoopR18Data()
        bytes[10] = 0x81
        let crc = WhoopBleFrameParser.crc32ieee(Data(bytes[8..<(bytes.count - 4)]))
        for index in 0..<4 { bytes[bytes.count - 4 + index] = UInt8(truncatingIfNeeded: crc >> (index * 8)) }
        let frame = try XCTUnwrap(WhoopBleFrameParser.parseFrame(bytes))
        let record = try XCTUnwrap(WhoopBleSensorRecord.serialize(
            frame: frame, deviceInfo: [:], receivedAt: Date(timeIntervalSince1970: 1_800_000_000)))
        try store.append(stream: .sensorRecords, deviceId: "a", samples: [record])
        XCTAssertEqual(try store.queuedCount(stream: .sensorRecords), 1)
    }
    func testLateHistoricalTemperatureCannotResurrectDataBeforeErasure() throws {
        let store = try WhoopBleSampleStore(directory: directory())
        try store.configure(owner)
        try store.advanceErasureCutoff(to: XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-28T00:00:00Z")))
        let frame = try XCTUnwrap(WhoopBleFrameParser.parseFrame(capturedWhoopR18Data()))
        let record = try XCTUnwrap(WhoopBleSensorRecord.serialize(
            frame: frame, deviceInfo: [:], receivedAt: Date(timeIntervalSince1970: 1_800_000_000)))
        try store.append(stream: .sensorRecords, deviceId: "a", samples: [record])
        XCTAssertEqual(try store.queuedCount(stream: .sensorRecords), 0)
        XCTAssertEqual(try store.statistics(stream: .sensorRecords)["erasureDiscardedCount"] as? Int, 1)
    }
    func testSensorRecordsSurviveReopenWithBoundedBodiesAndExactIdentity() throws {
        let url = try directory()
        var store: WhoopBleSampleStore? = try WhoopBleSampleStore(directory: url)
        try store!.configure(owner)
        let captureId = UUID().uuidString
        let sensor: [String: Any] = [
            "captureId": captureId, "timestamp": "2026-10-28T00:00:03.000Z",
            "frameHex": String(repeating: "aa", count: 40_000), "deviceInfo": [:],
        ]
        try store!.append(stream: .sensorRecords, deviceId: "a", samples: Array(repeating: sensor, count: 4))
        let batch = try XCTUnwrap(store!.reserve(stream: .sensorRecords))
        XCTAssertEqual(batch.sampleCount, 3)
        XCTAssertLessThanOrEqual(batch.body.count, 262_144)
        store = nil
        let reopened = try WhoopBleSampleStore(directory: url)
        let recovered = try XCTUnwrap(reopened.reserve(stream: .sensorRecords))
        XCTAssertEqual(recovered.body, batch.body)
        let input = try XCTUnwrap(JSONSerialization.jsonObject(with: recovered.body) as? [String: Any])
        XCTAssertEqual((input["samples"] as? [[String: Any]])?.first?["captureId"] as? String, captureId)
        XCTAssertTrue(try reopened.acknowledge(id: batch.id, generation: batch.generation))
        XCTAssertEqual(try reopened.queuedCount(stream: .sensorRecords), 1)
    }

    func testSensorRecordsFollowAccountErasureAndRejectLateAcknowledgments() throws {
        let store = try WhoopBleSampleStore(directory: directory())
        try store.configure(owner)
        try store.append(stream: .sensorRecords, deviceId: "a", samples: samples([1]))
        let old = try XCTUnwrap(store.reserve(stream: .sensorRecords))
        try store.advanceErasureCutoff(to: XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-28T00:00:02Z")))
        XCTAssertEqual(try store.queuedCount(stream: .sensorRecords), 0)
        try store.configure(WhoopUploadBinding(userId: "bob", serverURL: owner.serverURL))
        XCTAssertFalse(try store.acknowledge(id: old.id, generation: old.generation))
        XCTAssertEqual(try store.queuedCount(stream: .sensorRecords), 0)
    }
    private let owner = WhoopUploadBinding(userId: "alice", serverURL: "https://example.com")
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try FileManager.default.removeItem(at: url) }
        return url
    }
    private func samples(_ seconds: [Int]) -> [[String: Any]] {
        seconds.map { ["timestamp": String(format: "2026-10-28T00:00:%02d.000Z", $0), "heartRateBpm": 70] }
    }

    private func seedPersistedSamples(_ count: Int, stream: WhoopUploadStream, second: Int, probe: SQLiteWorkProbe) throws {
        let sample = samples([second])[0]
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let timestamp = try XCTUnwrap(formatter.date(from: XCTUnwrap(sample["timestamp"] as? String)))
        let payload = try JSONSerialization.data(withJSONObject: sample, options: [.sortedKeys])
            .map { String(format: "%02x", $0) }.joined()
        // Restore a real persisted backlog without replaying its ingestion in
        // every query test and every isolated mutation. Public append is tested separately.
        try probe.executeFixture("""
            BEGIN IMMEDIATE;
            WITH RECURSIVE sequence(value) AS (
                VALUES(1) UNION ALL SELECT value + 1 FROM sequence LIMIT \(count)
            )
            INSERT INTO samples(stream, device, timestamp, payload)
                SELECT '\(stream.rawValue)', 'a', \(timestamp.timeIntervalSince1970), X'\(payload)' FROM sequence;
            UPDATE stats SET received = received + \(count) WHERE stream = '\(stream.rawValue)';
            COMMIT;
            """)
    }

    func testStoreDirectoryIsExcludedFromBackup() throws {
        let url = try directory()
        let store = try WhoopBleSampleStore(directory: url)
        try store.configure(owner)
        XCTAssertEqual(try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    func testAcknowledgmentRequiresExactIdentityAmongActiveBatches() throws {
        let store = try WhoopBleSampleStore(directory: directory())
        try store.configure(owner)
        try store.append(stream: .realtime, deviceId: "a", samples: samples([1, 2]))
        try store.append(stream: .imu, deviceId: "a", samples: samples([3]))
        let realtime = try XCTUnwrap(store.reserve(stream: .realtime))
        let imu = try XCTUnwrap(store.reserve(stream: .imu))
        XCTAssertFalse(try store.acknowledge(id: "unknown-batch", generation: imu.generation))
        XCTAssertEqual(try store.statistics(stream: .realtime)["confirmedCount"] as? Int, 0)
        XCTAssertEqual(try store.statistics(stream: .imu)["confirmedCount"] as? Int, 0)
        XCTAssertTrue(try store.acknowledge(id: realtime.id, generation: realtime.generation))
        XCTAssertEqual(try store.statistics(stream: .realtime)["confirmedCount"] as? Int, 2)
        XCTAssertEqual(try store.statistics(stream: .imu)["count"] as? Int, 1)
        XCTAssertTrue(try store.acknowledge(id: imu.id, generation: imu.generation))
        XCTAssertEqual(try store.statistics(stream: .imu)["confirmedCount"] as? Int, 1)
    }

    func testNonpositiveQueueLimitsDoNotReadStorage() throws {
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory()) }
        try store.configure(owner)
        for limit in [0, -1] {
            XCTAssertEqual(try probe.withInstructionLimit(0) { try store.queuedCount(stream: .imu, limit: limit) }, 0)
        }
    }

    func testNonpositiveReservationLimitsDoNotSelectSamples() throws {
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory()) }
        try store.configure(owner)
        try probe.executeFixture("ALTER TABLE samples RENAME TO unavailable_samples")
        for limit in [0, -1] { XCTAssertNil(try store.reserve(stream: .realtime, limit: limit)) }
        XCTAssertThrowsError(try store.reserve(stream: .realtime, limit: 1))
    }

    func testSuccessfulCommitLeavesNoSQLiteError() throws {
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory()) }
        try store.configure(owner)
        try store.append(stream: .realtime, deviceId: "a", samples: samples([1]))
        XCTAssertEqual(probe.errorCode, SQLITE_OK)
    }
    func testStatisticsUsesBoundedDatabaseWorkForLargeQueues() throws {
        let url = try directory()
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: url) }
        try store.configure(owner)
        try seedPersistedSamples(10_000, stream: .imu, second: 2, probe: probe)
        let stats = try probe.withInstructionLimit(1_000) { try store.statistics(stream: .imu) }
        XCTAssertEqual(stats["count"] as? Int, 10_000)
        XCTAssertEqual(stats["oldestTimestamp"] as? String, "2026-10-28T00:00:02.000Z")
        XCTAssertEqual(stats["newestTimestamp"] as? String, "2026-10-28T00:00:02.000Z")
    }

    func testUnlimitedQueueCountUsesBoundedDatabaseWork() throws {
        let url = try directory()
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: url) }
        try store.configure(owner)
        try seedPersistedSamples(10_000, stream: .imu, second: 2, probe: probe)
        let count = try probe.withInstructionLimit(1_000) { try store.queuedCount(stream: .imu, limit: Int.max) }
        XCTAssertEqual(count, 10_000)
    }

    func testAcknowledgmentUsesBoundedDatabaseWorkForLargeQueues() throws {
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory()) }
        try store.configure(owner)
        try seedPersistedSamples(10_000, stream: .imu, second: 2, probe: probe)
        try store.append(stream: .realtime, deviceId: "a", samples: samples([1, 3]))
        let batch = try XCTUnwrap(store.reserve(stream: .realtime, limit: 1))

        XCTAssertTrue(try probe.withInstructionLimit(2_000) {
            try store.acknowledge(id: batch.id, generation: batch.generation)
        })

        XCTAssertEqual(try store.queuedCount(stream: .imu, limit: Int.max), 10_000)
        XCTAssertEqual(try store.queuedCount(stream: .realtime), 1)
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM samples WHERE stream = 'imu'"), 10_000)
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM samples WHERE stream = 'realtime'"), 1)
        XCTAssertEqual(try store.statistics(stream: .realtime)["confirmedCount"] as? Int, 1)
    }

    func testDiagnosticsBoundsFollowSampleTimeAcrossAcknowledgmentAndErasure() throws {
        let store = try WhoopBleSampleStore(directory: directory())
        try store.configure(owner)
        try store.append(stream: .realtime, deviceId: "a", samples: samples([9, 1, 8]))
        try store.append(stream: .imu, deviceId: "a", samples: samples([3, 2]))
        var stats = try store.statistics(stream: .realtime)
        XCTAssertEqual(stats["count"] as? Int, 3)
        XCTAssertEqual(stats["oldestTimestamp"] as? String, "2026-10-28T00:00:01.000Z")
        XCTAssertEqual(stats["newestTimestamp"] as? String, "2026-10-28T00:00:09.000Z")
        let batch = try XCTUnwrap(store.reserve(stream: .realtime, limit: 1))
        XCTAssertTrue(try store.acknowledge(id: batch.id, generation: batch.generation))
        stats = try store.statistics(stream: .realtime)
        XCTAssertEqual(stats["count"] as? Int, 2)
        XCTAssertEqual(stats["newestTimestamp"] as? String, "2026-10-28T00:00:08.000Z")
        try store.advanceErasureCutoff(to: XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-28T00:00:01Z")))
        stats = try store.statistics(stream: .realtime)
        XCTAssertEqual(stats["count"] as? Int, 1)
        XCTAssertEqual(stats["oldestTimestamp"] as? String, "2026-10-28T00:00:08.000Z")
        XCTAssertEqual(try store.queuedCount(stream: .imu, limit: Int.max), 2)
        try store.purge()
        stats = try store.statistics(stream: .realtime)
        XCTAssertEqual(stats["count"] as? Int, 0)
        XCTAssertTrue(stats["oldestTimestamp"] is NSNull)
        XCTAssertTrue(stats["newestTimestamp"] is NSNull)
    }
    func testReopenPreservesImmutableReservationAndExactAcknowledgment() throws {
        let url = try directory()
        var store: WhoopBleSampleStore? = try WhoopBleSampleStore(directory: url)
        XCTAssertThrowsError(try store!.append(stream: .realtime, deviceId: "a", samples: samples([1])))
        try store!.configure(owner)
        try store!.append(stream: .realtime, deviceId: "a", samples: samples([1, 2]))
        let batch = try XCTUnwrap(store!.reserve(stream: .realtime))
        try store!.append(stream: .realtime, deviceId: "a", samples: samples([3]))
        store = nil
        let reopened = try WhoopBleSampleStore(directory: url)
        try reopened.configure(owner)
        let recovered = try XCTUnwrap(reopened.reserve(stream: .realtime))
        XCTAssertEqual(recovered.body, batch.body)
        XCTAssertEqual(recovered.id, batch.id)
        XCTAssertEqual(recovered.binding, owner)
        XCTAssertFalse(try reopened.acknowledge(id: batch.id, generation: "stale"))
        XCTAssertTrue(try reopened.acknowledge(id: batch.id, generation: batch.generation))
        XCTAssertFalse(try reopened.acknowledge(id: batch.id, generation: batch.generation))
        XCTAssertEqual(try reopened.statistics(stream: .realtime)["count"] as? Int, 1)
        XCTAssertEqual(try reopened.statistics(stream: .realtime)["confirmedCount"] as? Int, 2)
    }
    func testDeviceAndStreamBoundariesAndBoundedBatches() throws {
        let (store, probe) = try SQLiteWorkProbe.opening { try WhoopBleSampleStore(directory: directory()) }
        try store.configure(owner)
        try seedPersistedSamples(85_900, stream: .realtime, second: 1, probe: probe)
        // Cross both the 500-row upload bound and the former 86,400-row queue cap through public ingestion.
        try store.append(stream: .realtime, deviceId: "a", samples: Array(repeating: samples([1])[0], count: 501))
        try store.append(stream: .realtime, deviceId: "b", samples: samples([2]))
        try store.append(stream: .imu, deviceId: "b", samples: [["timestamp": "2026-10-28T00:00:00.000Z", "x": 1, "y": 2, "z": 3]])
        let realtime = try XCTUnwrap(store.reserve(stream: .realtime, limit: 1000))
        XCTAssertEqual(realtime.sampleCount, 500)
        XCTAssertEqual(realtime.deviceId, "a")
        let imu = try XCTUnwrap(store.reserve(stream: .imu))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: imu.body) as? [String: Any])
        XCTAssertEqual(body["deviceType"] as? String, "whoop")
        XCTAssertEqual(try store.pendingBatches().count, 2)
        XCTAssertEqual(try store.statistics(stream: .realtime)["count"] as? Int, 86_402)
        XCTAssertEqual(try probe.integer("SELECT COUNT(*) FROM samples WHERE stream = 'realtime'"), 86_402)
        XCTAssertEqual(try store.statistics(stream: .realtime)["overflowDiscardedCount"] as? Int, 0)
        XCTAssertEqual(try store.queuedCount(stream: .realtime), 500)
        XCTAssertEqual(try store.queuedCount(stream: .realtime, limit: 1), 1)
        XCTAssertEqual(try store.queuedCount(stream: .realtime, limit: 0), 0)
        XCTAssertEqual(try store.queuedCount(stream: .realtime, limit: -1), 0)
        XCTAssertEqual(try store.queuedCount(stream: .realtime, limit: Int.max), 86_402)
    }
    func testConcurrentAppendsAndInvalidAppendRollback() throws {
        let store = try WhoopBleSampleStore(directory: directory())
        try store.configure(owner)
        let errors = NSMutableArray()
        let errorLock = NSLock()
        DispatchQueue.concurrentPerform(iterations: 20) { _ in
            do { try store.append(stream: .realtime, deviceId: "a", samples: samples([1])) } catch {
                errorLock.lock(); errors.add(error); errorLock.unlock()
            }
        }
        XCTAssertEqual(errors.count, 0)
        XCTAssertThrowsError(try store.append(stream: .realtime, deviceId: "a", samples: samples([2]) + [["timestamp": "bad"]]))
        XCTAssertEqual(try store.statistics(stream: .realtime)["count"] as? Int, 20)
        XCTAssertEqual(try store.statistics(stream: .realtime)["receivedCount"] as? Int, 20)
    }
    func testOwnerRotationAndPurgeRejectOldCompletion() throws {
        let store = try WhoopBleSampleStore(directory: directory())
        try store.configure(owner)
        try store.append(stream: .realtime, deviceId: "a", samples: samples([1]))
        let old = try XCTUnwrap(store.reserve(stream: .realtime))
        try store.configure(WhoopUploadBinding(userId: "bob", serverURL: owner.serverURL))
        XCTAssertNotEqual(try store.generation, old.generation)
        XCTAssertFalse(try store.acknowledge(id: old.id, generation: old.generation))
        XCTAssertTrue(try store.pendingBatches().isEmpty)
        try store.purge()
        XCTAssertNil(try store.binding)
    }
    func testErasureCutoffSurvivesOwnerChangeAndPurgeWithoutLeakingCounters() throws {
        let store = try WhoopBleSampleStore(directory: directory())
        try store.configure(owner)
        try store.advanceErasureCutoff(to: ISO8601DateFormatter().date(from: "2026-10-28T00:00:02Z")!)
        try store.append(stream: .realtime, deviceId: "a", samples: samples([1, 3]))
        try store.purge()
        try store.configure(WhoopUploadBinding(userId: "bob", serverURL: owner.serverURL))
        XCTAssertEqual(try store.statistics(stream: .realtime)["receivedCount"] as? Int, 0)
        try store.append(stream: .realtime, deviceId: "a", samples: samples([1, 2]))
        XCTAssertNil(try store.reserve(stream: .realtime))
        XCTAssertEqual(try store.statistics(stream: .realtime)["erasureDiscardedCount"] as? Int, 2)
        let generation = try store.generation
        try store.configure(WhoopUploadBinding(userId: "bob", serverURL: "https://other.example.com"))
        XCTAssertNotEqual(try store.generation, generation)
    }
    func testPersistedMonotonicCutoffInvalidatesReservationAndRetainsSurvivors() throws {
        let url = try directory()
        var store: WhoopBleSampleStore? = try WhoopBleSampleStore(directory: url)
        try store!.configure(owner)
        try store!.append(stream: .realtime, deviceId: "a", samples: samples([3, 1, 4, 2]))
        let old = try XCTUnwrap(store!.reserve(stream: .realtime))
        let cutoff = ISO8601DateFormatter().date(from: "2026-10-28T00:00:02Z")!
        try store!.advanceErasureCutoff(to: cutoff)
        XCTAssertFalse(try store!.acknowledge(id: old.id, generation: old.generation))
        store = nil
        let reopened = try WhoopBleSampleStore(directory: url)
        try reopened.advanceErasureCutoff(to: cutoff.addingTimeInterval(-1))
        try reopened.append(stream: .realtime, deviceId: "a", samples: samples([1, 2, 5]))
        XCTAssertEqual(try reopened.statistics(stream: .realtime)["count"] as? Int, 3)
        XCTAssertEqual(try reopened.statistics(stream: .realtime)["erasureDiscardedCount"] as? Int, 4)
        let batch = try XCTUnwrap(reopened.reserve(stream: .realtime))
        XCTAssertNotEqual(batch.id, old.id)
        XCTAssertEqual(batch.sampleCount, 3)
    }

    func testFractionalCutoffRetainsOnlySamplesAfterBoundary() throws {
        let store = try WhoopBleSampleStore(directory: directory())
        try store.configure(owner)
        try store.append(stream: .realtime, deviceId: "a", samples: [
            ["timestamp": "2026-10-28T00:00:02.100Z", "heartRateBpm": 70],
            ["timestamp": "2026-10-28T00:00:02.200Z", "heartRateBpm": 71],
            ["timestamp": "2026-10-28T00:00:02.430Z", "heartRateBpm": 72],
        ])
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        try store.advanceErasureCutoff(to: XCTUnwrap(formatter.date(from: "2026-10-28T00:00:02.200Z")))
        let batch = try XCTUnwrap(store.reserve(stream: .realtime))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: batch.body) as? [String: Any])
        let samples = try XCTUnwrap(body["samples"] as? [[String: Any]])
        XCTAssertEqual(samples.count, 1)
        XCTAssertEqual(samples.first?["timestamp"] as? String, "2026-10-28T00:00:02.430Z")
        XCTAssertEqual(try store.statistics(stream: .realtime)["erasureDiscardedCount"] as? Int, 2)
    }

    func testAppendAfterFractionalCutoffRetainsOnlyLaterSamples() throws {
        let store = try WhoopBleSampleStore(directory: directory())
        try store.configure(owner)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        try store.advanceErasureCutoff(to: XCTUnwrap(formatter.date(from: "2026-10-28T00:00:02.200Z")))
        try store.append(stream: .realtime, deviceId: "a", samples: [
            ["timestamp": "2026-10-28T00:00:02.100Z", "heartRateBpm": 70],
            ["timestamp": "2026-10-28T00:00:02.200Z", "heartRateBpm": 71],
            ["timestamp": "2026-10-28T00:00:02.430Z", "heartRateBpm": 72],
        ])
        let batch = try XCTUnwrap(store.reserve(stream: .realtime))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: batch.body) as? [String: Any])
        let samples = try XCTUnwrap(body["samples"] as? [[String: Any]])
        XCTAssertEqual(samples.count, 1)
        XCTAssertEqual(samples.first?["timestamp"] as? String, "2026-10-28T00:00:02.430Z")
        XCTAssertEqual(try store.statistics(stream: .realtime)["erasureDiscardedCount"] as? Int, 2)
    }
}
