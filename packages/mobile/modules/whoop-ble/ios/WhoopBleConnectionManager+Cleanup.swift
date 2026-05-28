import CoreBluetooth

extension WhoopBleConnectionManager {
    func cleanup() {
        if let peripheral = connectedPeripheral {
            if peripheral.state == .connected {
                [dataCharacteristic, cmdResponseCharacteristic]
                    .compactMap { $0 }
                    .filter(\.isNotifying)
                    .forEach { peripheral.setNotifyValue(false, for: $0) }
            }
            peripheral.delegate = nil
        }
        resetConnectionReferences()
    }
}
