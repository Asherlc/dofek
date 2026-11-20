import CoreBluetooth
import XCTest
@testable import WhoopBLE

final class WhoopBleBatteryConnectionTests: XCTestCase {
    func testFreshRestoredAndPoweredOnConnectionsDiscoverBatteryAndDeviceInformationServices() {
        let expected = WhoopBleConstants.allServiceUUIDs + ["180A", "180F"].map(CBUUID.init(string:))
        for path in ["fresh", "restored", "poweredOn"] {
            let manager = WhoopBleConnectionManager()
            let peripheral = TestWhoopPeripheralConnection()
            manager.syncOnBleQueue {
                switch path {
                case "fresh":
                    manager.setConnectedPeripheral(peripheral)
                    manager.setState(.connecting)
                    manager.handlePeripheralConnected(peripheral)
                case "restored":
                    manager.handleRestoredPeripheral(peripheral)
                default:
                    manager.setConnectedPeripheral(peripheral)
                    manager.handleCentralManagerPoweredOn()
                }
                XCTAssertEqual(peripheral.discoveredServices, expected, path)
            }
        }
    }

    func testHarvardSkipsStandardBatteryStubAndCompletesRequiredReadiness() throws {
        let manager = WhoopBleConnectionManager()
        let observer = BatteryObserver()
        manager.delegate = observer
        let session = BatterySession(serviceUUID: WhoopBleConstants.gen4ServiceUUID)
        try manager.syncOnBleQueue {
            session.start(on: manager)
            XCTAssertFalse(session.peripheral.characteristicDiscoveries.contains { $0.1 === session.batteryService })
            XCTAssertNil(manager.batteryService)

            manager.handleCharacteristicsDiscovered(session.peripheral, service: session.batteryService)
            session.discoverRequiredChannels(on: manager)
            try session.finishRequiredHandshake(on: manager)
            session.send(Data([81]), from: session.level, to: manager)

            XCTAssertTrue(session.peripheral.reads.isEmpty)
            XCTAssertFalse(session.peripheral.notificationRequests.contains { $0.1 === session.level })
            XCTAssertNil(manager.batteryLevelCharacteristic)
            XCTAssertEqual(manager.batteryStatus, WhoopBleBatteryStatus())
            XCTAssertTrue(observer.updates.isEmpty)
        }
    }

    func testStandardReadAndNotificationPreserveChargingAndPublishOnlyChangedFacts() throws {
        let manager = WhoopBleConnectionManager()
        let session = BatterySession()
        let observer = BatteryObserver()
        manager.delegate = observer
        try manager.syncOnBleQueue {
            session.start(on: manager)
            XCTAssertEqual(session.peripheral.characteristicDiscoveries.first {
                $0.1 === session.batteryService
            }?.0, [session.level.uuid])
            manager.handleCharacteristicsDiscovered(session.peripheral, service: session.batteryService)
            XCTAssertEqual(session.peripheral.reads.count, 1)
            XCTAssertTrue(session.peripheral.reads.first === session.level)
            XCTAssertTrue(session.peripheral.notificationRequests.contains { $0.0 && $0.1 === session.level })

            for value: [UInt8] in [[], [101], [57, 0]] {
                session.send(Data(value), from: session.level, to: manager)
            }
            XCTAssertTrue(observer.updates.isEmpty)
            session.send(Data([0]), from: session.level, to: manager)
            XCTAssertEqual(manager.state, .discoveringServices)

            session.discoverRequiredChannels(on: manager)
            session.discoverEvent(on: manager)
            let frame = try capturedWhoopBatteryFrame()
            session.send(Data(frame.prefix(20)), from: session.event, to: manager)
            XCTAssertEqual(observer.updates.count, 1)
            session.send(Data(frame.dropFirst(20)), from: session.event, to: manager)
            XCTAssertEqual(manager.state, .subscribing)
            try session.finishRequiredHandshake(on: manager)
            session.send(syntheticChargingEvent(7), from: session.event, to: manager)
            session.send(Data([57]), from: session.level, to: manager)
            session.send(Data([57]), from: session.level, to: manager)
            session.send(syntheticChargingEvent(8), from: session.event, to: manager)

            XCTAssertEqual(observer.updates, [
                WhoopBleBatteryStatus(percentage: 0),
                WhoopBleBatteryStatus(percentage: 49.9, isCharging: false),
                WhoopBleBatteryStatus(percentage: 49.9, isCharging: true),
                WhoopBleBatteryStatus(percentage: 57, isCharging: true),
                WhoopBleBatteryStatus(percentage: 57, isCharging: false),
            ])
            XCTAssertEqual(manager.batteryStatus, observer.updates.last)
            XCTAssertTrue(observer.data.isEmpty, "Battery frames must stay out of the sensor parser")
        }
    }

