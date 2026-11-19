import CoreBluetooth
import Foundation

struct DiscoveredOuraRing {
    let peripheralID: UUID
    let name: String?
}

@MainActor
final class OuraBluetoothTransport: NSObject, @preconcurrency CBCentralManagerDelegate,
    @preconcurrency CBPeripheralDelegate {
    // The ring service and characteristics documented by open_oura.
    private static let service = CBUUID(string: "98ED0001-A541-11E4-B6A0-0002A5D5C51B")
    private static let chargingCaseService = CBUUID(string: "8BC5888F-C577-4F5D-857F-377354093F13")
    private static let writeID = CBUUID(string: "98ED0002-A541-11E4-B6A0-0002A5D5C51B")
    private static let notificationIDs = (3...6).map {
        CBUUID(string: "98ED000\($0)-A541-11E4-B6A0-0002A5D5C51B")
    }

    var onFrame: ((Data) -> Void)?
    var onDisconnection: (() -> Void)?

    private lazy var central = CBCentralManager(delegate: self, queue: nil)
    private var scannedRings: [UUID: DiscoveredOuraRing] = [:]
    private var discovery: CheckedContinuation<[DiscoveredOuraRing], Error>?
    private var connection: CheckedContinuation<Void, Error>?
    private var selectedID: UUID?
    private var peripheral: CBPeripheral?
    private var writer: CBCharacteristic?
    private var subscriptions = Set<CBUUID>()
    private var timeout: Task<Void, Never>?

    func discover() async throws -> [DiscoveredOuraRing] {
        try checkPermissionConfiguration()
        return try await withCheckedThrowingContinuation {
            discovery = $0
            setTimeout(seconds: 30) { [weak self] in
                self?.finishDiscovery(.failure(OuraAdapterError("Bluetooth did not become ready.")))
            }
            useBluetooth()
        }
    }

    func connect(peripheralID: UUID) async throws {
        try checkPermissionConfiguration()
        try await withCheckedThrowingContinuation {
            connection = $0
            selectedID = peripheralID
            setTimeout(seconds: 40) { [weak self] in
                self?.failLink(OuraAdapterError("The selected ring did not connect. Keep it nearby and try again."))
            }
            useBluetooth()
        }
    }

    func write(_ data: Data) throws {
        guard connection == nil, let peripheral, let writer, peripheral.state == .connected else {
            throw OuraAdapterError("The ring disconnected before the command could be sent.")
        }
        peripheral.writeValue(data, for: writer, type: .withResponse)
    }

    func disconnect() {
        failLink(OuraAdapterError("The ring disconnected. Reconnect to continue."))
    }

    private func checkPermissionConfiguration() throws {
        guard let description = Bundle.main.object(forInfoDictionaryKey: "NSBluetoothAlwaysUsageDescription") as? String,
              !description.isEmpty else {
            throw OuraAdapterError("Add NSBluetoothAlwaysUsageDescription to the iOS app's Info.plist.")
        }
    }

    private func setTimeout(seconds: Int, action: @escaping @MainActor () -> Void) {
        timeout?.cancel()
        timeout = Task {
            try? await Task.sleep(for: .seconds(seconds))
            if !Task.isCancelled {
                action()
            }
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        useBluetooth()
    }

    private func useBluetooth() {
        switch central.state {
        case .unknown, .resetting:
            break
        case .poweredOn:
            if discovery != nil && !central.isScanning {
                central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
                setTimeout(seconds: 25) { [weak self] in
                    guard let self else { return }
                    self.finishDiscovery(.success(self.scannedRings.values.sorted {
                        $0.peripheralID.uuidString < $1.peripheralID.uuidString
                    }))
                }
            } else if let selectedID, connection != nil, peripheral == nil, !central.isScanning {
                if let selected = central.retrievePeripherals(withIdentifiers: [selectedID]).first {
                    attach(selected)
                } else {
                    central.scanForPeripherals(withServices: nil)
                }
            }
        case .poweredOff:
            bluetoothUnavailable("Turn on Bluetooth to use your Oura Ring.")
        case .unauthorized:
            bluetoothUnavailable("Allow Bluetooth access for this app in iOS Settings.")
        case .unsupported:
            bluetoothUnavailable("Bluetooth Low Energy is unavailable on this device.")
        @unknown default:
            bluetoothUnavailable("Bluetooth is unavailable on this device.")
        }
    }

    private func bluetoothUnavailable(_ message: String) {
        let error = OuraAdapterError(message)
        if discovery != nil {
            finishDiscovery(.failure(error))
        } else {
            failLink(error)
        }
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover candidate: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        if connection != nil, peripheral == nil, candidate.identifier == selectedID {
            attach(candidate)
        } else if discovery != nil {
            let id = candidate.identifier
            let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? candidate.name
            let services = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
            let lowerName = name?.lowercased() ?? ""
            if lowerName.contains("charging case") || services.contains(Self.chargingCaseService) {
                scannedRings.removeValue(forKey: id)
            } else if services.contains(Self.service) || lowerName.contains("oura") {
                scannedRings[id] = DiscoveredOuraRing(peripheralID: id, name: name ?? scannedRings[id]?.name)
            }
        }
    }

    private func attach(_ device: CBPeripheral) {
        central.stopScan()
        peripheral = device
        device.delegate = self
        if device.state == .connected {
            device.discoverServices([Self.service])
        } else {
            central.connect(device)
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect device: CBPeripheral) {
        guard device === peripheral else { return }
        device.discoverServices([Self.service])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect device: CBPeripheral, error: Error?) {
        guard device === peripheral else { return }
        failLink(error ?? OuraAdapterError("The phone could not connect to the selected ring."))
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral device: CBPeripheral, error: Error?) {
        guard device === peripheral else { return }
        failLink(error ?? OuraAdapterError("The ring disconnected. Reconnect to continue."))
    }

    func peripheral(_ device: CBPeripheral, didDiscoverServices error: Error?) {
        guard device === peripheral, connection != nil else { return }
        guard error == nil, let service = device.services?.first(where: { $0.uuid == Self.service }) else {
            return failLink(error ?? OuraAdapterError("The selected device does not expose the Oura Ring service."))
        }
        device.discoverCharacteristics([Self.writeID] + Self.notificationIDs, for: service)
    }

    func peripheral(_ device: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard device === peripheral, connection != nil else { return }
        let characteristics = service.characteristics ?? []
        guard error == nil, let write = characteristics.first(where: {
            $0.uuid == Self.writeID && $0.properties.contains(.write)
        }) else {
            return failLink(error ?? OuraAdapterError("The ring is missing its Bluetooth command characteristic."))
        }
        let notify = characteristics.filter {
            Self.notificationIDs.contains($0.uuid) && !$0.properties.intersection([.notify, .indicate]).isEmpty
        }
        guard !notify.isEmpty else {
            return failLink(OuraAdapterError("The ring is missing its Bluetooth notification characteristics."))
        }
        writer = write
        subscriptions = Set(notify.map(\.uuid))
        for characteristic in notify {
            device.setNotifyValue(true, for: characteristic)
        }
    }

    func peripheral(_ device: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard device === peripheral, Self.notificationIDs.contains(characteristic.uuid) else { return }
        guard error == nil, characteristic.isNotifying else {
            return failLink(error ?? OuraAdapterError("The ring stopped sending Bluetooth notifications."))
        }
        subscriptions.remove(characteristic.uuid)
        if subscriptions.isEmpty, let pending = connection {
            timeout?.cancel()
            connection = nil
            pending.resume()
        }
    }

    func peripheral(_ device: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard device === peripheral, Self.notificationIDs.contains(characteristic.uuid) else { return }
        if let error {
            failLink(error)
        } else if let data = characteristic.value {
            onFrame?(data)
        }
    }

    func peripheral(_ device: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard device === peripheral, let error else { return }
        failLink(error)
    }

    private func finishDiscovery(_ result: Result<[DiscoveredOuraRing], Error>) {
        let pending = discovery
        discovery = nil
        timeout?.cancel()
        if central.isScanning {
            central.stopScan()
        }
        pending?.resume(with: result)
    }

    private func failLink(_ error: Error) {
        let pending = connection
        let device = peripheral
        connection = nil
        peripheral = nil
        writer = nil
        timeout?.cancel()
        if central.isScanning {
            central.stopScan()
        }
        if let device {
            device.delegate = nil
            central.cancelPeripheralConnection(device)
        }
        pending?.resume(throwing: error)
        onDisconnection?()
    }
}
