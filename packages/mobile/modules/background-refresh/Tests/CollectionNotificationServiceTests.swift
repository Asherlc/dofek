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
        drainCallbacks()

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
        drainCallbacks()
        harness.center.completeAdd(0)
        drainCallbacks()

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
        drainCallbacks()
        XCTAssertTrue(harness.center.pending.isEmpty)
        harness.center.completeAdd(1)
        drainCallbacks()

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
        center.completeLookups()
        drainCallbacks()

        XCTAssertEqual(Set(harness.center.pending.keys), [whoop, "unrelated"])
        XCTAssertEqual(center.delivered, [whoop, "unrelated"])
    }

    func testLateReconnectCleanupPreservesTheNewRequest() {
        let harness = CollectionNotificationServiceHarness()
        let oldIdentifier = "\(CollectionNotification.whoopDisconnected.identifier).previous-process"
        harness.center.seed(oldIdentifier)
        harness.center.delivered.insert(oldIdentifier)
        enable(harness)
        harness.connection("connected")
        harness.connection("disconnected")
        let latest = harness.center.adds[0].request
        harness.center.completeAdd(0)
        drainCallbacks()

        harness.center.completeLookups()
        drainCallbacks()

        XCTAssertEqual(Set(harness.center.pending.keys), [latest.identifier])
        XCTAssertFalse(harness.center.delivered.contains(oldIdentifier))
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
        harness.center.completeLookups()
        drainCallbacks()

        XCTAssertEqual(Set(harness.center.pending.keys), ["unrelated"])
        XCTAssertEqual(harness.center.delivered, ["unrelated"])
    }

    func testAddFailureIsReported() {
        let harness = CollectionNotificationServiceHarness()
        enable(harness)
        harness.connection("connected")
        harness.connection("disconnected")
        let error = NSError(domain: "notifications", code: 43)

        harness.center.completeAdd(0, error: error)
        drainCallbacks()

        XCTAssertEqual(harness.reportedErrors.first?.0 as NSError?, error)
        XCTAssertTrue(harness.center.pending.isEmpty)
    }

    private func enable(_ harness: CollectionNotificationServiceHarness) {
        harness.service.enable(requestPermission: false) { result in
            XCTAssertEqual(try? result.get(), true)
        }
        harness.center.settingsCallbacks.last?(.authorized)
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
            reportError: { [weak self] error, identifier in self?.reportedErrors.append((error, identifier)) }
        )
        service.start()
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
    var pending: [String: UNNotificationRequest] = [:]
    var delivered: Set<String> = []
    private var pendingLookups: [([String]) -> Void] = []
    private var deliveredLookups: [([String]) -> Void] = []

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
        pendingLookups.append(completion)
    }

    func getDeliveredIdentifiers(completion: @escaping ([String]) -> Void) {
        deliveredLookups.append(completion)
    }

    func removePendingNotificationRequests(withIdentifiers identifiers: [String]) {
        for identifier in identifiers { pending.removeValue(forKey: identifier) }
    }

    func removeDeliveredNotifications(withIdentifiers identifiers: [String]) {
        delivered.subtract(identifiers)
    }

    func seed(_ identifier: String) {
        pending[identifier] = UNNotificationRequest(
            identifier: identifier, content: UNMutableNotificationContent(), trigger: nil
        )
    }

    func completeAdd(_ index: Int, error: Error? = nil) {
        let add = adds[index]
        if error == nil { pending[add.request.identifier] = add.request }
        add.completion(error)
    }

    func completeLookups() {
        let pendingCallbacks = pendingLookups
        let deliveredCallbacks = deliveredLookups
        pendingLookups.removeAll()
        deliveredLookups.removeAll()
        for completion in pendingCallbacks { completion(Array(pending.keys)) }
        for completion in deliveredCallbacks { completion(Array(delivered)) }
    }
}
