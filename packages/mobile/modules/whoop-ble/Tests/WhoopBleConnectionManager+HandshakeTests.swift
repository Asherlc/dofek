import XCTest
import CoreBluetooth
@testable import WhoopBLE

final class WhoopBlePendingReconnectTests: XCTestCase {
    func testAutomaticReconnectRemainsPendingBeyondHandshakeDeadline() {
        let manager = WhoopBleConnectionManager(connectTimeoutSeconds: 0.01)
        manager.syncOnBleQueue {
            manager.setState(.streaming)
            manager.autoReconnect = true
            manager.handleDisconnection(peripheralId: "strap-id", error: nil) {
                manager.startHandshakeTimeout {
                    XCTFail("A passive Bluetooth connection must remain pending")
                }
            }
        }

        afterDeadline(manager) {
            XCTAssertEqual(manager.state, .connecting)
            XCTAssertTrue(manager.autoReconnect)
            XCTAssertTrue(manager.wasStreaming)
        }
    }

    func testExplicitConnectionStillTimesOutExactlyOnceWhileBluetoothIsPending() {
        let manager = WhoopBleConnectionManager(connectTimeoutSeconds: 0.01)
        let settled = expectation(description: "explicit connection times out")
        var results: [Result<Bool, WhoopBleConnectionError>] = []
        var cancellations = 0
        manager.syncOnBleQueue {
            manager.setState(.connecting)
            manager.autoReconnect = true
            manager.connectCompletion = {
                results.append($0)
                settled.fulfill()
            }
            manager.startHandshakeTimeout { cancellations += 1 }
        }

        wait(for: [settled], timeout: 1)
        manager.syncOnBleQueue {
            manager.finishConnect(.success(true))
            XCTAssertEqual(manager.state, .idle)
            XCTAssertFalse(manager.autoReconnect)
            XCTAssertEqual(cancellations, 1)
            XCTAssertEqual(results.count, 1)
            guard case .failure(.timeout) = results.first else {
                return XCTFail("Explicit callers must retain the TIMEOUT contract")
            }
        }
    }

    func testPassiveServiceDiscoveryAndSubscriptionAreStillBounded() {
        for stage in [ConnectionState.discoveringServices, .subscribing] {
            let manager = WhoopBleConnectionManager(connectTimeoutSeconds: 0.01)
            let cancelled = expectation(description: "passive \(stage) times out")
            manager.syncOnBleQueue {
                manager.setState(stage)
                manager.autoReconnect = true
                manager.wasStreaming = true
                manager.startHandshakeTimeout { cancelled.fulfill() }
            }

            wait(for: [cancelled], timeout: 1)
            manager.syncOnBleQueue {
                XCTAssertEqual(manager.state.rawValue, "disconnecting")
                XCTAssertEqual(WhoopBleClientState(manager.state), .connecting)
                XCTAssertTrue(manager.autoReconnect)
                XCTAssertTrue(manager.wasStreaming)
                manager.handleDisconnection(peripheralId: "strap-id", error: nil) {
                    manager.startHandshakeTimeout { XCTFail("Recovery connection must stay pending") }
                }
                XCTAssertEqual(manager.state, .connecting)
            }
        }
    }

