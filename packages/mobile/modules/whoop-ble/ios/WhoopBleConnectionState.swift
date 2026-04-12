/// Connection state machine for the WHOOP BLE module.
enum ConnectionState: String {
    case idle
    case scanning
    case connecting
    case discoveringServices
    case ready
    case streaming
}

/// Errors specific to the BLE connection lifecycle.
enum WhoopBleConnectionError: Error {
    case invalidPeripheralId(String)
    case peripheralNotFound(String)
    case timeout
    case serviceNotFound
    case characteristicsNotFound
    case disconnected(String?)
}
