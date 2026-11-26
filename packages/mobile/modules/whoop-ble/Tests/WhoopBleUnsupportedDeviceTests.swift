import XCTest
import CoreBluetooth
@testable import WhoopBLE

final class WhoopBleUnsupportedDeviceTests: XCTestCase {
    func testServiceNotFoundMarksUnsupportedDeviceAndPublishesEvenForPassiveFailures() {
        let manager = WhoopBleConnectionManager()
        let observer = UnsupportedDeviceObserver()
        manager.delegate = observer
        let rejectedId = UUID()
        let rejected = TestWhoopPeripheralConnection(identifier: rejectedId, name: nil)

        manager.syncOnBleQueue {
            manager.autoReconnect = true
            manager.setConnectedPeripheral(rejected)
            manager.setState(.discoveringServices)
            manager.abortHandshake(with: .serviceNotFound) {}
            XCTAssertTrue(manager.unsupportedDevice)
            XCTAssertEqual(manager.rejectedUnsupportedPeripheral?.id, rejectedId)
            XCTAssertNil(manager.rejectedUnsupportedPeripheral?.name)
            XCTAssertEqual(manager.state, .idle)
            XCTAssertNil(manager.connectedPeripheral)
            XCTAssertFalse(manager.autoReconnect)
            XCTAssertEqual(observer.updates, [true])
            XCTAssertEqual(observer.statesAtUpdate, [.idle])
        }
    }

    func testCharacteristicsNotFoundDoesNotMarkUnsupportedDevice() {
        let manager = WhoopBleConnectionManager()
        let observer = UnsupportedDeviceObserver()
        manager.delegate = observer
        let peripheral = TestWhoopPeripheralConnection()

        manager.syncOnBleQueue {
            manager.autoReconnect = true
            manager.setConnectedPeripheral(peripheral)
            manager.setState(.discoveringServices)
            manager.abortHandshake(with: .characteristicsNotFound) {}
            XCTAssertFalse(manager.unsupportedDevice)
            XCTAssertNil(manager.rejectedUnsupportedPeripheral)
            XCTAssertEqual(manager.state, .idle)
            XCTAssertTrue(observer.updates.isEmpty)
        }
    }

    func testNewConnectionAttemptClearsUnsupportedDevice() {
        let manager = WhoopBleConnectionManager()
        let observer = UnsupportedDeviceObserver()
        manager.delegate = observer
        let rejected = TestWhoopPeripheralConnection(name: nil)
        let nextAttempt = TestWhoopPeripheralConnection()

        manager.syncOnBleQueue {
            manager.autoReconnect = true
            manager.setConnectedPeripheral(rejected)
            manager.setState(.discoveringServices)
            manager.abortHandshake(with: .serviceNotFound) {}
            XCTAssertTrue(manager.unsupportedDevice)

            manager.setConnectedPeripheral(nextAttempt)
            XCTAssertFalse(manager.unsupportedDevice)
            XCTAssertNil(manager.rejectedUnsupportedPeripheral)
            XCTAssertEqual(observer.updates, [true, false])
        }
    }

    func testIntentionalDisconnectClearsUnsupportedDevice() {
        let manager = WhoopBleConnectionManager()
        let observer = UnsupportedDeviceObserver()
        manager.delegate = observer
        let rejected = TestWhoopPeripheralConnection(name: nil)
        let cleared = expectation(description: "intentional disconnect clears unsupported device")

        manager.syncOnBleQueue {
            manager.setConnectedPeripheral(rejected)
            manager.setState(.discoveringServices)
            manager.abortHandshake(with: .serviceNotFound) {}
            XCTAssertTrue(manager.unsupportedDevice)
        }
        manager.disconnect {
            XCTAssertFalse(manager.unsupportedDevice)
            XCTAssertNil(manager.rejectedUnsupportedPeripheral)
            XCTAssertEqual(observer.updates, [true, false])
            cleared.fulfill()
        }
        wait(for: [cleared], timeout: 1)
    }
}

private final class UnsupportedDeviceObserver: WhoopBleConnectionManagerDelegate {
    var updates: [Bool] = []
    var statesAtUpdate: [ConnectionState] = []

    func connectionManager(_ manager: WhoopBleConnectionManager, didUpdateUnsupportedDevice value: Bool) {
        updates.append(value)
        statesAtUpdate.append(manager.state)
    }

    func connectionManagerDidBecomeReady(
        _: WhoopBleConnectionManager,
        peripheral _: any WhoopBlePeripheralConnection,
        cmdCharacteristic _: CBCharacteristic,
        wasStreaming _: Bool
    ) {}

    func connectionManagerDidDisconnect(
        _: WhoopBleConnectionManager,
        peripheralId _: String,
        error _: Error?
    ) {}

    func connectionManager(_: WhoopBleConnectionManager, didReceiveData _: Data) {}
    func connectionManager(_: WhoopBleConnectionManager, didReceiveCommandResponse _: Data) {}
}
