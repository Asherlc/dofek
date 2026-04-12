// swiftlint:disable file_length
import CoreBluetooth
import ExpoModulesCore

/// Device-agnostic BLE probe module for reverse engineering wearables.
///
/// Exposes generic BLE operations (scan, connect, discover, subscribe, write)
/// to JavaScript. Protocol-specific logic lives in JS and hot-reloads instantly,
/// so only the first deploy requires a native rebuild.
public class BleProbeModule: Module {
    private var centralManager: CBCentralManager?
    private let bleQueue = DispatchQueue(label: "com.dofek.ble-probe", qos: .userInitiated)
    private let delegate = BleDelegate()

    private var connectedPeripheral: CBPeripheral?
    private var discoveredCharacteristics: [String: CBCharacteristic] = [:]

    // Pending promises
    private var scanPromise: Promise?
    private var connectPromise: Promise?
    private var pendingPoweredOnCallback: (() -> Void)?

    // Scan results
    private var scanResults: [[String: Any]] = []

    // Notification log (ring buffer of recent notifications)
    private var notificationLog: [[String: Any]] = []
    private static let maxNotificationLog = 200
    private var notificationCount: UInt64 = 0

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    public func definition() -> ModuleDefinition {
        Name("BleProbe")

        Events("onNotification", "onConnectionStateChanged", "onBluetoothStateChanged")

        OnCreate {
            self.delegate.module = self
        }

        // MARK: - Bluetooth state

        Function("getBluetoothState") { () -> String in
            guard let manager = self.centralManager else { return "uninitialized" }
            return self.describeState(manager.state)
        }

        Function("initialize") { () in
            _ = self.ensureCentralManager()
        }

        // MARK: - Scanning

        AsyncFunction("scan") { (serviceUUIDs: [String]?, durationSeconds: Double, promise: Promise) in
            let manager = self.ensureCentralManager()

            self.whenPoweredOn(manager: manager) {
                self.scanResults = []
                self.scanPromise = promise

                let uuids = serviceUUIDs?.map { CBUUID(string: $0) }
                let serviceList = uuids?.map(\.uuidString).joined(separator: ",") ?? "all"
                NSLog("[BleProbe] scanning (services=%@, duration=%.1fs)", serviceList, durationSeconds)
                manager.scanForPeripherals(withServices: uuids, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])

                self.bleQueue.asyncAfter(deadline: .now() + durationSeconds) {
                    manager.stopScan()
                    let results = self.scanResults
                    self.scanPromise = nil
                    promise.resolve(results)
                }
            }
        }

        /// Find peripherals already connected (by other apps) for given service UUIDs.
        Function("getConnectedPeripherals") { (serviceUUIDs: [String]) -> [[String: Any]] in
            let manager = self.ensureCentralManager()
            let uuids = serviceUUIDs.map { CBUUID(string: $0) }
            var results: [[String: Any]] = []
            for uuid in uuids {
                let peripherals = manager.retrieveConnectedPeripherals(withServices: [uuid])
                for peripheral in peripherals {
                    results.append([
                        "id": peripheral.identifier.uuidString,
                        "name": peripheral.name as Any,
                        "serviceUUID": uuid.uuidString,
                    ])
                }
            }
            return results
        }

        // MARK: - Connection

        AsyncFunction("connect") { (peripheralId: String, timeoutSeconds: Double, promise: Promise) in
            let manager = self.ensureCentralManager()

            self.bleQueue.async {
                guard let uuid = UUID(uuidString: peripheralId) else {
                    promise.reject("INVALID_ID", "Invalid peripheral ID")
                    return
                }

                // Try retrievePeripherals first, then retrieveConnectedPeripherals
                var peripheral = manager.retrievePeripherals(withIdentifiers: [uuid]).first
                if peripheral == nil {
                    for serviceUUID in [CBUUID]() {
                        let connected = manager.retrieveConnectedPeripherals(withServices: [serviceUUID])
                        if let found = connected.first(where: { $0.identifier == uuid }) {
                            peripheral = found
                            break
                        }
                    }
                }

                guard let target = peripheral else {
                    promise.reject("NOT_FOUND", "Peripheral not found: \(peripheralId)")
                    return
                }

                self.connectedPeripheral = target
                target.delegate = self.delegate
                self.connectPromise = promise
                self.discoveredCharacteristics = [:]

                manager.connect(target, options: nil)

                // Timeout
                self.bleQueue.asyncAfter(deadline: .now() + timeoutSeconds) {
                    if self.connectPromise != nil {
                        manager.cancelPeripheralConnection(target)
                        self.connectPromise?.reject("TIMEOUT", "Connection timed out")
                        self.connectPromise = nil
                    }
                }
            }
        }

