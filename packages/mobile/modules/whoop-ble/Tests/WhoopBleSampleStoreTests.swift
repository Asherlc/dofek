import XCTest
@testable import WhoopBLE

final class WhoopBleSampleStoreTests: XCTestCase {
    private let owner = WhoopUploadBinding(userId: "alice", serverURL: "https://example.com")
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try FileManager.default.removeItem(at: url) }
        return url
    }
    private func samples(_ seconds: [Int]) -> [[String: Any]] {
        seconds.map { ["timestamp": String(format: "2026-10-28T00:00:%02d.000Z", $0), "heartRateBpm": 70] }
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
        let store = try WhoopBleSampleStore(directory: directory())
        try store.configure(owner)
        try store.append(stream: .realtime, deviceId: "a", samples: Array(repeating: samples([1])[0], count: 86_401))
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
