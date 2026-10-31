import CoreBluetooth
import XCTest
@testable import WhoopBLE

final class WhoopBlePeripheralCallbackTests: XCTestCase {
    func testNotificationCallbacksUseUnderlyingIdentityAcrossAdapters() {
        let manager = WhoopBleConnectionManager()
        let nativeSource = NSObject()
        let owned = TestWhoopPeripheralConnection(notificationSource: nativeSource)
        let callback = TestWhoopPeripheralConnection(identifier: owned.identifier, notificationSource: nativeSource)
        let stale = TestWhoopPeripheralConnection(identifier: owned.identifier)
        let service = CBMutableService(type: WhoopBleConstants.gen4ServiceUUID, primary: true)
        let command = CBMutableCharacteristic(
            type: WhoopBleConstants.cmdToStrapUUID(forService: service.uuid),
            properties: .write, value: nil, permissions: .writeable)
        let data = CBMutableCharacteristic(
            type: WhoopBleConstants.dataFromStrapUUID(forService: service.uuid),
            properties: .notify, value: nil, permissions: .readable)
        service.characteristics = [command, data]
        manager.syncOnBleQueue {
            manager.setConnectedPeripheral(owned)
            manager.autoReconnect = true
            manager.setState(.discoveringServices)
            manager.handleCharacteristicsDiscovered(owned, service: service)
            XCTAssertEqual(manager.state, .subscribing)

            let failure = NSError(domain: "subscription", code: 1)
            manager.handleNotificationStateUpdated(stale, characteristic: data, error: failure)
            XCTAssertEqual(manager.state, .subscribing, "Same UUID with another native identity is stale")
            XCTAssertEqual(stale.cancellations, 0)

            manager.handleNotificationStateUpdated(callback, characteristic: data, error: failure)
            XCTAssertEqual(manager.state, .disconnecting)
            XCTAssertTrue(manager.connectedPeripheral === owned)
            XCTAssertTrue(manager.autoReconnect)
            XCTAssertEqual(callback.cancellations, 1)
        }
    }

    func testMetadataDiscoveryReadsOwnedPeripheralWithoutInterruptingSubscriptions() {
        let manager = WhoopBleConnectionManager()
        let owned = TestWhoopPeripheralConnection()
        let stale = TestWhoopPeripheralConnection()
        let service = CBMutableService(type: CBUUID(string: "180A"), primary: true)
        let model = CBMutableCharacteristic(
            type: CBUUID(string: "2A24"), properties: .read, value: nil, permissions: .readable)
        let writeOnly = CBMutableCharacteristic(
            type: CBUUID(string: "2A25"), properties: .write, value: nil, permissions: .writeable)
        service.characteristics = [model, writeOnly]
        manager.syncOnBleQueue {
            manager.setConnectedPeripheral(owned)
            manager.autoReconnect = true
            manager.setState(.subscribing)

            manager.handleCharacteristicsDiscovered(stale, service: service)
            XCTAssertTrue(stale.reads.isEmpty)
            manager.handleCharacteristicsDiscovered(owned, service: service)

            XCTAssertEqual(owned.reads.count, 1)
            XCTAssertTrue(owned.reads.first === model)
            XCTAssertEqual(manager.state, .subscribing)
            XCTAssertTrue(manager.autoReconnect)
            XCTAssertEqual(owned.cancellations, 0)
        }
    }

    func testCommandsUseOwnedPeripheralAndCommandCharacteristicAfterReconnect() throws {
        let manager = WhoopBleConnectionManager()
        let peripheral = TestWhoopPeripheralConnection()
        let command = CBMutableCharacteristic(
            type: WhoopBleConstants.cmdToStrapUUID(forService: WhoopBleConstants.gen4ServiceUUID),
            properties: .write, value: nil, permissions: .writeable)
        try manager.syncOnBleQueue {
            manager.setConnectedPeripheral(peripheral)
            manager.autoReconnect = true
            manager.handlePeripheralDisconnected(peripheral, error: nil)
            manager.setDiscoveredCharacteristics(
                cmdCharacteristic: command, cmdResponseCharacteristic: nil, dataCharacteristic: nil)

            manager.writeToStrap(Data([0xAA, 0x01]))

            let write = try XCTUnwrap(peripheral.writes.first)
            XCTAssertEqual(peripheral.writes.count, 1)
            XCTAssertEqual(write.0, Data([0xAA, 0x01]))
            XCTAssertTrue(write.1 === command)
            XCTAssertEqual(write.2, .withResponse)
        }
    }

