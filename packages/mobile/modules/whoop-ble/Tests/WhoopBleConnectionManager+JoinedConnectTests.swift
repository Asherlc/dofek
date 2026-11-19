import CoreBluetooth
import Dispatch
import XCTest
@testable import WhoopBLE

final class WhoopBleJoinedConnectTests: XCTestCase {
    func testCallersJoinDiscoveryAndSubscriptionWithoutReplacingExplicitOwnerDeadline() throws {
        let (manager, peripheral) = restore()
        var ownerResults: [Bool] = []
        var discoveryResults: [Bool] = []
        var subscriptionResults: [Bool] = []
        let deadline = try manager.syncOnBleQueue {
            manager.connectCompletion = { ownerResults.append((try? $0.get()) == true) }
            manager.startHandshakeTimeout(for: peripheral)
            manager.handlePeripheralConnected(peripheral)
            return try XCTUnwrap(manager.handshakeTimeoutWorkItem)
        }

        manager.connect(peripheralId: peripheral.identifier.uuidString) {
            discoveryResults.append((try? $0.get()) == true)
        }
        manager.syncOnBleQueue {
            XCTAssertTrue(discoveryResults.isEmpty)
            XCTAssertTrue(manager.handshakeTimeoutWorkItem === deadline)
            manager.setState(.subscribing)
        }
        manager.connect(peripheralId: peripheral.identifier.uuidString) {
            subscriptionResults.append((try? $0.get()) == true)
        }
        manager.syncOnBleQueue {
            XCTAssertTrue(ownerResults.isEmpty)
            XCTAssertTrue(discoveryResults.isEmpty)
            XCTAssertTrue(subscriptionResults.isEmpty)
            XCTAssertTrue(manager.handshakeTimeoutWorkItem === deadline)
            XCTAssertEqual(peripheral.connections, 0)
            XCTAssertEqual(makeReady(manager), true)
            XCTAssertEqual(ownerResults, [true])
            XCTAssertEqual(discoveryResults, [true])
            XCTAssertEqual(subscriptionResults, [true])
            XCTAssertTrue(deadline.isCancelled)
        }
    }

    func testCallersReuseReadyAndStreamingConnections() {
        let (manager, peripheral) = restore()
        var results: [Bool] = []
        manager.syncOnBleQueue {
            manager.handlePeripheralConnected(peripheral)
            manager.setState(.subscribing)
            _ = makeReady(manager)
        }

        manager.connect(peripheralId: peripheral.identifier.uuidString) { results.append((try? $0.get()) == true) }
        manager.syncOnBleQueue {
            XCTAssertEqual(results, [true])
            XCTAssertEqual(manager.state, .ready)
            XCTAssertTrue(manager.startStreaming())
        }
        manager.connect(peripheralId: peripheral.identifier.uuidString) { results.append((try? $0.get()) == true) }
        manager.syncOnBleQueue {
            XCTAssertEqual(results, [true, true])
            XCTAssertEqual(manager.state, .streaming)
            XCTAssertEqual(peripheral.connections, 0)
            XCTAssertEqual(peripheral.cancellations, 0)
            XCTAssertNil(manager.handshakeTimeoutWorkItem)
        }
    }

    func testWaiterTimeoutLeavesOtherCallerAndPassiveConnectionInPlace() {
        let (manager, peripheral) = restore(connectTimeoutSeconds: 0.01)
        let settled = expectation(description: "joined caller's wait elapsed")
        var expirations = 0
        var remainingResults: [Bool] = []
        manager.syncOnBleQueue {
            manager.connect(peripheralId: peripheral.identifier.uuidString) { result in
                expirations += 1
                defer { settled.fulfill() }
                guard case .failure(.timeout) = result else {
                    return XCTFail("Expected TIMEOUT from the joined caller's deadline")
                }
                XCTAssertTrue(remainingResults.isEmpty)
                XCTAssertTrue(manager.connectedPeripheral === peripheral)
                XCTAssertEqual(manager.state, .connecting)
                XCTAssertEqual(peripheral.cancellations, 0)
                XCTAssertTrue(manager.autoReconnect)
                XCTAssertTrue(manager.wasStreaming)
                XCTAssertNil(manager.handshakeTimeoutWorkItem)
                manager.stopStreaming()
                manager.handlePeripheralConnected(peripheral)
                manager.setState(.subscribing)
                XCTAssertEqual(self.makeReady(manager), false, "Stop clears the native streaming intent")
            }
            manager.connect(peripheralId: peripheral.identifier.uuidString) {
                remainingResults.append((try? $0.get()) == true)
            }
        }

        wait(for: [settled], timeout: 1)
        manager.syncOnBleQueue {
            XCTAssertEqual(manager.state, .ready)
            XCTAssertEqual(expirations, 1)
            XCTAssertEqual(remainingResults, [true])
        }
    }

