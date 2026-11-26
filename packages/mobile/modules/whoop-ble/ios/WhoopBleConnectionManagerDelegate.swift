import CoreBluetooth

/// Events emitted by the connection manager to its delegate (the module).
protocol WhoopBleConnectionManagerDelegate: AnyObject {
    /// Called when the manager adopts a peripheral, before it sets up its delegate or subscriptions.
    func connectionManagerDidSelectPeripheral(_ manager: WhoopBleConnectionManager)

    /// Called when connection is fully established and characteristics are ready.
    func connectionManagerDidBecomeReady(
        _ manager: WhoopBleConnectionManager,
        peripheral: any WhoopBlePeripheralConnection,
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

    /// Called on the BLE queue when either observed battery fact changes or clears.
    func connectionManager(_: WhoopBleConnectionManager, didUpdateBatteryStatus: WhoopBleBatteryStatus)

    /// Called on the BLE queue when a strap is marked unsupported (NO_SERVICE) or cleared.
    func connectionManager(_: WhoopBleConnectionManager, didUpdateUnsupportedDevice: Bool)
}

extension WhoopBleConnectionManagerDelegate {
    func connectionManager(_: WhoopBleConnectionManager, didUpdateBatteryStatus _: WhoopBleBatteryStatus) {}
}

extension WhoopBleConnectionManagerDelegate {
    func connectionManager(_: WhoopBleConnectionManager, didUpdateUnsupportedDevice _: Bool) {}
}

extension WhoopBleConnectionManagerDelegate {
    func connectionManagerDidSelectPeripheral(_ manager: WhoopBleConnectionManager) {}
}