    func testAutomaticFailureRetainsPeripheralUntilMatchingDisconnectAndReconnects() {
        let manager = WhoopBleConnectionManager()
        let peripheral = TestWhoopPeripheralConnection()
        manager.syncOnBleQueue {
            manager.setConnectedPeripheral(peripheral)
            peripheral.delegate = manager.bleDelegate
            manager.autoReconnect = true
            manager.wasStreaming = true
            manager.setState(.discoveringServices)

            manager.abortHandshake(for: peripheral, with: .serviceDiscoveryFailed("temporary"))

            XCTAssertEqual(peripheral.cancellations, 1)
            XCTAssertTrue(manager.connectedPeripheral === peripheral)
            XCTAssertTrue(peripheral.delegate === manager.bleDelegate)
            XCTAssertEqual(manager.state, .disconnecting)
            XCTAssertTrue(manager.autoReconnect)
            XCTAssertEqual(peripheral.connections, 0, "Wait for cancellation's disconnect callback")

            peripheral.state = .disconnected
            manager.handlePeripheralDisconnected(peripheral, error: nil)

            XCTAssertTrue(manager.connectedPeripheral === peripheral)
            XCTAssertTrue(peripheral.delegate === manager.bleDelegate)
            XCTAssertEqual(manager.state, .connecting)
            XCTAssertTrue(manager.autoReconnect)
            XCTAssertTrue(manager.wasStreaming)
            XCTAssertEqual(peripheral.connections, 1)
            XCTAssertNil(manager.handshakeTimeoutWorkItem, "Passive reconnect must remain pending")

            peripheral.state = .connected
            manager.handlePeripheralConnected(peripheral)
            XCTAssertEqual(manager.state, .discoveringServices)
            XCTAssertEqual(peripheral.discoveredServices, WhoopBleConstants.allServiceUUIDs + [CBUUID(string: "180A")])
        }
    }

    func testStaleDisconnectDoesNotReplaceOrReconnectCurrentPeripheral() {
        let manager = WhoopBleConnectionManager()
        let current = TestWhoopPeripheralConnection()
        let stale = TestWhoopPeripheralConnection()
        manager.syncOnBleQueue {
            manager.setConnectedPeripheral(current)
            current.delegate = manager.bleDelegate
            manager.autoReconnect = true
            manager.setState(.subscribing)

            manager.handlePeripheralDisconnected(stale, error: nil)

            XCTAssertTrue(manager.connectedPeripheral === current)
            XCTAssertTrue(current.delegate === manager.bleDelegate)
            XCTAssertEqual(manager.state, .subscribing)
            XCTAssertEqual(stale.connections, 0)
            XCTAssertEqual(current.connections, 0)
        }
    }

    func testStaleHandshakeFailureDoesNotCancelCurrentPeripheral() {
        let manager = WhoopBleConnectionManager()
        let current = TestWhoopPeripheralConnection()
        let stale = TestWhoopPeripheralConnection()
        manager.syncOnBleQueue {
            manager.setConnectedPeripheral(current)
            manager.autoReconnect = true
            manager.setState(.discoveringServices)

            manager.abortHandshake(for: stale, with: .timeout)

            XCTAssertTrue(manager.connectedPeripheral === current)
            XCTAssertEqual(manager.state, .discoveringServices)
            XCTAssertEqual(current.cancellations, 0)
            XCTAssertEqual(stale.cancellations, 0)
        }
    }

    func testIntentionalDisconnectDuringCancellationClearsOwnershipAndIgnoresLateCallback() {
        let manager = WhoopBleConnectionManager()
        let peripheral = TestWhoopPeripheralConnection()
        manager.syncOnBleQueue {
            manager.setConnectedPeripheral(peripheral)
            manager.autoReconnect = true
            manager.wasStreaming = true
            manager.setState(.subscribing)
            manager.abortHandshake(for: peripheral, with: .timeout)
        }
        let disconnected = expectation(description: "intentional disconnect")
        manager.disconnect {
            manager.handlePeripheralDisconnected(peripheral, error: nil)
            XCTAssertNil(manager.connectedPeripheral)
            XCTAssertNil(peripheral.delegate)
            XCTAssertEqual(manager.state, .idle)
            XCTAssertFalse(manager.autoReconnect)
            XCTAssertFalse(manager.wasStreaming)
            XCTAssertEqual(peripheral.connections, 0)
            disconnected.fulfill()
        }
        wait(for: [disconnected], timeout: 1)
    }
}