    func testMissingOrFailedOptionalDiscoveryDoesNotBlockRequiredReadiness() throws {
        let failure = NSError(domain: "test", code: 1)
        for hasBatteryService in [false, true] {
            let manager = WhoopBleConnectionManager()
            let session = BatterySession()
            try manager.syncOnBleQueue {
                session.start(on: manager, withBatteryService: hasBatteryService)
                if hasBatteryService {
                    manager.handleCharacteristicsDiscovered(
                        session.peripheral, service: session.batteryService, error: failure)
                }
                XCTAssertEqual(manager.state, .discoveringServices)
                session.discoverRequiredChannels(on: manager)
                if hasBatteryService {
                    manager.handleCharacteristicsDiscovered(
                        session.peripheral, service: session.whoopService, error: failure)
                } else {
                    manager.handleCharacteristicsDiscovered(session.peripheral, service: session.whoopService)
                }
                try session.finishRequiredHandshake(on: manager)
                XCTAssertEqual(session.peripheral.cancellations, 0)
                XCTAssertEqual(manager.batteryStatus, WhoopBleBatteryStatus())
            }
        }
    }

    func testEventAndBatteryNotificationFailuresDoNotParticipateInRequiredTracker() throws {
        let manager = WhoopBleConnectionManager()
        let session = BatterySession()
        let failure = NSError(domain: "test", code: 1)
        try manager.syncOnBleQueue {
            session.start(on: manager)
            manager.handleCharacteristicsDiscovered(session.peripheral, service: session.batteryService)
            session.discoverRequiredChannels(on: manager)
            XCTAssertTrue(session.peripheral.characteristicDiscoveries.contains {
                $0.0 == [session.event.uuid] && $0.1 === session.whoopService
            })
            session.discoverEvent(on: manager)
            XCTAssertTrue(session.peripheral.notificationRequests.contains { $0.0 && $0.1 === session.event })
            for characteristic in [session.level, session.event] {
                manager.handleNotificationStateUpdated(session.peripheral, characteristic: characteristic, error: failure)
                XCTAssertEqual(manager.state, .subscribing)
            }
            try session.finishRequiredHandshake(on: manager)
            XCTAssertEqual(session.peripheral.cancellations, 0)
        }
    }

    func testReplacingPeripheralRejectsOldValuesServicesAndDisconnectEvenWithSameIdentifier() {
        let manager = WhoopBleConnectionManager()
        let observer = BatteryObserver()
        manager.delegate = observer
        let old = BatterySession()
        let replacement = BatterySession(identifier: old.peripheral.identifier)
        manager.syncOnBleQueue {
            old.start(on: manager)
            manager.handleCharacteristicsDiscovered(old.peripheral, service: old.batteryService)
            old.send(Data([57]), from: old.level, to: manager)
            replacement.start(on: manager)
            XCTAssertEqual(manager.batteryStatus, WhoopBleBatteryStatus())
            XCTAssertEqual(old.peripheral.cancellations, 1)

            manager.handlePeripheralDisconnected(old.peripheral, error: nil)
            manager.handleCharacteristicsDiscovered(old.peripheral, service: old.batteryService)
            old.send(Data([40]), from: old.level, to: manager)
            XCTAssertEqual(old.peripheral.reads.count, 1)
            XCTAssertEqual(manager.state, .discoveringServices)
            XCTAssertEqual(manager.batteryStatus, WhoopBleBatteryStatus())

            manager.handleCharacteristicsDiscovered(replacement.peripheral, service: replacement.batteryService)
            replacement.send(Data([63]), from: replacement.level, to: manager)
            XCTAssertEqual(observer.updates, [
                WhoopBleBatteryStatus(percentage: 57), WhoopBleBatteryStatus(), WhoopBleBatteryStatus(percentage: 63),
            ])
        }
    }

    func testDisconnectClearsFactsAndPartialEventBeforeReconnectOnSameNativePeripheral() throws {
        let manager = WhoopBleConnectionManager()
        let observer = BatteryObserver()
        manager.delegate = observer
        let old = BatterySession()
        let next = BatterySession(peripheral: old.peripheral)
        let frame = try capturedWhoopBatteryFrame()
        manager.syncOnBleQueue {
            old.start(on: manager)
            old.discoverRequiredChannels(on: manager)
            old.discoverEvent(on: manager)
            old.send(syntheticChargingEvent(7), from: old.event, to: manager)
            old.send(Data(frame.prefix(20)), from: old.event, to: manager)
            manager.handlePeripheralDisconnected(old.peripheral, error: nil)
            XCTAssertEqual(manager.batteryStatus, WhoopBleBatteryStatus())
            old.send(frame, from: old.event, to: manager)

            next.start(on: manager)
            manager.handleCharacteristicsDiscovered(old.peripheral, service: old.batteryService)
            XCTAssertTrue(old.peripheral.reads.isEmpty)
            next.discoverRequiredChannels(on: manager)
            next.discoverEvent(on: manager)
            old.send(frame, from: old.event, to: manager)
            next.send(Data(frame.dropFirst(20)), from: next.event, to: manager)
            XCTAssertEqual(manager.batteryStatus, WhoopBleBatteryStatus())
            next.send(frame, from: next.event, to: manager)
            XCTAssertEqual(observer.updates, [
                WhoopBleBatteryStatus(isCharging: true), WhoopBleBatteryStatus(),
                WhoopBleBatteryStatus(percentage: 49.9, isCharging: false),
            ])
            XCTAssertTrue(observer.data.isEmpty)
        }
    }
}