    func testTransientFailureSettlesWaiterAndRetryWaitsForNativeCancellation() {
        let (manager, peripheral) = restore()
        var results: [Result<Bool, WhoopBleConnectionError>] = []
        manager.connect(peripheralId: peripheral.identifier.uuidString) { results.append($0) }
        manager.syncOnBleQueue {
            XCTAssertTrue(results.isEmpty)
            manager.handlePeripheralConnected(peripheral)
            manager.abortHandshake(for: peripheral, with: .serviceDiscoveryFailed("temporary"))
            XCTAssertEqual(results.count, 1)
            if case .failure(.serviceDiscoveryFailed("temporary")) = results.first {} else {
                XCTFail("Expected the native setup failure")
            }
            XCTAssertEqual(manager.state, .disconnecting)
            XCTAssertTrue(manager.autoReconnect)
            XCTAssertEqual(peripheral.cancellations, 1)
            peripheral.state = .disconnecting
        }

        var cancellingResults: [Result<Bool, WhoopBleConnectionError>] = []
        var retryResults: [Bool] = []
        manager.connect(peripheralId: peripheral.identifier.uuidString) { cancellingResults.append($0) }
        manager.retryConnection { retryResults.append($0) }
        manager.syncOnBleQueue {
            guard case .failure(.disconnected) = cancellingResults.first else {
                return XCTFail("Expected connect to fail while the native attempt cancels")
            }
            XCTAssertEqual(cancellingResults.count, 1)
            XCTAssertEqual(retryResults, [true])
            XCTAssertEqual(peripheral.connections, 0)
            manager.handlePeripheralDisconnected(peripheral, error: nil)
            XCTAssertEqual(peripheral.connections, 1)
            XCTAssertEqual(manager.state, .connecting)
            XCTAssertNil(manager.handshakeTimeoutWorkItem)
            XCTAssertEqual(results.count, 1)
        }
    }

    func testIntentionalDisconnectSettlesWaiterBeforeCompletionAndIgnoresLateCallbacks() {
        let (manager, peripheral) = restore()
        var results: [Result<Bool, WhoopBleConnectionError>] = []
        let disconnected = expectation(description: "intentional disconnect completed")
        manager.connect(peripheralId: peripheral.identifier.uuidString) { results.append($0) }
        manager.syncOnBleQueue { XCTAssertTrue(results.isEmpty) }

        manager.disconnect {
            XCTAssertEqual(results.count, 1)
            if case .failure(.disconnected) = results.first {} else {
                XCTFail("Expected intentional disconnect to settle the caller")
            }
            XCTAssertEqual(manager.state, .idle)
            manager.handlePeripheralConnected(peripheral)
            manager.handlePeripheralDisconnected(peripheral, error: nil)
            XCTAssertNil(self.makeReady(manager))
            XCTAssertEqual(manager.state, .idle)
            XCTAssertFalse(manager.autoReconnect)
            XCTAssertFalse(manager.wasStreaming)
            XCTAssertEqual(peripheral.connections, 0)
            XCTAssertEqual(peripheral.cancellations, 1)
            XCTAssertEqual(results.count, 1)
            disconnected.fulfill()
        }
        wait(for: [disconnected], timeout: 1)
    }