        Function("disconnect") { () in
            if let peripheral = self.connectedPeripheral {
                self.centralManager?.cancelPeripheralConnection(peripheral)
            }
            self.connectedPeripheral = nil
            self.discoveredCharacteristics = [:]
        }

        Function("isConnected") { () -> Bool in
            return self.connectedPeripheral?.state == .connected
        }

        // MARK: - Service/Characteristic discovery

        AsyncFunction("discoverServices") { (promise: Promise) in
            guard let peripheral = self.connectedPeripheral else {
                promise.reject("NOT_CONNECTED", "No peripheral connected")
                return
            }
            // Store promise to resolve when didDiscoverServices fires
            self.delegate.discoverServicesPromise = promise
            peripheral.discoverServices(nil)
        }

        AsyncFunction("discoverCharacteristics") { (serviceUUID: String, promise: Promise) in
            guard let peripheral = self.connectedPeripheral else {
                promise.reject("NOT_CONNECTED", "No peripheral connected")
                return
            }
            let targetUUID = CBUUID(string: serviceUUID)
            guard let service = peripheral.services?.first(where: { $0.uuid == targetUUID }) else {
                promise.reject("NO_SERVICE", "Service \(serviceUUID) not found")
                return
            }
            self.delegate.discoverCharacteristicsPromise = promise
            self.delegate.discoverCharacteristicsServiceUUID = serviceUUID
            peripheral.discoverCharacteristics(nil, for: service)
        }

        /// Get all discovered characteristics as [{uuid, suffix, properties, isNotifying}]
        Function("getCharacteristics") { () -> [[String: Any]] in
            return self.discoveredCharacteristics.map { suffix, char in
                [
                    "uuid": char.uuid.uuidString,
                    "suffix": suffix,
                    "properties": self.describeProperties(char.properties),
                    "isNotifying": char.isNotifying,
                ]
            }
        }

        // MARK: - Notifications

        AsyncFunction("subscribe") { (characteristicSuffix: String, promise: Promise) in
            guard let peripheral = self.connectedPeripheral else {
                promise.reject("NOT_CONNECTED", "No peripheral connected")
                return
            }
            guard let char = self.discoveredCharacteristics[characteristicSuffix] else {
                promise.reject("NOT_FOUND", "Characteristic with suffix \(characteristicSuffix) not found")
                return
            }
            self.delegate.subscribePromises[characteristicSuffix] = promise
            peripheral.setNotifyValue(true, for: char)
        }

        AsyncFunction("unsubscribe") { (characteristicSuffix: String, promise: Promise) in
            guard let peripheral = self.connectedPeripheral,
                  let char = self.discoveredCharacteristics[characteristicSuffix] else {
                promise.resolve(true)
                return
            }
            peripheral.setNotifyValue(false, for: char)
            promise.resolve(true)
        }

        // MARK: - Read/Write

        AsyncFunction("writeRaw") { (characteristicSuffix: String, hexString: String, withResponse: Bool, promise: Promise) in
            guard let peripheral = self.connectedPeripheral else {
                promise.reject("NOT_CONNECTED", "No peripheral connected")
                return
            }
            guard let char = self.discoveredCharacteristics[characteristicSuffix] else {
                promise.reject("NOT_FOUND", "Characteristic with suffix \(characteristicSuffix) not found")
                return
            }
            guard let data = Self.hexToData(hexString) else {
                promise.reject("INVALID_HEX", "Invalid hex string: \(hexString)")
                return
            }

            let writeType: CBCharacteristicWriteType = withResponse ? .withResponse : .withoutResponse
            if withResponse {
                self.delegate.writePromise = promise
            }

            NSLog("[BleProbe] writing %d bytes to ...%@: %@", data.count, characteristicSuffix, Self.dataToHex(data))
            peripheral.writeValue(data, for: char, type: writeType)

            if !withResponse {
                promise.resolve(true)
            }
        }

