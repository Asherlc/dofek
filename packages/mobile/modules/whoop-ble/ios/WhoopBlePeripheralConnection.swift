import CoreBluetooth

/// The peripheral operations owned by one BLE connection attempt.
protocol WhoopBlePeripheralConnection: AnyObject {
    var identifier: UUID { get }
    var name: String? { get }
    var state: CBPeripheralState { get }
    var delegate: CBPeripheralDelegate? { get set }
    var services: [CBService]? { get }
    /// Native object identity must survive separate callback adapters.
    var notificationSource: AnyObject { get }

    func connect()
    func cancelConnection()
    func discoverServices(_ serviceUUIDs: [CBUUID]?)
    func discoverCharacteristics(_ characteristicUUIDs: [CBUUID]?, for service: CBService)
    func setNotifyValue(_ enabled: Bool, for characteristic: CBCharacteristic)
    func readValue(for characteristic: CBCharacteristic)
    func writeValue(_ data: Data, for characteristic: CBCharacteristic, type: CBCharacteristicWriteType)
}

/// Keeps CoreBluetooth objects and connection operations at the native boundary.
final class WhoopBleCoreBluetoothPeripheral: WhoopBlePeripheralConnection {
    private let peripheral: CBPeripheral
    private let central: CBCentralManager

    init(_ peripheral: CBPeripheral, central: CBCentralManager) {
        self.peripheral = peripheral
        self.central = central
    }

    var identifier: UUID { peripheral.identifier }
    var name: String? { peripheral.name }
    var state: CBPeripheralState { peripheral.state }
    var services: [CBService]? { peripheral.services }
    var notificationSource: AnyObject { peripheral }
    var delegate: CBPeripheralDelegate? {
        get { peripheral.delegate }
        set { peripheral.delegate = newValue }
    }

    func connect() { central.connect(peripheral, options: nil) }
    func cancelConnection() { central.cancelPeripheralConnection(peripheral) }
    func discoverServices(_ serviceUUIDs: [CBUUID]?) { peripheral.discoverServices(serviceUUIDs) }
    func discoverCharacteristics(_ characteristicUUIDs: [CBUUID]?, for service: CBService) {
        peripheral.discoverCharacteristics(characteristicUUIDs, for: service)
    }
    func setNotifyValue(_ enabled: Bool, for characteristic: CBCharacteristic) {
        peripheral.setNotifyValue(enabled, for: characteristic)
    }
    func readValue(for characteristic: CBCharacteristic) { peripheral.readValue(for: characteristic) }
    func writeValue(_ data: Data, for characteristic: CBCharacteristic, type: CBCharacteristicWriteType) {
        peripheral.writeValue(data, for: characteristic, type: type)
    }
}
