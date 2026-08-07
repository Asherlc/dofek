/// Connection state machine for the Bluetooth heart-rate module.
enum BleHeartRateConnectionState: String {
    case idle
    case scanning
    case connecting
    case discoveringServices
    /// Characteristic found; waiting for the notify subscription to be confirmed.
    case subscribing
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
    /// `setNotifyValue` failed, so no live measurements would arrive.
    case notificationSubscriptionFailed
    /// The peripheral disconnected before the handshake completed.
    case disconnected(String?)
    /// A connection attempt is already in flight.
    case busy
}