private struct BatterySession {
    let peripheral: TestWhoopPeripheralConnection
    let whoopService: CBMutableService
    let batteryService = CBMutableService(type: CBUUID(string: "180F"), primary: true)
    let level = CBMutableCharacteristic(
        type: CBUUID(string: "2A19"), properties: [.read, .notify], value: nil, permissions: .readable)
    let command: CBMutableCharacteristic
    let response: CBMutableCharacteristic
    let event: CBMutableCharacteristic
    let data: CBMutableCharacteristic

    init(
        peripheral: TestWhoopPeripheralConnection = TestWhoopPeripheralConnection(),
        serviceUUID: CBUUID = WhoopBleConstants.maverickServiceUUID
    ) {
        self.peripheral = peripheral
        whoopService = CBMutableService(type: serviceUUID, primary: true)
        command = Self.characteristic(serviceUUID, suffix: "0002", properties: .write)
        response = Self.characteristic(serviceUUID, suffix: "0003", properties: .notify)
        event = Self.characteristic(serviceUUID, suffix: "0004", properties: .notify)
        data = Self.characteristic(serviceUUID, suffix: "0005", properties: .notify)
    }

    init(identifier: UUID) { self.init(peripheral: TestWhoopPeripheralConnection(identifier: identifier)) }

    private static func characteristic(
        _ serviceUUID: CBUUID, suffix: String, properties: CBCharacteristicProperties
    ) -> CBMutableCharacteristic {
        CBMutableCharacteristic(
            type: WhoopBleConstants.characteristicUUID(forService: serviceUUID, suffix: suffix),
            properties: properties, value: nil, permissions: [.readable, .writeable])
    }

    func start(on manager: WhoopBleConnectionManager, withBatteryService: Bool = true) {
        whoopService.characteristics = [command, response, data]
        batteryService.characteristics = [level]
        peripheral.services = withBatteryService ? [whoopService, batteryService] : [whoopService]
        manager.setConnectedPeripheral(peripheral)
        manager.setState(.connecting)
        manager.handlePeripheralConnected(peripheral)
        manager.handleServicesDiscovered(peripheral)
    }

    func discoverRequiredChannels(on manager: WhoopBleConnectionManager) {
        manager.handleCharacteristicsDiscovered(peripheral, service: whoopService)
    }

    func discoverEvent(on manager: WhoopBleConnectionManager) {
        whoopService.characteristics = [command, response, data, event]
        manager.handleCharacteristicsDiscovered(peripheral, service: whoopService)
    }

    func finishRequiredHandshake(on manager: WhoopBleConnectionManager) throws {
        var tracker = try XCTUnwrap(manager.notificationSubscriptionTracker)
        let source = peripheral.notificationSource
        XCTAssertEqual(tracker.recordNotificationState(
            peripheral: source, characteristic: data, isNotifying: true, hasError: false), .waiting)
        let update = tracker.recordNotificationState(
            peripheral: source, characteristic: response, isNotifying: true, hasError: false)
        XCTAssertEqual(update, .ready)
        _ = manager.settleNotificationSubscriptionUpdate(
            update, failureDetail: "unused", cancelPeripheral: { XCTFail("Required subscriptions succeeded") })
        XCTAssertEqual(manager.state, .ready)
    }

    func send(_ bytes: Data, from characteristic: CBCharacteristic, to manager: WhoopBleConnectionManager) {
        manager.handleNotification(from: peripheral.notificationSource, characteristic: characteristic, data: bytes)
    }
}

private final class BatteryObserver: WhoopBleConnectionManagerDelegate {
    var updates: [WhoopBleBatteryStatus] = []
    var data: [Data] = []

    func connectionManager(_: WhoopBleConnectionManager, didUpdateBatteryStatus status: WhoopBleBatteryStatus) {
        updates.append(status)
    }

    func connectionManagerDidBecomeReady(
        _ manager: WhoopBleConnectionManager, peripheral: any WhoopBlePeripheralConnection,
        cmdCharacteristic: CBCharacteristic, wasStreaming: Bool
    ) {}

    func connectionManagerDidDisconnect(
        _ manager: WhoopBleConnectionManager, peripheralId: String, error: Error?
    ) {}

    func connectionManager(_ manager: WhoopBleConnectionManager, didReceiveData data: Data) { self.data.append(data) }
    func connectionManager(_ manager: WhoopBleConnectionManager, didReceiveCommandResponse data: Data) {}
}
