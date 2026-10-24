import XCTest
import CoreBluetooth
@testable import WhoopBLE

final class WhoopBleConnectionManagerDiagnosticsTests: XCTestCase {
    func testNativeSessionCentralStatesAndEmptyRestorationAreRecorded() {
        let journal = WhoopBleConnectionDiagnostics(diagnosticDefaults: UserDefaults(suiteName: UUID().uuidString)!)
        let manager = WhoopBleConnectionManager(connectionDiagnostics: journal)
        for state in [CBManagerState.unknown, .resetting, .unsupported, .unauthorized, .poweredOff, .poweredOn] {
            manager.handleCentralManagerStateUpdated(state)
        }
        manager.handleRestoration([])
        let events = journal.payload["events"] as? [[String: Any]] ?? []
        XCTAssertEqual(events.first?["event"] as? String, "native_session_start")
        XCTAssertEqual(events.filter { $0["event"] as? String == "central_state" }
            .compactMap { $0["centralState"] as? String },
            ["unknown", "resetting", "unsupported", "unauthorized", "poweredOff", "poweredOn"])
        XCTAssertEqual(events.last?["event"] as? String, "restoration")
        XCTAssertEqual(events.last?["restoredPeripheralCount"] as? Int, 0)
    }

    func testTimeoutRecordsStageAndReconnectIntentBeforeCleanup() throws {
        let journal = WhoopBleConnectionDiagnostics(diagnosticDefaults: UserDefaults(suiteName: UUID().uuidString)!)
        let manager = WhoopBleConnectionManager(connectTimeoutSeconds: 0.01, connectionDiagnostics: journal)
        let settled = expectation(description: "timeout settled")
        manager.autoReconnect = true
        manager.setState(.subscribing)
        manager.connectCompletion = { _ in settled.fulfill() }
        manager.startHandshakeTimeout(cancelPeripheral: {})
        wait(for: [settled], timeout: 1)
        let event = try XCTUnwrap((journal.payload["events"] as? [[String: Any]])?
            .first { $0["event"] as? String == "handshake_aborted" })
        XCTAssertEqual(event["connectionState"] as? String, "subscribing")
        XCTAssertEqual(event["reason"] as? String, "TIMEOUT")
        XCTAssertEqual(event["reconnectIntent"] as? Bool, true)
        XCTAssertNil(event["errorDomain"])
        XCTAssertFalse(manager.autoReconnect)
    }

    func testDisconnectRecordsOperatingSystemErrorAndAutomaticReconnect() throws {
        let journal = WhoopBleConnectionDiagnostics(diagnosticDefaults: UserDefaults(suiteName: UUID().uuidString)!)
        let manager = WhoopBleConnectionManager(connectionDiagnostics: journal)
        manager.setState(.streaming)
        manager.autoReconnect = true
        var reconnects = 0
        let peripheralId = "11111111-1111-4111-8111-111111111111"
        manager.handleDisconnection(peripheralId: peripheralId, error: NSError(domain: "CBErrorDomain", code: 7,
            userInfo: [NSLocalizedDescriptionKey: "Disconnected"])) { reconnects += 1 }
        let events = journal.payload["events"] as? [[String: Any]] ?? []
        let event = try XCTUnwrap(events.first { $0["event"] as? String == "disconnected" })
        XCTAssertEqual(event["connectionState"] as? String, "streaming")
        XCTAssertEqual(event["errorCode"] as? Int, 7)
        XCTAssertEqual(event["peripheralId"] as? String, peripheralId)
        XCTAssertEqual(events.last?["event"] as? String, "connect_requested")
        XCTAssertEqual(events.last?["reason"] as? String, "automatic_reconnect")
        XCTAssertEqual(reconnects, 1)
    }

