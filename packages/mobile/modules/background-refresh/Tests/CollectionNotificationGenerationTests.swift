import UserNotifications
import XCTest
@testable import BackgroundRefreshLib

final class CollectionNotificationGenerationTests: XCTestCase {
    func testRestartAfterRetirementWriteClearsOldAlertsWhilePriorCleanupBlocked() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("collection-generation-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storeURL = directory.appendingPathComponent("generation")
        let sharedCenter = ControlledCollectionNotificationCenter()
        let first = CollectionNotificationServiceHarness(center: sharedCenter, generationFileURL: storeURL)
        enable(first)
        first.connection("connected")
        first.connection("disconnected")
        first.center.completeAdd(0)
        settle(first)
        let retiredIdentifier = try XCTUnwrap(first.center.adds.first?.request.identifier)
        XCTAssertEqual(Set(first.center.pending.keys), [retiredIdentifier])
        first.center.markDelivered(retiredIdentifier)

        let removalStarted = expectation(description: "prior-process removal blocked")
        let allowRemoval = DispatchSemaphore(value: 0)
        defer { allowRemoval.signal() }
        first.center.onRemovePending(matching: retiredIdentifier) {
            XCTAssertFalse(Thread.isMainThread)
            removalStarted.fulfill()
            if !Thread.isMainThread {
                XCTAssertEqual(allowRemoval.wait(timeout: .now() + 2), .success)
            }
        }

        var retireResult: Result<Void, Error>?
        let retired = expectation(description: "retirement durable write completed")
        first.service.retire { result in
            retireResult = result
            retired.fulfill()
        }
        // Observe the Apple gate first. Do not flush the blocked cleanup queue.
        wait(for: [removalStarted], timeout: 1)
        // Retirement acknowledgment is independent of Apple removal.
        first.flushGeneration()
        wait(for: [retired], timeout: 1)
        XCTAssertNoThrow(try XCTUnwrap(retireResult).get())

        // Simulate process death while Apple cleanup remains blocked: a new service
        // reads the same durable generation and must clear the retired alert without
        // waiting on the previous process's cleanup queue.
        let relaunched = CollectionNotificationServiceHarness(
            center: sharedCenter,
            generationFileURL: storeURL
        )
        completePersistedLookups(relaunched)

        XCTAssertEqual(
            Set(sharedCenter.pending.keys),
            [],
            "Relaunch must remove retired-generation alerts even while the prior process cleanup is blocked"
        )
        XCTAssertFalse(
            sharedCenter.delivered.contains(retiredIdentifier),
            "Relaunch must clear the delivered retired-generation alert seeded before process death"
        )

        allowRemoval.signal()
        first.flushCleanup()
    }

    func testLegacyUpgradeWithoutRetirementPreservesWhoopWarnings() {
        let harness = CollectionNotificationServiceHarness()
        completePersistedLookups(harness)
        let pendingLookupsBefore = harness.center.pendingLookupCount
        let deliveredLookupsBefore = harness.center.deliveredLookupCount
        let whoop = "\(CollectionNotification.whoopDisconnected.identifier).\(UUID().uuidString)"
        harness.center.seed(whoop)
        harness.center.seed("unrelated")
        harness.service.appBecameActive()
        harness.flushCleanup()

        // Coordinator cancel still scans once; legacy reconciliation must not add a second scan.
        XCTAssertEqual(harness.center.pendingLookupCount - pendingLookupsBefore, 1)
        XCTAssertEqual(harness.center.deliveredLookupCount - deliveredLookupsBefore, 1)

        completePersistedLookups(harness)
        XCTAssertEqual(Set(harness.center.pending.keys), [whoop, "unrelated"])
        XCTAssertFalse(
            harness.center.pendingRemoveInvocations.contains(where: \.isEmpty),
            "Empty Apple remove invocations must not be issued"
        )
        XCTAssertFalse(harness.center.deliveredRemoveInvocations.contains(where: \.isEmpty))
    }

