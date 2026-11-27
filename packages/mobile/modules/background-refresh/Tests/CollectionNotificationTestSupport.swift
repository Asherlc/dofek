import UserNotifications
import XCTest
@testable import BackgroundRefreshLib

final class CollectionNotificationServiceHarness {
    let center: ControlledCollectionNotificationCenter
    let generationStore: CollectionNotificationGenerationStore
    let cleanupQueue = DispatchQueue(label: "notification-test.cleanup")
    let generationQueue = DispatchQueue(label: "notification-test.generation-io")
    private let notifications = NotificationCenter()
    var reportedErrors: [(Error, String)] = []
    var collectionIsActive = true
    private(set) var service: CollectionNotificationService!

    init(
        center: ControlledCollectionNotificationCenter = .init(),
        isAppActive: Bool = true,
        generationFileURL: URL? = nil
    ) {
        self.center = center
        let fileURL = generationFileURL
            ?? FileManager.default.temporaryDirectory
            .appendingPathComponent("collection-generation-\(UUID().uuidString)")
        generationStore = CollectionNotificationGenerationStore(fileURL: fileURL, queue: generationQueue)
        service = CollectionNotificationService(
            center: center,
            notifications: notifications,
            isAppActive: { isAppActive },
            isCollectionActive: { [weak self] in self?.collectionIsActive == true },
            reportError: { [weak self] error, identifier in self?.reportedErrors.append((error, identifier)) },
            cleanupQueue: cleanupQueue,
            generationStore: generationStore
        )
        service.start()
        flushGeneration()
        flushCleanup()
    }

    func flushCleanup() {
        let flushed = XCTestExpectation(description: "cleanup queue flushed")
        cleanupQueue.async { flushed.fulfill() }
        XCTAssertEqual(XCTWaiter.wait(for: [flushed], timeout: 1), .completed)
    }

    func flushGeneration() {
        let flushed = XCTestExpectation(description: "generation I/O flushed")
        generationQueue.async { flushed.fulfill() }
        XCTAssertEqual(XCTWaiter.wait(for: [flushed], timeout: 1), .completed)
        let main = XCTestExpectation(description: "generation main apply")
        DispatchQueue.main.async { main.fulfill() }
        XCTAssertEqual(XCTWaiter.wait(for: [main], timeout: 1), .completed)
    }

    func connection(_ state: String) {
        notifications.post(
            name: Notification.Name("WhoopBle.connectionStateChanged"), object: nil, userInfo: ["state": state]
        )
    }
}

final class ControlledCollectionNotificationCenter: CollectionNotificationCenter {
    var settingsCallbacks: [(CollectionNotificationAuthorizationStatus) -> Void] = []
    var authorizationCallbacks: [(Bool, Error?) -> Void] = []
    var adds: [(request: UNNotificationRequest, completion: (Error?) -> Void)] = []
    private let lock = NSLock()
    private var pendingStorage: [String: UNNotificationRequest] = [:]
    private var deliveredStorage: Set<String> = []
    private var onRemovePendingGate: (identifier: String, hook: () -> Void)?
    private var pendingLookups: [([String]) -> Void] = []
    private var deliveredLookups: [([String]) -> Void] = []
    private var pendingRemoveInvocationsStorage: [[String]] = []
    private var deliveredRemoveInvocationsStorage: [[String]] = []
    private var pendingLookupCountStorage = 0
    private var deliveredLookupCountStorage = 0

    var pending: [String: UNNotificationRequest] {
        lock.withLock { pendingStorage }
    }

    var delivered: Set<String> {
        get { lock.withLock { deliveredStorage } }
        set { lock.withLock { deliveredStorage = newValue } }
    }

    var pendingRemoveInvocations: [[String]] {
        lock.withLock { pendingRemoveInvocationsStorage }
    }

    var deliveredRemoveInvocations: [[String]] {
        lock.withLock { deliveredRemoveInvocationsStorage }
    }

    var pendingLookupCount: Int {
        lock.withLock { pendingLookupCountStorage }
    }

    var deliveredLookupCount: Int {
        lock.withLock { deliveredLookupCountStorage }
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
        lock.withLock {
            pendingLookupCountStorage += 1
            pendingLookups.append(completion)
        }
    }

    func getDeliveredIdentifiers(completion: @escaping ([String]) -> Void) {
        lock.withLock {
            deliveredLookupCountStorage += 1
            deliveredLookups.append(completion)
        }
    }

    func removePendingNotificationRequests(withIdentifiers identifiers: [String]) {
        let hook = lock.withLock { () -> (() -> Void)? in
            pendingRemoveInvocationsStorage.append(identifiers)
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
        lock.withLock {
            deliveredRemoveInvocationsStorage.append(identifiers)
            deliveredStorage.subtract(identifiers)
        }
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
