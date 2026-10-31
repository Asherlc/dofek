import CoreBluetooth

/// Bridges CoreBluetooth delegate callbacks to the connection manager.
///
/// CBCentralManager and CBPeripheral both require ObjC-compatible delegates
/// (NSObject subclasses). This class holds a weak reference to the connection
/// manager and forwards all callbacks to it.
final class WhoopBleDelegate: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    weak var connectionManager: WhoopBleConnectionManager?

    // MARK: - CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        connectionManager?.handleCentralManagerStateUpdated(central.state)
    }

    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
        guard let manager = connectionManager else { return }
        manager.handleRestoration(peripherals.map(manager.peripheralConnection))
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard let manager = connectionManager else { return }
        manager.handlePeripheralDiscovered(manager.peripheralConnection(peripheral))
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard let manager = connectionManager else { return }
        manager.handlePeripheralConnected(manager.peripheralConnection(peripheral))
    }

    func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        guard let manager = connectionManager else { return }
        manager.handlePeripheralDisconnected(manager.peripheralConnection(peripheral), error: error)
    }

    func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        guard let manager = connectionManager else { return }
        manager.handlePeripheralDisconnected(manager.peripheralConnection(peripheral), error: error)
    }

    // MARK: - CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error = error {
            NSLog("[WhoopBLE] service discovery error: %@", error.localizedDescription)
            guard let manager = connectionManager else { return }
            manager.abortHandshake(
                for: manager.peripheralConnection(peripheral),
                with: .serviceDiscoveryFailed(error.localizedDescription),
                underlyingError: error
            )
            return
        }
        guard let manager = connectionManager else { return }
        manager.handleServicesDiscovered(manager.peripheralConnection(peripheral))
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        if let error = error {
            NSLog("[WhoopBLE] characteristic discovery error: %@", error.localizedDescription)
            guard let manager = connectionManager,
                  manager.connectedPeripheral?.identifier == peripheral.identifier else { return }
            manager.handleCharacteristicDiscoveryError(serviceUUID: service.uuid, error: error) {
                manager.peripheralConnection(peripheral).cancelConnection()
            }
            return
        }
        guard let manager = connectionManager else { return }
        manager.handleCharacteristicsDiscovered(manager.peripheralConnection(peripheral), service: service)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard let manager = connectionManager else { return }
        manager.handleNotificationStateUpdated(
            manager.peripheralConnection(peripheral),
            characteristic: characteristic,
            error: error
        )
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didWriteValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        if let error = error {
            NSLog("[WhoopBLE] write error on %@: %@",
                  characteristic.uuid.uuidString, error.localizedDescription)
            connectionManager?.lastWriteError = error.localizedDescription
        } else {
            NSLog("[WhoopBLE] write succeeded on %@", characteristic.uuid.uuidString)
            connectionManager?.lastWriteError = nil
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        if let error = error {
            NSLog("[WhoopBLE] notification error on %@: %@",
                  characteristic.uuid.uuidString, error.localizedDescription)
            return
        }
        guard let data = characteristic.value else {
            NSLog("[WhoopBLE] notification with nil value on %@", characteristic.uuid.uuidString)
            return
        }
        connectionManager?.handleNotification(from: characteristic, data: data)
    }
}