    func testHandshakeFailureRetainsBluetoothErrorMetadataBeforeCancellation() throws {
        let journal = WhoopBleConnectionDiagnostics(diagnosticDefaults: UserDefaults(suiteName: UUID().uuidString)!)
        let manager = WhoopBleConnectionManager(connectionDiagnostics: journal)
        manager.setState(.discoveringServices)
        manager.autoReconnect = true
        let error = NSError(domain: "CBATTErrorDomain", code: 10,
                            userInfo: [NSLocalizedDescriptionKey: "Attribute not found"])
        manager.abortHandshake(with: .serviceDiscoveryFailed(error.localizedDescription), underlyingError: error) {
            let event = (journal.payload["events"] as? [[String: Any]])?.last
            XCTAssertEqual(event?["event"] as? String, "handshake_aborted")
            XCTAssertEqual(event?["reconnectIntent"] as? Bool, true)
        }
        let event = try XCTUnwrap((journal.payload["events"] as? [[String: Any]])?
            .first { $0["event"] as? String == "handshake_aborted" })
        XCTAssertEqual(event["errorDomain"] as? String, "CBATTErrorDomain")
        XCTAssertEqual(event["errorCode"] as? Int, 10)
        XCTAssertEqual(event["errorDescription"] as? String, "Attribute not found")
        XCTAssertEqual(event["reason"] as? String, "SERVICE_DISCOVERY_FAILED")
    }

    func testIntentionalDisconnectCanClearJournalAfterCleanupAndCompletion() {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let journal = WhoopBleConnectionDiagnostics(diagnosticDefaults: defaults)
        let manager = WhoopBleConnectionManager(connectionDiagnostics: journal)
        manager.setState(.streaming)
        let settled = expectation(description: "disconnect settled")
        manager.disconnect {
            XCTAssertTrue((journal.payload["events"] as? [[String: Any]] ?? [])
                .contains { $0["event"] as? String == "disconnect_requested" })
            XCTAssertEqual(manager.state, .idle)
            journal.clear()
            settled.fulfill()
        }
        wait(for: [settled], timeout: 1)
        let recreated = WhoopBleConnectionDiagnostics(diagnosticDefaults: defaults)
        XCTAssertEqual((recreated.payload["events"] as? [[String: Any]])?.count, 0)
    }
}

final class WhoopBleConnectionManagerTests: XCTestCase {
    func testRestoredStreamingEmitsFinalStreamingSnapshotAfterReconnect() {
        let manager = WhoopBleConnectionManager()
        manager.setState(.ready)
        var snapshots: [ConnectionState] = [manager.state]

        WhoopBleStreamRestorer.restoreIfNeeded(
            wasStreaming: true,
            startStreaming: manager.startStreaming,
            activateImu: {},
            emitDeviceState: { snapshots.append(manager.state) }
        )

        XCTAssertEqual(manager.state, .streaming)
        XCTAssertEqual(snapshots, [.ready, .streaming])
    }

    func testSyncOnBleQueueRunsInlineWhenAlreadyOnBleQueue() {
        let manager = WhoopBleConnectionManager()
        let expectation = expectation(description: "ble queue work finished")

        manager.bleQueue.async {
            let value = manager.syncOnBleQueue {
                "executed"
            }

            XCTAssertEqual(value, "executed")
            expectation.fulfill()
        }

        waitForExpectations(timeout: 1)
    }

    func testServiceDiscoveryErrorCancelsAndSettlesExactlyOnce() {
        let manager = WhoopBleConnectionManager()
        var results: [Result<Bool, WhoopBleConnectionError>] = []
        var cancellationCount = 0
        manager.connectCompletion = { results.append($0) }
        manager.setState(.discoveringServices)

        manager.abortHandshake(
            with: .serviceDiscoveryFailed("service discovery unavailable")
        ) {
            cancellationCount += 1
        }
        manager.abortHandshake(with: .timeout) {
            cancellationCount += 1
        }

        XCTAssertEqual(cancellationCount, 1)
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(manager.state, .idle)
        guard case .failure(.serviceDiscoveryFailed(let message)) = results.first else {
            return XCTFail("Expected a typed service-discovery failure")
        }
        XCTAssertEqual(message, "service discovery unavailable")
    }

