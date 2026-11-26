import UserNotifications
import XCTest
@testable import BackgroundRefreshLib

final class CollectionNotificationServiceTests: XCTestCase {
    func testTerminationChecksCurrentCollectionActivityBeforeWarning() {
        let harness = CollectionNotificationServiceHarness()
        enable(harness)
        harness.collectionIsActive = false

        harness.service.appWillTerminate()

        XCTAssertTrue(harness.center.adds.isEmpty)
        harness.collectionIsActive = true
        harness.service.appWillTerminate()
        XCTAssertEqual(harness.center.adds.count, 1)
        XCTAssertEqual(harness.center.adds.first?.request.content.title, "Dofek closed")

        harness.collectionIsActive = false
        harness.service.appWillTerminate()
        XCTAssertEqual(harness.center.adds.count, 1)
    }

    func testTerminationAfterSignOutDoesNotWarnForActiveNativeCollection() {
        let harness = CollectionNotificationServiceHarness()
        enable(harness)
        harness.collectionIsActive = true

        harness.service.disable()
        harness.service.appWillTerminate()

        XCTAssertTrue(harness.center.adds.isEmpty)
    }

    func testSignOutBeforeSettingsReturnDoesNotRequestPermission() {
        let harness = CollectionNotificationServiceHarness()
        var result: Result<Bool, Error>?
        harness.service.enable(requestPermission: true) { result = $0 }

        harness.service.disable()
        harness.center.settingsCallbacks[0](.notDetermined)
        drainCallbacks()

        XCTAssertEqual(try? result?.get(), false)
        XCTAssertTrue(harness.center.authorizationCallbacks.isEmpty)
    }

    func testSignOutDuringAuthorizationCannotEnableAlerts() {
        let harness = CollectionNotificationServiceHarness()
        var result: Result<Bool, Error>?
        harness.service.enable(requestPermission: true) { result = $0 }
        harness.center.settingsCallbacks[0](.notDetermined)
        drainCallbacks()

        harness.service.disable()
        harness.center.authorizationCallbacks[0](true, nil)
        drainCallbacks()
        harness.connection("connected")
        harness.connection("disconnected")

        XCTAssertEqual(try? result?.get(), false)
        XCTAssertTrue(harness.center.adds.isEmpty)
    }

    func testAuthorizationFailureIsReportedAndReturned() {
        let harness = CollectionNotificationServiceHarness()
        let error = NSError(domain: "notifications", code: 42)
        var result: Result<Bool, Error>?
        harness.service.enable(requestPermission: true) { result = $0 }
        harness.center.settingsCallbacks[0](.notDetermined)
        drainCallbacks()

        harness.center.authorizationCallbacks[0](false, error)
        drainCallbacks()

        guard case .failure(let returnedError) = result else {
            return XCTFail("Authorization must return its error")
        }
        XCTAssertEqual(returnedError as NSError, error)
        XCTAssertEqual(harness.reportedErrors.first?.0 as NSError?, error)
    }

    func testBackgroundEnableDoesNotPromptForUndeterminedPermission() {
        let harness = CollectionNotificationServiceHarness(isAppActive: false)
        var result: Result<Bool, Error>?
        harness.service.enable(requestPermission: true) { result = $0 }

        harness.center.settingsCallbacks[0](.notDetermined)
        drainCallbacks()

        XCTAssertEqual(try? result?.get(), false)
        XCTAssertTrue(harness.center.authorizationCallbacks.isEmpty)
    }

    func testExistingPermissionArmsAnAlreadyConnectedWhoop() {
        let harness = CollectionNotificationServiceHarness()
        harness.connection("connected")
        enable(harness)

        harness.connection("disconnected")

        XCTAssertEqual(harness.center.adds.count, 1)
        XCTAssertEqual(harness.center.adds.first?.request.content.title, "WHOOP disconnected")
    }

    func testBackgroundConnectionPublicationDoesNotWaitForMainQueueDelivery() {
        let harness = CollectionNotificationServiceHarness()
        enable(harness)
        let bleQueue = DispatchQueue(label: "notification-test.ble")
        let publicationFinished = DispatchSemaphore(value: 0)

        bleQueue.async {
            harness.connection("connected")
            publicationFinished.signal()
        }

        // Termination snapshots synchronously query the BLE queue from main. A native
        // connection event must never wait for main before freeing that queue.
        XCTAssertEqual(publicationFinished.wait(timeout: .now() + 1), .success)
        drainCallbacks()
        harness.connection("disconnected")

        XCTAssertEqual(harness.center.adds.count, 1)
    }