        AsyncFunction("readCharacteristic") { (characteristicSuffix: String, promise: Promise) in
            guard let peripheral = self.connectedPeripheral else {
                promise.reject("NOT_CONNECTED", "No peripheral connected")
                return
            }
            guard let char = self.discoveredCharacteristics[characteristicSuffix] else {
                promise.reject("NOT_FOUND", "Characteristic with suffix \(characteristicSuffix) not found")
                return
            }
            self.delegate.readPromise = promise
            peripheral.readValue(for: char)
        }

        // MARK: - Notification log

        Function("getNotificationLog") { () -> [[String: Any]] in
            return self.notificationLog
        }

        Function("clearNotificationLog") { () in
            self.notificationLog = []
            self.notificationCount = 0
        }

        Function("getNotificationCount") { () -> Int in
            return Int(self.notificationCount)
        }
    }

    // MARK: - Internal handlers

    func handleBluetoothStateChanged(_ state: CBManagerState) {
        sendEvent("onBluetoothStateChanged", ["state": describeState(state)])
    }

    func handlePeripheralDiscovered(_ peripheral: CBPeripheral, rssi: NSNumber) {
        let entry: [String: Any] = [
            "id": peripheral.identifier.uuidString,
            "name": peripheral.name as Any,
            "rssi": rssi.intValue,
        ]
        scanResults.append(entry)
    }

    func handleConnected(_ peripheral: CBPeripheral) {
        connectPromise?.resolve(["id": peripheral.identifier.uuidString, "name": peripheral.name as Any])
        connectPromise = nil
        sendEvent("onConnectionStateChanged", ["state": "connected", "peripheralId": peripheral.identifier.uuidString])
    }

    func handleDisconnected(_ peripheral: CBPeripheral, error: Error?) {
        connectPromise?.reject("DISCONNECTED", error?.localizedDescription ?? "Disconnected")
        connectPromise = nil
        sendEvent("onConnectionStateChanged", [
            "state": "disconnected",
            "peripheralId": peripheral.identifier.uuidString,
            "error": error?.localizedDescription as Any,
        ])
    }

    func handleNotification(_ characteristic: CBCharacteristic, data: Data) {
        notificationCount += 1
        let suffix = extractSuffix(characteristic.uuid)
        let hex = Self.dataToHex(data)

        let entry: [String: Any] = [
            "index": Int(notificationCount),
            "suffix": suffix,
            "bytes": data.count,
            "hex": hex,
            "timestamp": ISO8601DateFormatter().string(from: Date()),
        ]

        // Ring buffer
        notificationLog.append(entry)
        if notificationLog.count > Self.maxNotificationLog {
            notificationLog.removeFirst()
        }

        // Emit JS event for real-time display
        sendEvent("onNotification", entry)
    }

    func storeCharacteristic(_ characteristic: CBCharacteristic) {
        let suffix = extractSuffix(characteristic.uuid)
        discoveredCharacteristics[suffix] = characteristic
    }

    // MARK: - Helpers

    private func ensureCentralManager() -> CBCentralManager {
        if let existing = centralManager { return existing }
        let manager = CBCentralManager(delegate: delegate, queue: bleQueue, options: [
            CBCentralManagerOptionShowPowerAlertKey: false,
        ])
        centralManager = manager
        return manager
    }

    private func whenPoweredOn(manager: CBCentralManager, action: @escaping () -> Void) {
        if manager.state == .poweredOn {
            bleQueue.async { action() }
        } else {
            pendingPoweredOnCallback = action
            bleQueue.asyncAfter(deadline: .now() + 3) {
                if let callback = self.pendingPoweredOnCallback {
                    self.pendingPoweredOnCallback = nil
                    if manager.state == .poweredOn {
                        callback()
                    }
                }
            }
        }
    }

    func handlePoweredOn() {
        if let callback = pendingPoweredOnCallback {
            pendingPoweredOnCallback = nil
            callback()
        }
    }

    private func describeState(_ state: CBManagerState) -> String {
        switch state {
        case .unknown: return "unknown"
        case .resetting: return "resetting"
        case .unsupported: return "unsupported"
        case .unauthorized: return "unauthorized"
        case .poweredOff: return "poweredOff"
        case .poweredOn: return "poweredOn"
        @unknown default: return "unknown"
        }
    }

    func describeProperties(_ props: CBCharacteristicProperties) -> String {
        var parts: [String] = []
        if props.contains(.read) { parts.append("read") }
        if props.contains(.write) { parts.append("write") }
        if props.contains(.writeWithoutResponse) { parts.append("writeNoResponse") }
        if props.contains(.notify) { parts.append("notify") }
        if props.contains(.indicate) { parts.append("indicate") }
        return parts.joined(separator: ",")
    }

    func extractSuffix(_ uuid: CBUUID) -> String {
        let uuidStr = uuid.uuidString
        guard let dashIndex = uuidStr.firstIndex(of: "-") else { return uuidStr }
        let start = uuidStr.index(dashIndex, offsetBy: -4)
        return String(uuidStr[start..<dashIndex])
    }

    static func hexToData(_ hex: String) -> Data? {
        let cleaned = hex.replacingOccurrences(of: " ", with: "")
        guard cleaned.count % 2 == 0 else { return nil }
        var data = Data()
        var index = cleaned.startIndex
        while index < cleaned.endIndex {
            let nextIndex = cleaned.index(index, offsetBy: 2)
            guard let byte = UInt8(cleaned[index..<nextIndex], radix: 16) else { return nil }
            data.append(byte)
            index = nextIndex
        }
        return data
    }

    static func dataToHex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined(separator: " ")
    }
}