    func testCharacteristicDiscoveryErrorCancelsAndSettlesExactlyOnce() {
        let manager = WhoopBleConnectionManager()
        var results: [Result<Bool, WhoopBleConnectionError>] = []
        var cancellationCount = 0
        manager.connectCompletion = { results.append($0) }
        manager.setState(.discoveringServices)

        manager.abortHandshake(
            with: .characteristicDiscoveryFailed("characteristic discovery unavailable")
        ) {
            cancellationCount += 1
        }
        manager.finishConnect(.success(true))

        XCTAssertEqual(cancellationCount, 1)
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(manager.state, .idle)
        guard case .failure(.characteristicDiscoveryFailed(let message)) = results.first else {
            return XCTFail("Expected a typed characteristic-discovery failure")
        }
        XCTAssertEqual(message, "characteristic discovery unavailable")
    }

    func testHandshakeTimesOutWhenDiscoveryCallbackNeverArrives() {
        let manager = WhoopBleConnectionManager(connectTimeoutSeconds: 0.01)
        let completionExpectation = expectation(description: "connect completion settled")
        var result: Result<Bool, WhoopBleConnectionError>?
        var cancellationCount = 0
        manager.connectCompletion = {
            result = $0
            completionExpectation.fulfill()
        }
        manager.setState(.discoveringServices)

        manager.startHandshakeTimeout {
            cancellationCount += 1
        }

        waitForExpectations(timeout: 1)
        XCTAssertEqual(cancellationCount, 1)
        XCTAssertEqual(manager.state, .idle)
        guard case .failure(.timeout) = result else {
            return XCTFail("Expected the full handshake to time out")
        }
    }

    func testHandshakeTimesOutWhileWaitingForNotificationSubscriptions() {
        let manager = WhoopBleConnectionManager(connectTimeoutSeconds: 0.01)
        let completionExpectation = expectation(description: "connect completion settled")
        var result: Result<Bool, WhoopBleConnectionError>?
        var cancellationCount = 0
        manager.connectCompletion = {
            result = $0
            completionExpectation.fulfill()
        }
        manager.setState(.subscribing)

        manager.startHandshakeTimeout {
            cancellationCount += 1
        }

        waitForExpectations(timeout: 1)
        XCTAssertEqual(cancellationCount, 1)
        XCTAssertEqual(manager.state, .idle)
        guard case .failure(.timeout) = result else {
            return XCTFail("Expected notification subscription to time out")
        }
    }

    func testNotificationSubscriptionFailureCancelsCleansUpAndSettlesConnect() {
        let manager = WhoopBleConnectionManager()
        var results: [Result<Bool, WhoopBleConnectionError>] = []
        var cancellationCount = 0
        manager.connectCompletion = { results.append($0) }
        manager.autoReconnect = true
        manager.setState(.subscribing)

        let previouslyStreaming = manager.settleNotificationSubscriptionUpdate(
            .failed,
            failureDetail: "DATA_FROM_STRAP rejected notifications"
        ) {
            cancellationCount += 1
        }
        _ = manager.settleNotificationSubscriptionUpdate(
            .ready,
            failureDetail: "late success"
        ) {
            cancellationCount += 1
        }

        XCTAssertNil(previouslyStreaming)
        XCTAssertEqual(cancellationCount, 1)
        XCTAssertFalse(manager.autoReconnect)
        XCTAssertEqual(manager.state, .idle)
        XCTAssertEqual(results.count, 1)
        guard case .failure(.notificationSubscriptionFailed(let message)) = results.first else {
            return XCTFail("Expected a typed notification-subscription failure")
        }
        XCTAssertEqual(message, "DATA_FROM_STRAP rejected notifications")
    }