    func testCurrentGenerationAndUnrelatedIdentifiersSurviveReconciliation() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("collection-generation-keep-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storeURL = directory.appendingPathComponent("generation")
        let sharedCenter = ControlledCollectionNotificationCenter()
        let harness = CollectionNotificationServiceHarness(
            center: sharedCenter,
            generationFileURL: storeURL
        )

        let retired = expectation(description: "retire for current generation")
        harness.service.retire { result in
            if case .failure(let error) = result {
                XCTFail("Retirement failed: \(error)")
            }
            retired.fulfill()
        }
        harness.flushGeneration()
        wait(for: [retired], timeout: 1)

        enable(harness)
        harness.connection("connected")
        harness.connection("disconnected")
        harness.center.completeAdd(0)
        settle(harness)
        let current = try XCTUnwrap(harness.center.adds.first?.request.identifier)
        let legacy = "\(CollectionNotification.whoopDisconnected.identifier).\(UUID().uuidString)"
        harness.center.seed(legacy)
        harness.center.seed("unrelated")
        harness.center.delivered = [legacy, "unrelated", current]

        harness.service.appBecameActive()
        completePersistedLookups(harness)

        XCTAssertEqual(Set(harness.center.pending.keys), [current, "unrelated"])
        XCTAssertEqual(harness.center.delivered, [current, "unrelated"])
        // prefix has 3 dot-separated segments; generation-scoped IDs add two UUIDs.
        XCTAssertEqual(
            current.split(separator: ".").count,
            CollectionNotification.whoopDisconnected.identifier.split(separator: ".").count + 2
        )

        // A relaunched service with an empty request map must still preserve the on-disk
        // current generation while clearing only retired identifiers.
        sharedCenter.seed(legacy)
        sharedCenter.delivered = [legacy, "unrelated", current]
        let relaunched = CollectionNotificationServiceHarness(
            center: sharedCenter,
            generationFileURL: storeURL
        )
        completePersistedLookups(relaunched)
        XCTAssertEqual(Set(sharedCenter.pending.keys), [current, "unrelated"])
        XCTAssertEqual(sharedCenter.delivered, [current, "unrelated"])
    }

    func testForegroundWithLoadedGenerationStillSchedulesDisconnect() {
        let harness = CollectionNotificationServiceHarness()
        enable(harness)
        harness.connection("connected")

        // Must reconcile without re-entering .loading, or this disconnect is dropped.
        harness.service.appBecameActive()
        harness.connection("disconnected")

        XCTAssertEqual(harness.center.adds.count, 1)
        XCTAssertEqual(harness.center.adds.first?.request.content.title, "WHOOP disconnected")
    }

    func testOverlappingRetirementsSettleIndependentlyWithoutRearmingEnable() {
        let harness = CollectionNotificationServiceHarness()
        enable(harness)
        harness.connection("connected")

        var firstResult: Result<Void, Error>?
        var secondResult: Result<Void, Error>?
        let firstDone = expectation(description: "first retirement settled")
        let secondDone = expectation(description: "second retirement settled")
        harness.service.retire { result in
            firstResult = result
            firstDone.fulfill()
        }
        harness.service.retire { result in
            secondResult = result
            secondDone.fulfill()
        }

        var enableResult: Result<Bool, Error>?
        let enableDone = expectation(description: "enable during overlapping retirement")
        harness.service.enable(requestPermission: false) {
            enableResult = $0
            enableDone.fulfill()
        }

        harness.flushGeneration()
        wait(for: [firstDone, secondDone, enableDone], timeout: 1)

        XCTAssertNoThrow(try XCTUnwrap(firstResult).get())
        XCTAssertNoThrow(try XCTUnwrap(secondResult).get())
        guard case .failure(let error) = enableResult else {
            return XCTFail("Enable during retirement must not re-arm the retired session")
        }
        XCTAssertTrue(error is CollectionNotificationGenerationError)
        harness.connection("disconnected")
        XCTAssertTrue(harness.center.adds.isEmpty)
    }

    func testLateAddAfterRetirementRemovesObsoleteRequest() throws {
        let harness = CollectionNotificationServiceHarness()
        enable(harness)
        harness.connection("connected")
        harness.connection("disconnected")
        let pendingAdd = harness.center.adds[0]

        let retired = expectation(description: "retire before late add")
        harness.service.retire { _ in retired.fulfill() }
        harness.flushGeneration()
        wait(for: [retired], timeout: 1)

        harness.center.completeAdd(0)
        settle(harness)
        XCTAssertFalse(harness.center.pending.keys.contains(pendingAdd.request.identifier))
    }

    func testCorruptGenerationReadFailsEnableClosed() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("collection-generation-corrupt-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storeURL = directory.appendingPathComponent("generation")
        try Data("nope".utf8).write(to: storeURL, options: .atomic)
        let harness = CollectionNotificationServiceHarness(generationFileURL: storeURL)

        var enableResult: Result<Bool, Error>?
        let enabled = expectation(description: "enable settled against corrupt generation")
        harness.service.enable(requestPermission: false) {
            enableResult = $0
            enabled.fulfill()
        }
        wait(for: [enabled], timeout: 1)
        guard case .failure = enableResult else {
            return XCTFail("Enable must fail closed when generation state is unreadable")
        }
        XCTAssertFalse(harness.reportedErrors.isEmpty)
    }

