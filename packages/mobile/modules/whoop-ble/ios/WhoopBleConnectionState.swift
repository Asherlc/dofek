/// Connection state machine for the WHOOP BLE module.
enum ConnectionState: String {
    case idle
    case scanning
    case connecting
    case discoveringServices
    case subscribing
    case ready
    case streaming
}

/// Errors specific to the BLE connection lifecycle.
enum WhoopBleConnectionError: Error {
    case invalidPeripheralId(String)
    case peripheralNotFound(String)
    case timeout
    case serviceDiscoveryFailed(String)
    case characteristicDiscoveryFailed(String)
    case serviceNotFound
    case characteristicsNotFound
    case notificationSubscriptionFailed(String)
    case disconnected(String?)

    var rejection: (code: String, message: String) {
        switch self {
        case .invalidPeripheralId(let identifier):
            ("INVALID_ID", "Invalid peripheral ID: \(identifier)")
        case .peripheralNotFound(let identifier):
            ("NOT_FOUND", "Peripheral not found: \(identifier)")
        case .timeout:
            ("TIMEOUT", "Connection timed out")
        case .serviceDiscoveryFailed(let message):
            ("SERVICE_DISCOVERY_FAILED", message)
        case .characteristicDiscoveryFailed(let message):
            ("CHARACTERISTIC_DISCOVERY_FAILED", message)
        case .serviceNotFound:
            ("NO_SERVICE", "WHOOP service not found")
        case .characteristicsNotFound:
            ("NO_CHARACTERISTICS", "Required characteristics not found")
        case .notificationSubscriptionFailed(let message):
            ("NOTIFICATION_SUBSCRIPTION_FAILED", message)
        case .disconnected(let message):
            ("DISCONNECTED", message ?? "Disconnected")
        }
    }
}