    func testReconnectBeforeAddFinishesRemovesItsPendingRequest() {
        let harness = CollectionNotificationServiceHarness()
        enable(harness)
        harness.connection("connected")
        harness.connection("disconnected")

        harness.connection("connected")
        harness.center.completeAdd(0)
        settle(harness)

        XCTAssertTrue(harness.center.pending.isEmpty)
    }

    func testOlderAddCannotReplaceTheNewDisconnectGracePeriod() {
        let harness = CollectionNotificationServiceHarness()
        enable(harness)
        harness.connection("connected")
        harness.connection("disconnected")
        let first = harness.center.adds[0].request
        harness.connection("connected")
        harness.connection("disconnected")
        let second = harness.center.adds[1].request

        harness.center.completeAdd(1)
        settle(harness)
        harness.center.completeAdd(0)
        settle(harness)

        XCTAssertNotEqual(first.identifier, second.identifier)
        XCTAssertEqual(Set(harness.center.pending.keys), [second.identifier])
        XCTAssertTrue(harness.center.pending[second.identifier] === second)
        XCTAssertEqual((second.trigger as? UNTimeIntervalNotificationTrigger)?.timeInterval, 300)
    }

    func testCancelledAddCompletionDoesNotCancelANewerInFlightRequest() {
        let harness = CollectionNotificationServiceHarness()
        enable(harness)
        harness.connection("connected")
        harness.connection("disconnected")
        harness.connection("connected")
        harness.connection("disconnected")
        let second = harness.center.adds[1].request

        harness.center.completeAdd(0)
        settle(harness)
        XCTAssertTrue(harness.center.pending.isEmpty)
        harness.center.completeAdd(1)
        settle(harness)

        XCTAssertEqual(Set(harness.center.pending.keys), [second.identifier])
    }

    func testStartupPreservesPriorWhoopWarningsAndClearsPriorClosureWarnings() {
        let center = ControlledCollectionNotificationCenter()
        let whoop = "\(CollectionNotification.whoopDisconnected.identifier).previous-process"
        let closed = "\(CollectionNotification.appClosed.identifier).previous-process"
        center.seed(whoop)
        center.seed(closed)
        center.seed("unrelated")
        center.delivered = [whoop, closed, "unrelated"]

        let harness = CollectionNotificationServiceHarness(center: center)
        completePersistedLookups(harness)

        XCTAssertEqual(Set(harness.center.pending.keys), [whoop, "unrelated"])
        XCTAssertEqual(center.delivered, [whoop, "unrelated"])
    }

    func testLateReconnectCleanupPreservesTheNewRequest() {
        let harness = CollectionNotificationServiceHarness()
        let oldIdentifier = "\(CollectionNotification.whoopDisconnected.identifier).previous-process"
        harness.center.seed(oldIdentifier)
        harness.center.markDelivered(oldIdentifier)
        enable(harness)
        harness.connection("connected")
        harness.connection("disconnected")
        let latest = harness.center.adds[0].request
        harness.center.completeAdd(0)
        settle(harness)

        completePersistedLookups(harness)

        XCTAssertEqual(Set(harness.center.pending.keys), [latest.identifier])
        XCTAssertFalse(harness.center.delivered.contains(oldIdentifier))
    }

    func testReconnectBeforeAuthorizationRemovesPriorProcessWhoopWarnings() {
        let center = ControlledCollectionNotificationCenter()
        let oldIdentifier = "\(CollectionNotification.whoopDisconnected.identifier).\(UUID().uuidString)"
        center.seed(oldIdentifier)
        center.seed("unrelated")
        center.delivered = [oldIdentifier, "unrelated"]
        let harness = CollectionNotificationServiceHarness(center: center)

        harness.connection("connected")
        completePersistedLookups(harness)

        XCTAssertEqual(Set(center.pending.keys), ["unrelated"])
        XCTAssertEqual(center.delivered, ["unrelated"])
        XCTAssertTrue(center.settingsCallbacks.isEmpty)
        XCTAssertTrue(center.adds.isEmpty)
    }

