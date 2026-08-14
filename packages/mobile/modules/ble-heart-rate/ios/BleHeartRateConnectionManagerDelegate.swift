import Foundation

/// A heart-rate device discovered/connected over BLE.
struct BleHeartRateDevice {
    let id: String
    let name: String?
}

/// Events emitted by the connection manager to its delegate (the Expo module).
protocol BleHeartRateConnectionManagerDelegate: AnyObject {
    /// Called when a device is connected and the measurement characteristic is
    /// subscribed and ready to deliver notifications.
    func connectionManagerDidBecomeReady(
        _ manager: BleHeartRateConnectionManager,
        device: BleHeartRateDevice
    )

    /// Called when the peripheral disconnects.
    func connectionManagerDidDisconnect(
        _ manager: BleHeartRateConnectionManager,
        peripheralId: String,
        error: Error?
    )

    /// Called for each decoded Heart Rate Measurement notification.
    func connectionManager(
        _ manager: BleHeartRateConnectionManager,
        didReceiveMeasurement measurement: BleHeartRateMeasurement,
        from deviceId: String,
        at timestamp: Date
    )
}