    func testRetirementWriteFailureStaysDisarmedAndReportsError() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("collection-generation-ro-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: directory.path)
            try? FileManager.default.removeItem(at: directory)
        }
        let storeURL = directory.appendingPathComponent("generation")
        let harness = CollectionNotificationServiceHarness(generationFileURL: storeURL)
        enable(harness)
        harness.connection("connected")
        // Missing-file reads stay legacy; a non-writable parent makes the atomic write fail.
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: directory.path)

        var retireResult: Result<Void, Error>?
        let retired = expectation(description: "failed retirement settled")
        harness.service.retire { result in
            retireResult = result
            retired.fulfill()
        }
        harness.flushGeneration()
        wait(for: [retired], timeout: 1)

        guard case .failure = retireResult else {
            return XCTFail("Retirement must surface generation write failures")
        }
        XCTAssertFalse(harness.reportedErrors.isEmpty)
        harness.connection("disconnected")
        XCTAssertTrue(harness.center.adds.isEmpty, "Failed retirement must keep scheduling disarmed")

        var enableResult: Result<Bool, Error>?
        let enabled = expectation(description: "enable before recovery")
        harness.service.enable(requestPermission: false) {
            enableResult = $0
            enabled.fulfill()
        }
        wait(for: [enabled], timeout: 1)
        guard case .failure = enableResult else {
            return XCTFail("Enable must not re-arm after a failed retirement write")
        }

        harness.service.appBecameActive()
        harness.flushGeneration()
        var enableAfterForeground: Result<Bool, Error>?
        let enabledAgain = expectation(description: "enable after foreground reload")
        harness.service.enable(requestPermission: false) {
            enableAfterForeground = $0
            enabledAgain.fulfill()
        }
        wait(for: [enabledAgain], timeout: 1)
        guard case .failure = enableAfterForeground else {
            return XCTFail("Foreground reload must not silently re-admit the prior generation after a failed write")
        }
        harness.connection("disconnected")
        XCTAssertTrue(harness.center.adds.isEmpty)
    }

    private func enable(_ harness: CollectionNotificationServiceHarness) {
        harness.service.enable(requestPermission: false) { result in
            XCTAssertEqual(try? result.get(), true)
        }
        harness.center.settingsCallbacks.last?(.authorized)
        settle(harness)
    }

    private func completePersistedLookups(_ harness: CollectionNotificationServiceHarness) {
        harness.flushCleanup()
        harness.center.completeLookups()
        settle(harness)
    }

    private func settle(_ harness: CollectionNotificationServiceHarness) {
        harness.flushGeneration()
        harness.flushCleanup()
        drainCallbacks()
        harness.flushCleanup()
        drainCallbacks()
    }

    private func drainCallbacks() {
        for _ in 0..<2 {
            let drained = expectation(description: "main callbacks drained")
            DispatchQueue.main.async { drained.fulfill() }
            wait(for: [drained], timeout: 1)
        }
    }
}

final class CollectionNotificationGenerationStoreTests: XCTestCase {
    func testMissingFileIsLegacyAndRoundTripPersistsUUID() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("generation-store-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = CollectionNotificationGenerationStore(
            fileURL: directory.appendingPathComponent("generation")
        )

        let missing = expectation(description: "missing read")
        var missingResult: Result<UUID?, Error>?
        store.read {
            missingResult = $0
            missing.fulfill()
        }
        wait(for: [missing], timeout: 1)
        XCTAssertNil(try XCTUnwrap(missingResult).get())

        let generation = UUID()
        let written = expectation(description: "write")
        store.write(generation) { result in
            if case .failure(let error) = result {
                XCTFail("Generation write failed: \(error)")
            }
            written.fulfill()
        }
        wait(for: [written], timeout: 1)

        let reloaded = CollectionNotificationGenerationStore(
            fileURL: directory.appendingPathComponent("generation")
        )
        let loaded = expectation(description: "reload")
        var loadedResult: Result<UUID?, Error>?
        reloaded.read {
            loadedResult = $0
            loaded.fulfill()
        }
        wait(for: [loaded], timeout: 1)
        XCTAssertEqual(try XCTUnwrap(loadedResult).get(), generation)
    }

    func testCorruptFileReportsFailureDistinctFromMissing() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("generation-corrupt-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("generation")
        try Data("not-a-uuid".utf8).write(to: fileURL, options: .atomic)
        let store = CollectionNotificationGenerationStore(fileURL: fileURL)

        let read = expectation(description: "corrupt read")
        var result: Result<UUID?, Error>?
        store.read {
            result = $0
            read.fulfill()
        }
        wait(for: [read], timeout: 1)
        guard case .failure(let error) = result else {
            return XCTFail("Corrupt generation must fail closed")
        }
        XCTAssertTrue(error is CollectionNotificationGenerationError)
    }

    func testInaccessiblePathIsNotTreatedAsLegacyMissing() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("generation-dir-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        // Reading a directory path is not NSFileReadNoSuchFileError.
        let store = CollectionNotificationGenerationStore(fileURL: directory)

        let read = expectation(description: "inaccessible read")
        var result: Result<UUID?, Error>?
        store.read {
            result = $0
            read.fulfill()
        }
        wait(for: [read], timeout: 1)
        guard case .failure = result else {
            return XCTFail("Inaccessible generation paths must not look like a legacy missing file")
        }
    }
}