    func testDisableRemovesPersistedWarningsForBothKinds() {
        let harness = CollectionNotificationServiceHarness()
        let oldWhoop = "\(CollectionNotification.whoopDisconnected.identifier).previous-process"
        let oldClosed = "\(CollectionNotification.appClosed.identifier).previous-process"
        harness.center.seed(oldWhoop)
        harness.center.seed(oldClosed)
        harness.center.seed("unrelated")
        harness.center.delivered = [oldWhoop, oldClosed, "unrelated"]

        harness.service.disable()
        completePersistedLookups(harness)

        XCTAssertEqual(Set(harness.center.pending.keys), ["unrelated"])
        XCTAssertEqual(harness.center.delivered, ["unrelated"])
    }

    func testForegroundCancellationDoesNotWaitOnNotificationRemoval() {
        let harness = CollectionNotificationServiceHarness()
        // Drain startup appBecameActive lookups before seeding so only the explicit
        // foreground trigger below can clear the previous-process warning.
        // Sign-out cancellation remains covered by testDisableRemovesPersistedWarningsForBothKinds.
        completePersistedLookups(harness)
        let oldIdentifier = "\(CollectionNotification.appClosed.identifier).\(UUID().uuidString)"
        harness.center.seed(oldIdentifier)
        harness.center.markDelivered(oldIdentifier)

        let removalStarted = expectation(description: "blocked lookup-derived pending removal started")
        let allowRemoval = DispatchSemaphore(value: 0)
        defer { allowRemoval.signal() }
        // Gate only the seeded persisted identifier so the initial base-identifier
        // cleanup cannot consume the one-shot hook before lookup-derived removal.
        harness.center.onRemovePending(matching: oldIdentifier) {
            XCTAssertFalse(Thread.isMainThread, "lookup-derived pending removal must not run on the main queue")
            removalStarted.fulfill()
            // Hold only off the main queue; a main-thread wait would deadlock this test.
            if !Thread.isMainThread {
                XCTAssertEqual(allowRemoval.wait(timeout: .now() + 2), .success)
            }
        }

        harness.service.appBecameActive()
        harness.flushCleanup()
        harness.center.completeLookups()
        // wait(for:) pumps main so lookup-derived removal is scheduled while we block.

        wait(for: [removalStarted], timeout: 1)

        let mainProgressed = expectation(description: "main queue progressed while removal blocked")
        DispatchQueue.main.async { mainProgressed.fulfill() }
        wait(for: [mainProgressed], timeout: 1)

        allowRemoval.signal()
        settle(harness)

        XCTAssertEqual(Set(harness.center.pending.keys), [])
        XCTAssertTrue(harness.center.delivered.isEmpty)
    }

    func testAddFailureIsReported() {
        let harness = CollectionNotificationServiceHarness()
        enable(harness)
        harness.connection("connected")
        harness.connection("disconnected")
        let error = NSError(domain: "notifications", code: 43)

        harness.center.completeAdd(0, error: error)
        settle(harness)

        XCTAssertEqual(harness.reportedErrors.first?.0 as NSError?, error)
        XCTAssertTrue(harness.center.pending.isEmpty)
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
        harness.flushCleanup()
        drainCallbacks()
        harness.flushCleanup()
        drainCallbacks()
    }

    private func drainCallbacks() {
        // Authorization settings and its completion each hop to the main queue.
        for _ in 0..<2 {
            let drained = expectation(description: "main callbacks drained")
            DispatchQueue.main.async { drained.fulfill() }
            wait(for: [drained], timeout: 1)
        }
    }
}

private final class CollectionNotificationServiceHarness {
    let center: ControlledCollectionNotificationCenter
    let cleanupQueue = DispatchQueue(label: "notification-test.cleanup")
    private let notifications = NotificationCenter()
    var reportedErrors: [(Error, String)] = []
    var collectionIsActive = true
    private(set) var service: CollectionNotificationService!

    init(center: ControlledCollectionNotificationCenter = .init(), isAppActive: Bool = true) {
        self.center = center
        service = CollectionNotificationService(
            center: center,
            notifications: notifications,
            isAppActive: { isAppActive },
            isCollectionActive: { [weak self] in self?.collectionIsActive == true },
            reportError: { [weak self] error, identifier in self?.reportedErrors.append((error, identifier)) },
            cleanupQueue: cleanupQueue
        )
        service.start()
        flushCleanup()
    }