    func testTransientAutomaticSetupFailuresRecoverRepeatedlyAndRestoreStreaming() {
        let manager = WhoopBleConnectionManager()
        manager.syncOnBleQueue {
            manager.autoReconnect = true
            manager.wasStreaming = true
            let failures: [WhoopBleConnectionError] = [
                .timeout, .serviceDiscoveryFailed("temporary failure"),
                .characteristicDiscoveryFailed("temporary failure"),
                .notificationSubscriptionFailed("temporary failure"),
            ]
            for failure in failures {
                manager.setState(.discoveringServices)
                var cancellations = 0
                manager.abortHandshake(with: failure) { cancellations += 1 }
                XCTAssertEqual(manager.state.rawValue, "disconnecting")
                XCTAssertTrue(manager.autoReconnect)
                manager.abortHandshake(with: failure) { cancellations += 1 }
                XCTAssertEqual(cancellations, 1, "Late setup failures must not cancel twice")
                var reconnects = 0
                manager.handleDisconnection(peripheralId: "strap-id", error: nil) { reconnects += 1 }
                XCTAssertEqual(reconnects, 1)
                XCTAssertEqual(manager.state, .connecting)
                XCTAssertTrue(manager.wasStreaming)
            }
            manager.setState(.subscribing)
            let wasStreaming = manager.settleNotificationSubscriptionUpdate(
                .ready, failureDetail: "unused", cancelPeripheral: { XCTFail("Ready connection must remain active") })
            XCTAssertEqual(wasStreaming, true)
            WhoopBleStreamRestorer.restoreIfNeeded(
                wasStreaming: wasStreaming ?? false, startStreaming: manager.startStreaming,
                activateImu: {}, emitDeviceState: {})
            XCTAssertEqual(manager.state, .streaming)
        }
    }

    func testStopDuringAutomaticHandshakeCancellationDoesNotRestoreImu() {
        let manager = WhoopBleConnectionManager()
        manager.syncOnBleQueue {
            manager.autoReconnect = true
            manager.wasStreaming = true
            manager.setState(.subscribing)
            manager.abortHandshake(with: .timeout) {}
            XCTAssertTrue(manager.autoReconnect)
            manager.stopStreaming()
            manager.handleDisconnection(peripheralId: "strap-id", error: nil) {}
            manager.setState(.subscribing)
            XCTAssertEqual(manager.settleNotificationSubscriptionUpdate(
                .ready, failureDetail: "unused", cancelPeripheral: {}), false)
            XCTAssertEqual(manager.state, .ready)
        }
    }

    func testDisconnectDuringAutomaticHandshakeCancellationPreventsReconnect() {
        let manager = WhoopBleConnectionManager()
        manager.syncOnBleQueue {
            manager.autoReconnect = true
            manager.wasStreaming = true
            manager.setState(.subscribing)
            manager.abortHandshake(with: .timeout) {}
            XCTAssertTrue(manager.autoReconnect)
        }
        let disconnected = expectation(description: "explicit disconnect overrides recovery")
        manager.disconnect {
            manager.handleDisconnection(peripheralId: "strap-id", error: nil) {
                XCTFail("Explicit disconnect must prevent recovery")
            }
            XCTAssertEqual(manager.state, .idle)
            XCTAssertFalse(manager.autoReconnect)
            XCTAssertFalse(manager.wasStreaming)
            disconnected.fulfill()
        }
        wait(for: [disconnected], timeout: 1)
    }

    func testIncompatiblePeripheralStopsAutomaticRecovery() {
        for failure in [WhoopBleConnectionError.serviceNotFound, .characteristicsNotFound] {
            let manager = WhoopBleConnectionManager()
            manager.syncOnBleQueue {
                manager.autoReconnect = true
                manager.setState(.discoveringServices)
                manager.abortHandshake(with: failure) {}
                XCTAssertEqual(manager.state, .idle)
                XCTAssertFalse(manager.autoReconnect)
            }
        }
    }

    func testPreviousExplicitTimeoutCannotCancelReplacementPassiveConnection() {
        let manager = WhoopBleConnectionManager(connectTimeoutSeconds: 0.01)
        manager.syncOnBleQueue {
            manager.setState(.connecting)
            manager.connectCompletion = { _ in }
            manager.startHandshakeTimeout { XCTFail("Settled attempt must not cancel its replacement") }
            manager.finishConnect(.failure(.disconnected(nil)))
            manager.autoReconnect = true
            manager.startHandshakeTimeout { XCTFail("Replacement passive attempt must remain pending") }
        }

        afterDeadline(manager) {
            XCTAssertEqual(manager.state, .connecting)
            XCTAssertTrue(manager.autoReconnect)
        }
    }

