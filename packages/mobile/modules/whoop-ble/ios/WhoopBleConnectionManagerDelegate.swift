import CoreBluetooth

/// Events emitted by the connection manager to its delegate (the module).
protocol WhoopBleConnectionManagerDelegate: AnyObject {
    /// Called when connection is fully established and characteristics are ready.
    func connectionManagerDidBecomeReady(
        _ manager: WhoopBleConnectionManager,
        peripheral: CBPeripheral,
        cmdCharacteristic: CBCharacteristic,
        wasStreaming: Bool
    )

    /// Called when the peripheral disconnects (after cleanup and auto-reconnect).
    func connectionManagerDidDisconnect(
        _ manager: WhoopBleConnectionManager,
        peripheralId: String,
        error: Error?
    )

    /// Called when data arrives on DATA_FROM_STRAP.
    func connectionManager(_ manager: WhoopBleConnectionManager, didReceiveData data: Data)

    /// Called when a command response arrives on CMD_FROM_STRAP.
    func connectionManager(_ manager: WhoopBleConnectionManager, didReceiveCommandResponse data: Data)
}
