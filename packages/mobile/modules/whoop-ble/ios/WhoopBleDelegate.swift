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
        if central.state == .poweredOn {
            connectionManager?.handleCentralManagerPoweredOn()
        }
    }

    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        guard let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral],
              let peripheral = peripherals.first else {
            return
        }
        peripheral.delegate = self
        connectionManager?.handleRestoredPeripheral(peripheral)
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        connectionManager?.handlePeripheralDiscovered(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        connectionManager?.handlePeripheralConnected(peripheral)
    }

    func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        connectionManager?.handlePeripheralDisconnected(peripheral, error: error)
    }

    func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        connectionManager?.handlePeripheralDisconnected(peripheral, error: error)
    }

    // MARK: - CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error = error {
            NSLog("[WhoopBLE] service discovery error: %@", error.localizedDescription)
            return
        }
        connectionManager?.handleServicesDiscovered(peripheral)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        if let error = error {
            NSLog("[WhoopBLE] characteristic discovery error: %@", error.localizedDescription)
            return
        }
        connectionManager?.handleCharacteristicsDiscovered(peripheral, service: service)
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