    func testExplicitCancellationClearsPassiveReconnectAndItsDeadline() {
        let manager = WhoopBleConnectionManager(connectTimeoutSeconds: 0.01)
        manager.syncOnBleQueue {
            manager.setState(.connecting)
            manager.autoReconnect = true
            manager.startHandshakeTimeout { XCTFail("Intentional disconnect must cancel the deadline") }
        }
        manager.disconnect()

        afterDeadline(manager) {
            XCTAssertEqual(manager.state, .idle)
            XCTAssertFalse(manager.autoReconnect)
        }
    }

    private func afterDeadline(_ manager: WhoopBleConnectionManager, check: @escaping () -> Void) {
        let checked = expectation(description: "observed after handshake deadline")
        manager.bleQueue.asyncAfter(deadline: .now() + 0.05) {
            check()
            checked.fulfill()
        }
        wait(for: [checked], timeout: 1)
    }
}

final class WhoopBleHandshakeTests: XCTestCase {
    func testOptionalMetadataDiscoveryErrorPreservesPendingHandshakeAndReconnect() {
        for stage in [ConnectionState.discoveringServices, .subscribing] {
            let manager = WhoopBleConnectionManager()
            manager.setState(stage)
            manager.autoReconnect = true
            var completed = false
            manager.connectCompletion = { _ in completed = true }
            manager.handleCharacteristicDiscoveryError(
                serviceUUID: CBUUID(string: "180A"),
                error: NSError(domain: "CBATTErrorDomain", code: 10),
                cancelPeripheral: { XCTFail("Optional metadata must not cancel capture") }
            )
            XCTAssertEqual(manager.state, stage)
            XCTAssertTrue(manager.autoReconnect)
            XCTAssertFalse(completed)
            manager.setState(.subscribing)
            _ = manager.settleNotificationSubscriptionUpdate(
                .ready, failureDetail: "unused", cancelPeripheral: {}
            )
            XCTAssertTrue(completed)
            XCTAssertEqual(manager.state, .ready)
        }
    }

    func testHandshakeDeadlineRetainsItsCallbackAdapterUntilCancellation() {
        let manager = WhoopBleConnectionManager(connectTimeoutSeconds: 0.01)
        let cancelled = expectation(description: "callback adapter cancels its native connection")
        manager.syncOnBleQueue {
            let callbackAdapter = TestWhoopPeripheralConnection()
            callbackAdapter.onCancel = { cancelled.fulfill() }
            manager.autoReconnect = true
            manager.setState(.discoveringServices)
            manager.startHandshakeTimeout(for: callbackAdapter)
        }
        wait(for: [cancelled], timeout: 0.2)
    }

    func testPeripheralHandshakeDeadlineCancelsOwnedPeripheralAndPreservesRecovery() {
        let manager = WhoopBleConnectionManager(connectTimeoutSeconds: 0.01)
        let peripheral = TestWhoopPeripheralConnection()
        let checked = expectation(description: "peripheral deadline cancelled")
        manager.syncOnBleQueue {
            manager.setConnectedPeripheral(peripheral)
            manager.autoReconnect = true
            manager.setState(.discoveringServices)
            manager.startHandshakeTimeout(for: peripheral)
            manager.bleQueue.asyncAfter(deadline: .now() + 0.05) {
                XCTAssertEqual(peripheral.cancellations, 1)
                XCTAssertTrue(manager.connectedPeripheral === peripheral)
                XCTAssertEqual(manager.state, .disconnecting)
                XCTAssertTrue(manager.autoReconnect)
                checked.fulfill()
            }
        }
        wait(for: [checked], timeout: 1)
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

        manager.handleCharacteristicDiscoveryError(
            serviceUUID: WhoopBleConstants.allServiceUUIDs[0],
            error: NSError(domain: "CBATTErrorDomain", code: 10,
                           userInfo: [NSLocalizedDescriptionKey: "characteristic discovery unavailable"])
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
