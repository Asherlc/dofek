import CoreBluetooth
import XCTest
@testable import ExpoWhoopBle

final class WhoopBleManagedHistoryTests: XCTestCase {
    func testSharedCaptureStoresHistoryWithoutRequestingOrAcknowledgingIt() throws {
        try exerciseHistory(managed: false, storageAvailable: true)
    }

    func testManagedCaptureAcknowledgesAfterCommittingRecords() throws {
        try exerciseHistory(managed: true, storageAvailable: true)
    }

    func testFailedNotificationCommitDoesNotAcknowledgeHistory() throws {
        try exerciseHistory(managed: true, storageAvailable: false)
    }

    func testFragmentedHistoryOnRestoredLinkVetoesManagedOffload() throws {
        try exerciseHistory(managed: true, storageAvailable: true, otherSyncDuringRestoration: true)
    }

    private func exerciseHistory(
        managed: Bool, storageAvailable: Bool, otherSyncDuringRestoration: Bool = false
    ) throws {
        let (context, module) = try makeModule()
        defer { withExtendedLifetime(context) {} }
        let uploader = try module.uploader
        try uploader.configure(userId: UUID().uuidString, serverURL: "https://example.com", token: "test", headers: [:])
        defer { XCTAssertNoThrow(try uploader.disable()) }
        let peripheral = HistoryTestPeripheral()
        let command = CBMutableCharacteristic(type: CBUUID(string: "FD4B"), properties: .write,
                                              value: nil, permissions: .writeable)
        if managed { try uploader.setManagedHistoryEnabled(true, for: peripheral.identifier) }
        peripheral.onWrite = { data in
            if data[10] == 0x17 { XCTAssertEqual(try? uploader.sampleCount(stream: .sensorRecords), 1) }
        }

        let manager = module.connectionManager
        let start = Self.frame(Data([0x31, 0, 1]) + Data(count: 37))
        let splitIndex = 17
        let expectedToRequest = managed && !otherSyncDuringRestoration
        try manager.syncOnBleQueue {
            defer { module.watchdog.stop() }
            module.captureSuspended = false
            if otherSyncDuringRestoration {
                manager.handleRestoration([peripheral])
                module.connectionManager(manager, didReceiveData: start.prefix(splitIndex))
            } else {
                manager.setConnectedPeripheral(peripheral)
            }
            manager.setDiscoveredCharacteristics(cmdCharacteristic: command, cmdResponseCharacteristic: nil,
                                                 dataCharacteristic: nil)
            manager.setState(.subscribing)
            manager.setState(.ready)
            module.publishReadyConnection(peripheralId: peripheral.identifier.uuidString, peripheralName: nil,
                                          wasStreaming: true, supportsManagedHistory: true)

            if expectedToRequest {
                let range = try XCTUnwrap(peripheral.writes.first { $0[10] == 0x22 })
                let reply = Data([0x24, 0, 0x22, range[9], 1, 1]) + Data(count: 66)
                module.connectionManager(manager, didReceiveCommandResponse: Self.frame(reply))
                let request = try XCTUnwrap(peripheral.writes.first { $0[10] == 0x16 })
                module.connectionManager(manager, didReceiveCommandResponse: Self.frame(Data([0x24, 0, 0x16, request[9], 1, 0, 0, 0])))
            }

            if !storageAvailable { try uploader.disable() }
            var record = Data([0x2F, 18, 0x80]) + Data(count: 109)
            var seconds = UInt32(Date().timeIntervalSince1970).littleEndian
            withUnsafeBytes(of: &seconds) { record.replaceSubrange(7..<11, with: $0) }
            var end = Data([0x31, 0, 2]) + Data(count: 21)
            end[9] = 1 // One complete historical record in this notification.
            end[13] = 4 // A normal, nonempty trim cursor.
            let nextData = otherSyncDuringRestoration ? start.dropFirst(splitIndex) : start
            module.connectionManager(manager, didReceiveData: nextData + Self.frame(record) + Self.frame(end))

            let historyCommands = peripheral.writes.map { $0[10] }.filter { [0x16, 0x17, 0x22].contains($0) }
            XCTAssertEqual(historyCommands, expectedToRequest ? (storageAvailable ? [0x22, 0x16, 0x17] : [0x22, 0x16]) : [])
            XCTAssertEqual(try uploader.sampleCount(stream: .sensorRecords), storageAvailable ? 1 : 0)
        }
    }

    private static func frame(_ payload: Data) -> Data {
        var length = UInt16(payload.count + 4).littleEndian
        var header = Data([0xAA, 1]) + withUnsafeBytes(of: &length) { Data($0) } + Data([1, 0])
        var headerCrc = WhoopBleFrameParser.crc16modbus(header).littleEndian
        header.append(withUnsafeBytes(of: &headerCrc) { Data($0) })
        var payloadCrc = WhoopBleFrameParser.crc32ieee(payload).littleEndian
        return header + payload + withUnsafeBytes(of: &payloadCrc) { Data($0) }
    }
}

private final class HistoryTestPeripheral: WhoopBlePeripheralConnection {
    let identifier = UUID()
    var name: String? { nil }
    var state: CBPeripheralState { .connected }
    var delegate: CBPeripheralDelegate?
    var services: [CBService]? { nil }
    var notificationSource: AnyObject { self }
    var writes: [Data] = []
    var onWrite: ((Data) -> Void)?

    func connect() {}
    func cancelConnection() {}
    func discoverServices(_ serviceUUIDs: [CBUUID]?) {}
    func discoverCharacteristics(_ characteristicUUIDs: [CBUUID]?, for service: CBService) {}
    func setNotifyValue(_ enabled: Bool, for characteristic: CBCharacteristic) {}
    func readValue(for characteristic: CBCharacteristic) {}
    func writeValue(_ data: Data, for characteristic: CBCharacteristic, type: CBCharacteristicWriteType) {
        XCTAssertEqual(type, .withResponse)
        writes.append(data)
        onWrite?(data)
    }
}