    func flushCleanup() {
        let flushed = XCTestExpectation(description: "cleanup queue flushed")
        cleanupQueue.async { flushed.fulfill() }
        XCTAssertEqual(XCTWaiter.wait(for: [flushed], timeout: 1), .completed)
    }

    func connection(_ state: String) {
        notifications.post(
            name: Notification.Name("WhoopBle.connectionStateChanged"), object: nil, userInfo: ["state": state]
        )
    }
}

private final class ControlledCollectionNotificationCenter: CollectionNotificationCenter {
    var settingsCallbacks: [(CollectionNotificationAuthorizationStatus) -> Void] = []
    var authorizationCallbacks: [(Bool, Error?) -> Void] = []
    var adds: [(request: UNNotificationRequest, completion: (Error?) -> Void)] = []
    private let lock = NSLock()
    private var pendingStorage: [String: UNNotificationRequest] = [:]
    private var deliveredStorage: Set<String> = []
    private var onRemovePendingGate: (identifier: String, hook: () -> Void)?
    private var pendingLookups: [([String]) -> Void] = []
    private var deliveredLookups: [([String]) -> Void] = []

    var pending: [String: UNNotificationRequest] {
        lock.withLock { pendingStorage }
    }

    var delivered: Set<String> {
        get { lock.withLock { deliveredStorage } }
        set { lock.withLock { deliveredStorage = newValue } }
    }

    /// Arms a one-shot gate for one pending identifier. Other removals leave it armed.
    func onRemovePending(matching identifier: String, _ hook: @escaping () -> Void) {
        lock.withLock { onRemovePendingGate = (identifier: identifier, hook: hook) }
    }

    func getAuthorizationStatus(completion: @escaping (CollectionNotificationAuthorizationStatus) -> Void) {
        settingsCallbacks.append(completion)
    }

    func requestAuthorization(completion: @escaping (Bool, Error?) -> Void) {
        authorizationCallbacks.append(completion)
    }

    func add(_ request: UNNotificationRequest, completion: @escaping (Error?) -> Void) {
        adds.append((request, completion))
    }

    func getPendingIdentifiers(completion: @escaping ([String]) -> Void) {
        lock.withLock { pendingLookups.append(completion) }
    }

    func getDeliveredIdentifiers(completion: @escaping ([String]) -> Void) {
        lock.withLock { deliveredLookups.append(completion) }
    }

    func removePendingNotificationRequests(withIdentifiers identifiers: [String]) {
        let hook = lock.withLock { () -> (() -> Void)? in
            guard let gate = onRemovePendingGate, identifiers.contains(gate.identifier) else { return nil }
            onRemovePendingGate = nil
            return gate.hook
        }
        // Never hold the lock across the test gate or any other callback.
        hook?()
        lock.withLock {
            for identifier in identifiers { pendingStorage.removeValue(forKey: identifier) }
        }
    }

    func removeDeliveredNotifications(withIdentifiers identifiers: [String]) {
        lock.withLock { deliveredStorage.subtract(identifiers) }
    }

    func seed(_ identifier: String) {
        lock.withLock {
            pendingStorage[identifier] = UNNotificationRequest(
                identifier: identifier, content: UNMutableNotificationContent(), trigger: nil
            )
        }
    }

    func markDelivered(_ identifier: String) {
        lock.withLock { _ = deliveredStorage.insert(identifier) }
    }

    func completeAdd(_ index: Int, error: Error? = nil) {
        let add = adds[index]
        if error == nil {
            lock.withLock { pendingStorage[add.request.identifier] = add.request }
        }
        add.completion(error)
    }

    func completeLookups() {
        let snapshot = lock.withLock {
            let pending = pendingLookups
            let delivered = deliveredLookups
            pendingLookups.removeAll()
            deliveredLookups.removeAll()
            return (
                pending: pending,
                delivered: delivered,
                pendingIds: Array(pendingStorage.keys),
                deliveredIds: Array(deliveredStorage)
            )
        }
        for completion in snapshot.pending { completion(snapshot.pendingIds) }
        for completion in snapshot.delivered { completion(snapshot.deliveredIds) }
    }
}
