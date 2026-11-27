import UserNotifications
import XCTest
@testable import BackgroundRefreshLib

final class CollectionNotificationRetirementOrderingTests: XCTestCase {
    func testDelayedSnapshotAcrossRotationPreservesOnlyTheLatestGeneration() throws {
        let storeURL = temporaryGenerationURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }
        let harness = CollectionNotificationServiceHarness(generationFileURL: storeURL)

        retireAndFlush(harness)
        enable(harness)
        let firstGenerationIdentifier = try scheduleDisconnect(harness)

        // Queue a reconciliation snapshot, then rotate before the Apple lookup returns.
        harness.service.appBecameActive()
        harness.flushCleanup()
        XCTAssertGreaterThan(harness.center.pendingLookupCount, 0)

        retireAndFlush(harness)
        enable(harness)
        let latestIdentifier = try scheduleDisconnect(harness)
        XCTAssertNotEqual(firstGenerationIdentifier, latestIdentifier)

        harness.center.seed(firstGenerationIdentifier)
        harness.center.markDelivered(firstGenerationIdentifier)
        completePersistedLookups(harness)

        XCTAssertEqual(Set(harness.center.pending.keys), [latestIdentifier])
        XCTAssertFalse(harness.center.delivered.contains(firstGenerationIdentifier))
    }

    func testRetirementCompletionAppliesStateBeforeCallerSoReentrantRetireWins() throws {
        let storeURL = temporaryGenerationURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }
        let harness = CollectionNotificationServiceHarness(generationFileURL: storeURL)
        enable(harness)
        let settingsBeforeRetire = harness.center.settingsCallbacks.count

        var enableDuringCompletion: Result<Bool, Error>?
        let outerDone = expectation(description: "outer retirement settled")
        let nestedDone = expectation(description: "reentrant retirement settled")
        let enableDone = expectation(description: "enable inside retirement completion")

        harness.service.retire { result in
            if case .failure(let error) = result {
                XCTFail("Outer retirement failed: \(error)")
            }
            harness.service.enable(requestPermission: false) { enableResult in
                enableDuringCompletion = enableResult
                enableDone.fulfill()
            }
            // Ready state must be applied before this completion runs, otherwise enable
            // fails closed at the generation gate and never asks Apple for status.
            XCTAssertGreaterThan(
                harness.center.settingsCallbacks.count,
                settingsBeforeRetire,
                "Immediate enable must see a ready generation before the caller's completion returns"
            )
            harness.center.settingsCallbacks.last?(.authorized)
            harness.service.retire { nested in
                if case .failure(let error) = nested {
                    XCTFail("Reentrant retirement failed: \(error)")
                }
                nestedDone.fulfill()
            }
            outerDone.fulfill()
        }
        harness.flushGeneration()
        wait(for: [outerDone, enableDone], timeout: 1)
        if case .failure(let error) = enableDuringCompletion {
            XCTFail("Enable must clear generation readiness inside retirement completion, got \(error)")
        }

        harness.flushGeneration()
        wait(for: [nestedDone], timeout: 1)
        let finalGeneration = try readGeneration(harness.generationStore)

        enable(harness)
        let scheduled = try scheduleDisconnect(harness)
        XCTAssertTrue(
            scheduled.localizedCaseInsensitiveContains(finalGeneration.uuidString),
            "Reentrant retire must win the durable generation; outer completion must not overwrite it"
        )
    }

    func testRetireEnqueuesWriteBeforeFailingGenerationWaiters() throws {
        let storeURL = temporaryGenerationURL()
        defer { try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent()) }
        let generationQueue = DispatchQueue(label: "notification-test.generation-waiter-io")
        let gate = DispatchSemaphore(value: 0)
        generationQueue.async { gate.wait() }

        let center = ControlledCollectionNotificationCenter()
        let notifications = NotificationCenter()
        let store = CollectionNotificationGenerationStore(fileURL: storeURL, queue: generationQueue)
        let service = CollectionNotificationService(
            center: center,
            notifications: notifications,
            isAppActive: { true },
            isCollectionActive: { true },
            reportError: { _, _ in },
            cleanupQueue: DispatchQueue(label: "notification-test.generation-waiter-cleanup"),
            generationStore: store
        )
        service.start()

        let enableFailed = expectation(description: "enable waiter failed by outer retire")
        let nestedRetireDone = expectation(description: "waiter reentrant retire settled")
        let outerRetireDone = expectation(description: "outer retire settled")
        service.enable(requestPermission: false) { result in
            guard case .failure = result else {
                XCTFail("Enable waiter must fail when retirement begins")
                enableFailed.fulfill()
                return
            }
            enableFailed.fulfill()
            service.retire { nested in
                if case .failure(let error) = nested {
                    XCTFail("Reentrant waiter retirement failed: \(error)")
                }
                nestedRetireDone.fulfill()
            }
        }
        service.retire { result in
            if case .failure(let error) = result {
                XCTFail("Outer waiter retirement failed: \(error)")
            }
            outerRetireDone.fulfill()
        }

        gate.signal()
        let generationFlushed = expectation(description: "generation queue drained")
        generationQueue.async { generationFlushed.fulfill() }
        wait(for: [generationFlushed, enableFailed, outerRetireDone, nestedRetireDone], timeout: 2)

        let finalGeneration = try readGeneration(store)
        drainMain()
        let scheduled = try enableAndScheduleDisconnect(service: service, center: center, notifications: notifications)
        XCTAssertTrue(
            scheduled.localizedCaseInsensitiveContains(finalGeneration.uuidString),
            "Write must be enqueued before failing waiters so a synchronous reentrant retire cannot invert disk commits"
        )
    }

    private func temporaryGenerationURL() -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("collection-generation-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("generation")
    }

    private func readGeneration(_ store: CollectionNotificationGenerationStore) throws -> UUID {
        let reloaded = expectation(description: "generation read")
        var diskGeneration: UUID?
        store.read { result in
            if case .success(let value) = result {
                diskGeneration = value
            }
            reloaded.fulfill()
        }
        wait(for: [reloaded], timeout: 1)
        return try XCTUnwrap(diskGeneration)
    }

    private func retireAndFlush(_ harness: CollectionNotificationServiceHarness) {
        let retired = expectation(description: "retirement settled")
        harness.service.retire { _ in retired.fulfill() }
        harness.flushGeneration()
        wait(for: [retired], timeout: 1)
    }

    private func enable(_ harness: CollectionNotificationServiceHarness) {
        harness.service.enable(requestPermission: false) { result in
            XCTAssertEqual(try? result.get(), true)
        }
        harness.center.settingsCallbacks.last?(.authorized)
        settle(harness)
    }

    @discardableResult
    private func scheduleDisconnect(_ harness: CollectionNotificationServiceHarness) throws -> String {
        harness.connection("connected")
        harness.connection("disconnected")
        let index = harness.center.adds.count - 1
        harness.center.completeAdd(index)
        settle(harness)
        return try XCTUnwrap(harness.center.adds[index].request.identifier)
    }

    private func enableAndScheduleDisconnect(
        service: CollectionNotificationService,
        center: ControlledCollectionNotificationCenter,
        notifications: NotificationCenter
    ) throws -> String {
        let enabled = expectation(description: "enable after ordered retires")
        service.enable(requestPermission: false) { result in
            XCTAssertEqual(try? result.get(), true)
            enabled.fulfill()
        }
        center.settingsCallbacks.last?(.authorized)
        wait(for: [enabled], timeout: 1)
        notifications.post(
            name: Notification.Name("WhoopBle.connectionStateChanged"),
            object: nil,
            userInfo: ["state": "connected"]
        )
        notifications.post(
            name: Notification.Name("WhoopBle.connectionStateChanged"),
            object: nil,
            userInfo: ["state": "disconnected"]
        )
        drainMain()
        let index = center.adds.count - 1
        center.completeAdd(index)
        return try XCTUnwrap(center.adds[index].request.identifier)
    }

    private func drainMain() {
        let drained = expectation(description: "main drained")
        DispatchQueue.main.async { drained.fulfill() }
        wait(for: [drained], timeout: 1)
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