    func testReplacementSettlesDisplacedWaiterAndIgnoresPreviousStrapCallbacks() {
        let (manager, previous) = restore()
        let replacement = TestWhoopPeripheralConnection()
        replacement.state = .connecting
        let delegate = DisconnectionObserver()
        let disconnected = expectation(description: "publishes the displaced strap's disconnect")
        disconnected.assertForOverFulfill = true
        let observedQueue = DispatchSpecificKey<Bool>()
        manager.bleQueue.setSpecific(key: observedQueue, value: true)
        let observer = NotificationCenter.default.addObserver(
            forName: WhoopBleConnectionEvent.name, object: nil, queue: nil
        ) { notification in
            guard DispatchQueue.getSpecific(key: observedQueue) == true,
                  notification.userInfo?["state"] as? String == WhoopBleConnectionEvent.disconnected.rawValue else { return }
            disconnected.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(observer) }
        let (unrelatedManager, unrelatedPeripheral) = restore()
        unrelatedManager.syncOnBleQueue {
            unrelatedManager.autoReconnect = false
            unrelatedManager.handlePeripheralDisconnected(unrelatedPeripheral, error: nil)
        }
        manager.syncOnBleQueue { manager.delegate = delegate }
        var previousResults: [Result<Bool, WhoopBleConnectionError>] = []
        var unknownResults: [Result<Bool, WhoopBleConnectionError>] = []
        var replacementResults: [Bool] = []

        manager.connect(peripheralId: previous.identifier.uuidString) { previousResults.append($0) }
        manager.connect(peripheralId: replacement.identifier.uuidString) { unknownResults.append($0) }
        manager.syncOnBleQueue {
            XCTAssertTrue(previousResults.isEmpty)
            if case .failure(.peripheralNotFound) = unknownResults.first {} else {
                XCTFail("Expected the different strap's failed lookup to preserve the existing attempt")
            }
            manager.handleRestoredPeripheral(replacement)
            XCTAssertEqual(previousResults.count, 1)
            if case .failure(.disconnected) = previousResults.first {} else {
                XCTFail("Expected displacement to settle the previous strap's waiter")
            }
            XCTAssertEqual(previous.cancellations, 1)
            XCTAssertEqual(delegate.peripheralIds, [previous.identifier.uuidString])
            XCTAssertTrue(manager.connectedPeripheral === replacement)
        }

        manager.connect(peripheralId: replacement.identifier.uuidString) { replacementResults.append((try? $0.get()) == true) }
        manager.syncOnBleQueue {
            manager.handlePeripheralConnected(previous)
            manager.handlePeripheralDisconnected(previous, error: nil)
            XCTAssertEqual(manager.state, .connecting)
            XCTAssertTrue(replacementResults.isEmpty)
            manager.handlePeripheralConnected(replacement)
            manager.setState(.subscribing)
            XCTAssertEqual(makeReady(manager), true)
            XCTAssertEqual(replacementResults, [true])
            XCTAssertEqual(previousResults.count, 1)
            XCTAssertEqual(delegate.peripheralIds, [previous.identifier.uuidString])
        }
        wait(for: [disconnected], timeout: 1)
    }

    private func restore(connectTimeoutSeconds: TimeInterval = 10)
        -> (WhoopBleConnectionManager, TestWhoopPeripheralConnection) {
        let manager = WhoopBleConnectionManager(connectTimeoutSeconds: connectTimeoutSeconds)
        let peripheral = TestWhoopPeripheralConnection()
        peripheral.state = .connecting
        manager.syncOnBleQueue {
            manager.centralManager = TestWhoopCentralManager()
            manager.handleRestoredPeripheral(peripheral)
        }
        return (manager, peripheral)
    }

    private func makeReady(_ manager: WhoopBleConnectionManager) -> Bool? {
        manager.settleNotificationSubscriptionUpdate(
            .ready,
            failureDetail: "unused",
            cancelPeripheral: { XCTFail("Readiness cancelled the connection") }
        )
    }
}

private final class DisconnectionObserver: WhoopBleConnectionManagerDelegate {
    private(set) var peripheralIds: [String] = []

    func connectionManagerDidDisconnect(_ manager: WhoopBleConnectionManager, peripheralId: String, error: Error?) {
        XCTAssertEqual(manager.state, .idle)
        XCTAssertNil(manager.connectedPeripheral)
        peripheralIds.append(peripheralId)
    }

    func connectionManagerDidBecomeReady(
        _ manager: WhoopBleConnectionManager, peripheral: any WhoopBlePeripheralConnection,
        cmdCharacteristic: CBCharacteristic, wasStreaming: Bool
    ) {}

    func connectionManager(_ manager: WhoopBleConnectionManager, didReceiveData data: Data) {}
    func connectionManager(_ manager: WhoopBleConnectionManager, didReceiveCommandResponse data: Data) {}
}