// MARK: - BLE Delegate

private class BleDelegate: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    weak var module: BleProbeModule?

    var discoverServicesPromise: Promise?
    var discoverCharacteristicsPromise: Promise?
    var discoverCharacteristicsServiceUUID: String?
    var subscribePromises: [String: Promise] = [:]
    var writePromise: Promise?
    var readPromise: Promise?

    // MARK: CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        module?.handleBluetoothStateChanged(central.state)
        if central.state == .poweredOn {
            module?.handlePoweredOn()
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        module?.handlePeripheralDiscovered(peripheral, rssi: RSSI)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        module?.handleConnected(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        module?.handleDisconnected(peripheral, error: error)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        module?.handleDisconnected(peripheral, error: error)
    }

    // MARK: CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let promise = discoverServicesPromise else { return }
        discoverServicesPromise = nil

        if let error = error {
            promise.reject("DISCOVERY_ERROR", error.localizedDescription)
            return
        }

        let services = peripheral.services?.map { service -> [String: Any] in
            ["uuid": service.uuid.uuidString, "isPrimary": service.isPrimary]
        } ?? []
        promise.resolve(services)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let promise = discoverCharacteristicsPromise else { return }
        discoverCharacteristicsPromise = nil

        if let error = error {
            promise.reject("DISCOVERY_ERROR", error.localizedDescription)
            return
        }

        let chars = service.characteristics?.map { char -> [String: Any] in
            let suffix = module?.extractSuffix(char.uuid) ?? char.uuid.uuidString
            module?.storeCharacteristic(char)
            return [
                "uuid": char.uuid.uuidString,
                "suffix": suffix,
                "properties": module?.describeProperties(char.properties) ?? "",
                "isNotifying": char.isNotifying,
            ]
        } ?? []
        promise.resolve(chars)
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let promise = writePromise else { return }
        writePromise = nil

        if let error = error {
            promise.reject("WRITE_ERROR", error.localizedDescription)
        } else {
            promise.resolve(true)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        let suffix = module?.extractSuffix(characteristic.uuid) ?? ""
        guard let promise = subscribePromises.removeValue(forKey: suffix) else { return }

        if let error = error {
            promise.reject("SUBSCRIBE_ERROR", error.localizedDescription)
        } else {
            promise.resolve(characteristic.isNotifying)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        // Handle read response
        if let promise = readPromise {
            readPromise = nil
            if let error = error {
                promise.reject("READ_ERROR", error.localizedDescription)
            } else {
                let data = characteristic.value ?? Data()
                promise.resolve(BleProbeModule.dataToHex(data))
            }
            return
        }

        // Handle notification
        guard let data = characteristic.value else { return }
        module?.handleNotification(characteristic, data: data)
    }
}
