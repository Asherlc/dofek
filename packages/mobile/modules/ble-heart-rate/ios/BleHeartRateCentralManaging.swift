import CoreBluetooth

/// The Core Bluetooth operations the heart-rate connection manager needs to
/// manage independent peripheral sessions.
protocol BleHeartRateCentralManaging: AnyObject {
    var state: CBManagerState { get }

    func scanForPeripherals(withServices serviceUUIDs: [CBUUID]?, options: [String: Any]?)
    func stopScan()
    func retrievePeripherals(withIdentifiers identifiers: [UUID]) -> [CBPeripheral]
    func connect(_ peripheral: CBPeripheral, options: [String: Any]?)
    func cancelPeripheralConnection(_ peripheral: CBPeripheral)
}

extension CBCentralManager: BleHeartRateCentralManaging {}
