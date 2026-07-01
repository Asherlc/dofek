/// Connection state machine for the Bluetooth heart-rate module.
enum BleHeartRateConnectionState: String {
    case idle
    case scanning
    case connecting
    case discoveringServices
    case ready
}

/// Errors specific to the heart-rate BLE connection lifecycle.
enum BleHeartRateConnectionError: Error {
    case bluetoothUnavailable
    case invalidPeripheralId(String)
    case peripheralNotFound(String)
    case scanTimeout
    case connectTimeout
    case serviceNotFound
    case characteristicNotFound
}
