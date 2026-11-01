import XCTest
@testable import WhoopBLE

private final class Transport: WhoopUploadTransport {
    var onCompletion: ((String, Int?, Data, URL?, Error?) -> Void)?
    var onFinishEvents: (() -> Void)?
    var tasks: [String] = []
    var requests: [(URLRequest, URL, String)] = []
    var reconciliationCount = 0
    var delayCancellation = false
    var delayedCancellations: [() -> Void] = []
    var cancellations: [String] = []
    func allTasks(_ completion: @escaping ([String]) -> Void) { reconciliationCount += 1; completion(tasks) }
    func start(request: URLRequest, file: URL, identity: String) {
        tasks.append(identity); requests.append((request, file, identity))
    }
    func cancel(identity: String) {
        cancellations.append(identity)
        let cancel = { self.tasks.removeAll { $0 == identity } }
        if delayCancellation { delayedCancellations.append(cancel) } else { cancel() }
    }
    func complete(_ index: Int, status: Int = 200, body: String = "{\"result\":{\"data\":{\"inserted\":0}}}") {
        let task = requests[index]
        tasks.removeAll { $0 == task.2 }
        onCompletion?(task.2, status, Data(body.utf8), task.0.url, nil)
    }
}

final class WhoopBleBackgroundUploaderTests: XCTestCase {
    func testSensorUploadUsesOwnRouteAndAcknowledgesWhileRealtimeFails() throws {
        let (uploader, store, transport) = try setup()
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        let frame = try XCTUnwrap(WhoopBleFrameParser.parseFrame(capturedWhoopR18Data()))
        let record = try XCTUnwrap(WhoopBleSensorRecord.serialize(
            frame: frame, deviceInfo: ["model": "WHOOP MG", "firmware": "50.42.1.0"]))
        try uploader.append(deviceId: "a", samplesByStream: [.sensorRecords: [record]])
        try uploader.flush(); try settle(uploader)
        let sensorIndex = try XCTUnwrap(transport.requests.firstIndex { $0.0.url?.path == "/api/trpc/whoopBleSync.pushSensorRecords" })
        let realtimeIndex = try XCTUnwrap(transport.requests.firstIndex { $0.0.url?.path == "/api/trpc/whoopBleSync.pushRealtimeData" })
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: transport.requests[sensorIndex].1)) as? [String: Any])
        let samples = try XCTUnwrap(body["samples"] as? [[String: Any]])
        XCTAssertEqual(samples.count, 1)
        let sample = try XCTUnwrap(samples.first)
        XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(sample["captureId"] as? String)))
        XCTAssertEqual(sample["frameHex"] as? String, try capturedWhoopR18Data().map { String(format: "%02x", $0) }.joined())
        XCTAssertEqual(sample["deviceInfo"] as? [String: String], ["model": "WHOOP MG", "firmware": "50.42.1.0"])
        transport.complete(realtimeIndex, status: 500)
        transport.complete(sensorIndex)
        try settle(uploader)
        XCTAssertEqual(try store.queuedCount(stream: .sensorRecords), 0)
        XCTAssertEqual(try store.queuedCount(stream: .realtime), 1)
    }
    private func setup(
        reportError: @escaping (Error) -> Void = { _ in },
        now: @escaping () -> Date = Date.init
    ) throws -> (WhoopBleBackgroundUploader, WhoopBleSampleStore, Transport) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let store = try WhoopBleSampleStore(directory: directory)
        let transport = Transport()
        let uploader = try WhoopBleBackgroundUploader(
            store: store, directory: directory.appendingPathComponent("bodies"), transport: transport, reportError: reportError, now: now)
        try uploader.configure(userId: "alice", serverURL: "https://example.com", token: "secret", headers: [:])
        return (uploader, store, transport)
    }
    private let rows: [[String: Any]] = [["timestamp": "2026-10-28T00:00:01.000Z", "heartRateBpm": 70]]
    private func settle(_ uploader: WhoopBleBackgroundUploader) throws {
        // Reconciliation and delegate work return to the serial queue.
        for _ in 0..<4 { _ = try uploader.diagnostics() }
    }
    func testCaptureCoalescesAndValidZeroAcknowledgesOnlyReservedRows() throws {
        let (uploader, store, transport) = try setup()
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try settle(uploader)
        XCTAssertTrue(transport.requests.isEmpty)
        try uploader.flush(); try settle(uploader)
        XCTAssertEqual(transport.requests.count, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: transport.requests[0].1.path))
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        transport.complete(0); try settle(uploader)
        XCTAssertEqual(try store.statistics(stream: .realtime)["count"] as? Int, 1)
    }
    func testStreamsProgressIndependentlyAndFailuresKeepRows() throws {
        let (uploader, store, transport) = try setup()
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows, .imu: rows])
        try uploader.flush(); try settle(uploader)
        XCTAssertEqual(transport.requests.count, 2)
        for index in 0..<2 { transport.complete(index, status: 500) }
        try settle(uploader)
        XCTAssertEqual(try store.pendingBatches().count, 2)
        XCTAssertEqual(transport.requests.count, 2)
        try uploader.flush(); try settle(uploader)
        XCTAssertEqual(transport.requests.count, 4)
    }
    func testAuthFailureBlocksCaptureRetryUntilConfigureAndMalformedResponseRetainsRows() throws {
        let (uploader, store, transport) = try setup()
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush(); try settle(uploader)
        transport.complete(0, status: 401); try settle(uploader)
        try uploader.flush(); try settle(uploader)
        XCTAssertEqual(transport.requests.count, 1)
        try uploader.configure(userId: "alice", serverURL: "https://example.com", token: "new", headers: [:]); try settle(uploader)
        XCTAssertEqual(transport.requests.count, 2)
        transport.complete(1, body: "{\"result\":{\"data\":{\"inserted\":true}}}"); try settle(uploader)
        XCTAssertEqual(try store.statistics(stream: .realtime)["count"] as? Int, 1)
    }
    func testOwnerChangeAndDisableRejectStaleCompletion() throws {
        let (uploader, store, transport) = try setup()
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush(); try settle(uploader)
        try uploader.configure(userId: "bob", serverURL: "https://example.com", token: "new", headers: [:])
        transport.complete(0); try settle(uploader)
        XCTAssertEqual(try store.binding?.userId, "bob")
        try uploader.disable()
        XCTAssertNil(try store.binding)
        XCTAssertThrowsError(try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows]))
    }

    func testErasureRevokesTransfersAndRetainsCutoffForNextAccount() throws {
        let (uploader, _, transport) = try setup()
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush(); try settle(uploader)
        XCTAssertEqual(try uploader.sampleCount(stream: .realtime), 1)
        let formatter = ISO8601DateFormatter()
        let cutoff = try XCTUnwrap(formatter.date(from: "2026-10-28T00:00:01Z"))
        try uploader.purge(cutoff: cutoff)
        XCTAssertEqual(try uploader.sampleCount(stream: .realtime), 0)
        transport.complete(0); try settle(uploader)
        try uploader.configure(userId: "bob", serverURL: "https://example.com", token: "new", headers: [:])
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows + [
            ["timestamp": "2026-10-28T00:00:02.000Z", "heartRateBpm": 71],
        ]])
        XCTAssertEqual(try uploader.sampleCount(stream: .realtime), 1)
    }
    func testRejectsUnsafeOriginsAndCredentialHeaders() throws {
        let (uploader, _, _) = try setup()
        for origin in ["http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?x=1"] {
            XCTAssertThrowsError(try uploader.configure(userId: "alice", serverURL: origin, token: "s", headers: [:]))
        }
        XCTAssertThrowsError(try uploader.configure(userId: "alice", serverURL: "https://example.com", token: "s", headers: ["Authorization": "bad"]))
    }

    func testTokenRotationBeforeOldAuthFailureUsesNewTokenWithoutBlocking() throws {
        let (uploader, _, transport) = try setup()
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush(); try settle(uploader)
        try uploader.configure(userId: "alice", serverURL: "https://example.com", token: "new", headers: [:])
        try settle(uploader)
        XCTAssertEqual(transport.requests.count, 1)
        transport.complete(0, status: 401); try settle(uploader)
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertEqual(transport.requests.last?.0.value(forHTTPHeaderField: "Authorization"), "Bearer new")
    }

    func testRestoredTaskRetainsReservationAndMissingFileIsRegeneratedAfterFailure() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let store = try WhoopBleSampleStore(directory: directory)
        try store.configure(WhoopUploadBinding(userId: "alice", serverURL: "https://example.com"))
        try store.append(deviceId: "a", samplesByStream: [.realtime: rows])
        let batch = try XCTUnwrap(store.reserve(stream: .realtime))
        let identity = batch.generation + "." + batch.id
        let transport = Transport()
        transport.tasks = [identity]
        let bodies = directory.appendingPathComponent("bodies")
        try FileManager.default.createDirectory(at: bodies, withIntermediateDirectories: true)
        let orphan = bodies.appendingPathComponent("orphan.json")
        try Data("erased sample".utf8).write(to: orphan)
        let uploader = try WhoopBleBackgroundUploader(
            store: store, directory: bodies, transport: transport, reportError: { _ in })
        try uploader.configure(userId: "alice", serverURL: "https://example.com", token: "new", headers: [:])
        try settle(uploader)
        XCTAssertTrue(transport.requests.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path))
        transport.tasks = []
        try uploader.flush(); try settle(uploader)
        XCTAssertEqual(transport.requests.count, 1)
        XCTAssertEqual(transport.requests[0].2, identity)
        XCTAssertEqual(try Data(contentsOf: transport.requests[0].1), batch.body)
    }

    func testHundredArrivalsCommitWithoutRepeatedOSReconciliation() throws {
        let (uploader, store, transport) = try setup()
        try settle(uploader)
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try settle(uploader)
        let before = transport.reconciliationCount
        for _ in 0..<100 { try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows]) }
        try settle(uploader)
        XCTAssertEqual(transport.reconciliationCount, before)
        XCTAssertEqual(try store.statistics(stream: .realtime)["count"] as? Int, 101)
    }

    func testFullBatchAndPartialTailAreScheduledFromCoalescedArrivals() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let store = try WhoopBleSampleStore(directory: directory)
        let transport = Transport()
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        let uploader = try WhoopBleBackgroundUploader(
            store: store, directory: directory.appendingPathComponent("bodies"), transport: transport,
            reportError: { _ in }, now: { clock })
        try uploader.configure(userId: "alice", serverURL: "https://example.com", token: "s", headers: [:])
        try settle(uploader)
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try settle(uploader)
        for _ in 0..<499 { try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows]) }
        XCTAssertTrue(transport.requests.isEmpty)
        clock = clock.addingTimeInterval(5)
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try settle(uploader)
        XCTAssertEqual(transport.requests.count, 1)
        transport.complete(0); try settle(uploader)
        XCTAssertEqual(try store.statistics(stream: .realtime)["count"] as? Int, 1)
        clock = clock.addingTimeInterval(30)
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try settle(uploader)
        XCTAssertEqual(transport.requests.count, 2)
    }

    func testBackgroundCompletionRunsOnMainAfterAcknowledgment() throws {
        let (uploader, store, transport) = try setup()
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush(); try settle(uploader)
        let completion = expectation(description: "background events finished")
        uploader.handleBackgroundEvents {
            XCTAssertTrue(Thread.isMainThread)
            XCTAssertEqual(try? store.statistics(stream: .realtime)["count"] as? Int, 0)
            completion.fulfill()
        }
        transport.complete(0)
        transport.onFinishEvents?()
        wait(for: [completion], timeout: 2)
    }

    func testDelayedOldOwnerCancellationDoesNotCancelNewOwnerTasks() throws {
        for disableFirst in [false, true] {
            let (uploader, _, transport) = try setup()
            try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
            try uploader.flush(); try settle(uploader)
            let old = try XCTUnwrap(transport.requests.first?.2)
            transport.delayCancellation = true
            if disableFirst { try uploader.disable() }
            try uploader.configure(userId: "bob", serverURL: "https://example.com", token: "bob", headers: [:])
            try uploader.append(deviceId: "b", samplesByStream: [.realtime: rows])
            try uploader.flush(); try settle(uploader)
            let current = try XCTUnwrap(transport.requests.last?.2)
            XCTAssertNotEqual(old, current)
            for cancel in transport.delayedCancellations { cancel() }
            XCTAssertEqual(transport.tasks, [current])
        }
    }

    func testRestoredUnauthorizedTaskRetriesCurrentCredentialsOnceThenBlocks() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let store = try WhoopBleSampleStore(directory: directory)
        try store.configure(WhoopUploadBinding(userId: "alice", serverURL: "https://example.com"))
        try store.append(deviceId: "a", samplesByStream: [.realtime: rows])
        let batch = try XCTUnwrap(store.reserve(stream: .realtime))
        let identity = batch.generation + "." + batch.id
        let transport = Transport()
        transport.tasks = [identity]
        let uploader = try WhoopBleBackgroundUploader(
            store: store, directory: directory.appendingPathComponent("bodies"), transport: transport, reportError: { _ in })
        try uploader.configure(userId: "alice", serverURL: "https://example.com", token: "new", headers: [:])
        try settle(uploader)
        transport.tasks = []
        transport.onCompletion?(identity, 401, Data(), URL(string: "https://example.com/api/trpc/whoopBleSync.pushRealtimeData"), nil)
        try settle(uploader)
        XCTAssertEqual(transport.requests.count, 1)
        guard transport.requests.count == 1 else { return }
        XCTAssertEqual(transport.requests[0].0.value(forHTTPHeaderField: "Authorization"), "Bearer new")
        transport.complete(0, status: 401); try settle(uploader)
        try uploader.flush(); try settle(uploader)
        XCTAssertEqual(transport.requests.count, 1)
        XCTAssertEqual(try uploader.diagnostics()["blockedUploadStreams"] as? [String], ["realtime"])
    }

    func testFinishedEventsBeforeHandlerRegistrationStillCompletesAfterAcknowledgment() throws {
        let (uploader, store, transport) = try setup()
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush(); try settle(uploader)
        transport.complete(0)
        transport.onFinishEvents?()
        try settle(uploader)
        let completion = expectation(description: "late background handler")
        completion.assertForOverFulfill = true
        uploader.handleBackgroundEvents {
            XCTAssertTrue(Thread.isMainThread)
            XCTAssertEqual(try? store.statistics(stream: .realtime)["count"] as? Int, 0)
            completion.fulfill()
        }
        wait(for: [completion], timeout: 0.5)
    }

    private func obstructRemoval(at path: URL) throws {
        let manager = FileManager.default
        if manager.fileExists(atPath: path.path) { try manager.removeItem(at: path) }
        try manager.createDirectory(at: path, withIntermediateDirectories: true)
        try Data("retained projection".utf8).write(to: path.appendingPathComponent("body"))
        try manager.setAttributes([.posixPermissions: 0o500], ofItemAtPath: path.path)
        addTeardownBlock {
            if manager.fileExists(atPath: path.path) {
                try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: path.path)
            }
        }
    }

    func testErasurePersistsCutoffWhenBodyRemovalFailsAndCancelsReservedIdentity() throws {
        let (uploader, store, transport) = try setup()
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush(); try settle(uploader)
        let body = try XCTUnwrap(transport.requests.first?.1)
        let activeIdentity = try XCTUnwrap(transport.requests.first?.2)
        try uploader.append(deviceId: "a", samplesByStream: [.imu: rows])
        try settle(uploader)
        let reserved = try XCTUnwrap(store.reserve(stream: .imu))
        let reservedIdentity = reserved.generation + "." + reserved.id
        try obstructRemoval(at: body)
        let cutoff = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-28T00:00:01Z"))
        XCTAssertThrowsError(try uploader.purge(cutoff: cutoff))
        XCTAssertTrue(transport.cancellations.contains(activeIdentity))
        XCTAssertTrue(transport.cancellations.contains(reservedIdentity))
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: body.path)
        try uploader.configure(userId: "bob", serverURL: "https://example.com", token: "new", headers: [:])
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows + [
            ["timestamp": "2026-10-28T00:00:02.000Z", "heartRateBpm": 71],
        ]])
        XCTAssertEqual(try uploader.sampleCount(stream: .realtime), 1)
        let reopened = try WhoopBleSampleStore(directory: body.deletingLastPathComponent().deletingLastPathComponent())
        try reopened.append(deviceId: "a", samplesByStream: [.realtime: rows])
        XCTAssertEqual(try reopened.queuedCount(stream: .realtime), 1)
        transport.complete(0); try settle(uploader)
        XCTAssertEqual(try uploader.sampleCount(stream: .realtime), 1)
    }

    func testIMUBodyWriteFailureStillSubmitsRealtimeAndReportsError() throws {
        var errors: [Error] = []
        let (uploader, store, transport) = try setup(reportError: { errors.append($0) })
        try uploader.append(deviceId: "a", samplesByStream: [.imu: rows])
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try settle(uploader)
        let batch = try XCTUnwrap(store.reserve(stream: .imu))
        // A directory at the exact output path makes atomic file replacement fail.
        try uploader.flush(); try settle(uploader)
        let imuRequest = try XCTUnwrap(transport.requests.first { $0.0.url?.path.contains("inertial") == true })
        transport.complete(try XCTUnwrap(transport.requests.firstIndex { $0.2 == imuRequest.2 }), status: 500)
        try settle(uploader)
        try FileManager.default.removeItem(at: imuRequest.1)
        try FileManager.default.createDirectory(at: imuRequest.1, withIntermediateDirectories: true)
        // Leave realtime available while forcing the earlier IMU stream to fail.
        transport.complete(try XCTUnwrap(transport.requests.firstIndex { $0.0.url?.path.contains("Realtime") == true }), status: 500)
        try settle(uploader)
        let before = transport.requests.count
        let errorsBefore = errors.count
        try uploader.flush(); try settle(uploader)
        XCTAssertEqual(transport.requests.count, before + 1)
        XCTAssertTrue(transport.requests.last?.0.url?.path.contains("Realtime") == true)
        XCTAssertGreaterThan(errors.count, errorsBefore)
        XCTAssertEqual(try store.pendingBatches().first { $0.stream == .imu }?.id, batch.id)
    }

    func testBodyWriteFailureWaitsForExistingRetryIntervalWithoutBlockingRealtime() throws {
        var errors: [Error] = []
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        let (uploader, _, transport) = try setup(reportError: { errors.append($0) }, now: { clock })
        try settle(uploader)
        try uploader.append(deviceId: "a", samplesByStream: [.imu: Array(repeating: rows[0], count: 500)])
        try settle(uploader)
        let file = try XCTUnwrap(transport.requests.first?.1)
        transport.complete(0, status: 500); try settle(uploader)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: true)
        try uploader.flush(); try settle(uploader)
        let errorsAfterFailure = errors.count
        XCTAssertEqual(errorsAfterFailure, 2)
        clock = clock.addingTimeInterval(5)
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: Array(repeating: rows[0], count: 500)])
        try settle(uploader)
        XCTAssertEqual(errors.count, errorsAfterFailure)
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertTrue(transport.requests.last?.0.url?.path.contains("Realtime") == true)
        clock = clock.addingTimeInterval(25)
        try uploader.append(deviceId: "a", samplesByStream: [.imu: rows])
        try settle(uploader)
        XCTAssertEqual(errors.count, errorsAfterFailure + 1)
    }

    func testAcknowledgedBodyRemovalFailureStillContinuesFullBatches() throws {
        var errors: [Error] = []
        let (uploader, store, transport) = try setup(reportError: { errors.append($0) })
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: Array(repeating: rows[0], count: 1000)])
        try uploader.flush(); try settle(uploader)
        let file = try XCTUnwrap(transport.requests.first?.1)
        try obstructRemoval(at: file)
        transport.complete(0); try settle(uploader)
        XCTAssertEqual(try store.statistics(stream: .realtime)["count"] as? Int, 500)
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertFalse(errors.isEmpty)
    }

    func testOrphanRemovalFailureStillSubmitsOtherStreamsAndReportsError() throws {
        var errors: [Error] = []
        let (uploader, _, transport) = try setup(reportError: { errors.append($0) })
        try uploader.append(deviceId: "a", samplesByStream: [.imu: rows])
        try uploader.flush(); try settle(uploader)
        let directory = try XCTUnwrap(transport.requests.first?.1.deletingLastPathComponent())
        try obstructRemoval(at: directory.appendingPathComponent("orphan.json"))
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush(); try settle(uploader)
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertFalse(errors.isEmpty)
    }

    func testBodyDirectoryListingFailureStillSubmitsAndReportsError() throws {
        var errors: [Error] = []
        let (uploader, _, transport) = try setup(reportError: { errors.append($0) })
        try uploader.append(deviceId: "a", samplesByStream: [.imu: rows])
        try uploader.flush(); try settle(uploader)
        let directory = try XCTUnwrap(transport.requests.first?.1.deletingLastPathComponent())
        try FileManager.default.setAttributes([.posixPermissions: 0o300], ofItemAtPath: directory.path)
        addTeardownBlock { try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path) }
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush(); try settle(uploader)
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertFalse(errors.isEmpty)
    }

    func testCrossOriginCompletionRetainsRowsAndBlocksUntilConfigure() throws {
        let (uploader, store, transport) = try setup()
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: rows])
        try uploader.flush(); try settle(uploader)
        let identity = try XCTUnwrap(transport.requests.first?.2)
        transport.tasks.removeAll()
        transport.onCompletion?(identity, 200, Data("{\"result\":{\"data\":{\"inserted\":1}}}".utf8),
                                URL(string: "https://other.example/api/trpc/whoopBleSync.pushRealtimeData"), nil)
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
}
