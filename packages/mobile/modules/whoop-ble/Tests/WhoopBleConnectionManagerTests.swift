import XCTest
@testable import WhoopBLE

final class WhoopBleConnectionManagerTests: XCTestCase {
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
}