    func testConfirmedSubscriptionsSettleConnectAndRestoreStreamingIntent() {
        let manager = WhoopBleConnectionManager()
        var results: [Result<Bool, WhoopBleConnectionError>] = []
        var cancellationCount = 0
        manager.connectCompletion = { results.append($0) }
        manager.wasStreaming = true
        manager.setState(.subscribing)

        let previouslyStreaming = manager.settleNotificationSubscriptionUpdate(
            .ready,
            failureDetail: "unused"
        ) {
            cancellationCount += 1
        }

        XCTAssertEqual(previouslyStreaming, true)
        XCTAssertEqual(cancellationCount, 0)
        XCTAssertFalse(manager.wasStreaming)
        XCTAssertEqual(manager.state, .ready)
        XCTAssertEqual(results.count, 1)
        guard case .success(true) = results.first else {
            return XCTFail("Expected confirmed subscriptions to complete the connection")
        }
    }

    func testPendingSubscriptionsDoNotSettleConnectOrAllowStreamingCommands() {
        let manager = WhoopBleConnectionManager()
        var results: [Result<Bool, WhoopBleConnectionError>] = []
        manager.connectCompletion = { results.append($0) }
        manager.setState(.subscribing)

        let ignoredResult = manager.settleNotificationSubscriptionUpdate(
            .ignored,
            failureDetail: "unused",
            cancelPeripheral: {
                XCTFail("Ignored subscriptions must not cancel the peripheral")
            }
        )
        let previouslyStreaming = manager.settleNotificationSubscriptionUpdate(
            .waiting,
            failureDetail: "unused",
            cancelPeripheral: {
                XCTFail("Waiting subscriptions must not cancel the peripheral")
            }
        )

        XCTAssertNil(ignoredResult)
        XCTAssertNil(previouslyStreaming)
        XCTAssertFalse(manager.startStreaming())
        XCTAssertEqual(manager.state, .subscribing)
        XCTAssertTrue(results.isEmpty)
    }

    func testSuccessfulHandshakeCancelsTimeoutAndSettlesExactlyOnce() {
        let manager = WhoopBleConnectionManager(connectTimeoutSeconds: 0.01)
        let settledExpectation = expectation(description: "connect completion settled")
        let noTimeoutExpectation = expectation(description: "timeout cancelled")
        noTimeoutExpectation.isInverted = true
        var results: [Result<Bool, WhoopBleConnectionError>] = []
        manager.connectCompletion = {
            results.append($0)
            settledExpectation.fulfill()
        }
        manager.setState(.discoveringServices)
        manager.startHandshakeTimeout {
            noTimeoutExpectation.fulfill()
        }

        manager.finishConnect(.success(true))
        manager.finishConnect(.failure(.timeout))

        wait(for: [settledExpectation, noTimeoutExpectation], timeout: 0.05)
        XCTAssertEqual(results.count, 1)
        guard case .success(true) = results.first else {
            return XCTFail("Expected one successful completion")
        }
    }

    func testExplicitCancellationSettlesPendingConnectExactlyOnce() {
        let manager = WhoopBleConnectionManager()
        let completionExpectation = expectation(description: "connect completion settled")
        var results: [Result<Bool, WhoopBleConnectionError>] = []
        manager.connectCompletion = {
            results.append($0)
            completionExpectation.fulfill()
        }
        manager.setState(.discoveringServices)

        manager.disconnect()

        waitForExpectations(timeout: 1)
        manager.finishConnect(.success(true))
        XCTAssertEqual(results.count, 1)
        guard case .failure(.disconnected(nil)) = results.first else {
            return XCTFail("Expected explicit cancellation to settle as disconnected")
        }
    }

    func testConfirmedSubscriptionsPublishConnectedWithoutAnExpoDelegate() {
        let manager = WhoopBleConnectionManager()
        manager.setState(.subscribing)
        let delivery = connectionEventExpectation(state: "connected")

        _ = manager.settleNotificationSubscriptionUpdate(
            .ready,
            failureDetail: "unused",
            cancelPeripheral: { XCTFail("Successful subscriptions must not cancel the peripheral") }
        )

        wait(for: [delivery], timeout: 1)
        XCTAssertEqual(manager.state, .ready)
    }

    func testRestoredSubscriptionsPublishConnectedBeforeStreamingResumes() {
        let manager = WhoopBleConnectionManager()
        manager.setState(.subscribing)
        manager.wasStreaming = true
        let delivery = connectionEventExpectation(state: "connected")

        let previouslyStreaming = manager.settleNotificationSubscriptionUpdate(
            .ready,
            failureDetail: "unused",
            cancelPeripheral: { XCTFail("Restored subscriptions must not cancel the peripheral") }
        )

        wait(for: [delivery], timeout: 1)
        XCTAssertEqual(previouslyStreaming, true)
        XCTAssertEqual(manager.state, .ready)
    }

    func testIntentionalDisconnectPublishesAfterNativeCleanup() {
        let manager = WhoopBleConnectionManager()
        manager.setState(.streaming)
        manager.autoReconnect = true
        let delivery = connectionEventExpectation(state: "intentionallyDisconnected") { [weak manager] in
            XCTAssertEqual(manager?.state, .idle)
            XCTAssertEqual(manager?.autoReconnect, false)
        }

        manager.disconnect()

        wait(for: [delivery], timeout: 1)
    }

    func testUnexpectedDisconnectPublishesBeforeAutomaticReconnect() {
        let manager = WhoopBleConnectionManager()
        manager.setState(.streaming)
        manager.autoReconnect = true
        var didReconnect = false
        let delivery = connectionEventExpectation(state: "disconnected") { [weak manager] in
            XCTAssertEqual(manager?.state, .idle)
            XCTAssertFalse(didReconnect)
        }

        manager.handleDisconnection(peripheralId: "strap-id", error: nil) {
            didReconnect = true
        }

        wait(for: [delivery], timeout: 1)
        XCTAssertTrue(didReconnect)
        XCTAssertEqual(manager.state, .connecting)
        XCTAssertTrue(manager.wasStreaming)
    }

    func testActivitySnapshotIncludesOnlyNativeConnectionsThatAreCollecting() {
        let manager = WhoopBleConnectionManager()
        let cases: [(ConnectionState, [String])] = [
            (.idle, []),
            (.scanning, []),
            (.connecting, []),
            (.discoveringServices, []),
            (.subscribing, []),
            (.ready, ["whoop"]),
            (.streaming, ["whoop"]),
        ]

        for (state, expectedCollectors) in cases {
            manager.setState(state)
            let collectors = NSMutableSet()

            manager.syncOnBleQueue {
                NotificationCenter.default.post(
                    name: Notification.Name("Dofek.collectionActivityRequested"),
                    object: collectors
                )
            }

            XCTAssertEqual(collectors, NSSet(array: expectedCollectors), "state: \(state)")
        }
    }

    func testActivitySnapshotReflectsNativeDisconnect() {
        let manager = WhoopBleConnectionManager()
        manager.setState(.ready)
        let disconnected = expectation(description: "native disconnect completed")

        manager.disconnect {
            disconnected.fulfill()
        }
        wait(for: [disconnected], timeout: 1)

        let collectors = NSMutableSet()
        NotificationCenter.default.post(
            name: Notification.Name("Dofek.collectionActivityRequested"),
            object: collectors
        )

        XCTAssertFalse(collectors.contains("whoop"))
    }

    func testCollectionActivityObserverDoesNotRetainTheManager() {
        weak var retainedManager: WhoopBleConnectionManager?

        do {
            let manager = WhoopBleConnectionManager()
            manager.setState(.ready)
            retainedManager = manager
        }

        XCTAssertNil(retainedManager)
    }

    private func connectionEventExpectation(
        state: String,
        onDelivery: @escaping () -> Void = {}
    ) -> XCTestExpectation {
        expectation(
            forNotification: Notification.Name("WhoopBle.connectionStateChanged"),
            object: nil
        ) { notification in
            guard notification.userInfo?["state"] as? String == state else { return false }
            onDelivery()
            return true
        }
    }
}
