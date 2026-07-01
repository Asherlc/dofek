import CoreBluetooth
import Foundation

/// Manages the BLE lifecycle for a standard Heart Rate Service device: scanning,
/// connecting, discovering the measurement characteristic, and subscribing to
/// notifications. Decoded measurements are handed to the delegate.
///
/// Unlike the WHOOP manager (which piggybacks on a device the WHOOP app already
/// holds open), this scans for and pairs a fresh heart-rate strap, so the flow
/// is the textbook central: scan → connect → discover → subscribe.
final class BleHeartRateConnectionManager: NSObject {
    weak var delegate: BleHeartRateConnectionManagerDelegate?

    private(set) var state: BleHeartRateConnectionState = .idle

    let bleQueue: DispatchQueue
    private var centralManager: CBCentralManager?
    private var connectedPeripheral: CBPeripheral?
    private var connectCompletion: ((Result<BleHeartRateDevice, BleHeartRateConnectionError>) -> Void)?

    /// A request deferred until Bluetooth reports `.poweredOn`. CoreBluetooth's
    /// central starts in `.unknown` and only settles asynchronously, so the
    /// first scan/connect after launch usually has to wait.
    private enum PendingOperation {
        case scan
        case connect(String)
    }
    private var pendingOperation: PendingOperation?

    /// Time to wait for Bluetooth to power on before giving up.
    private static let poweredOnTimeoutSeconds: TimeInterval = 5
    /// Time to wait for a strap to appear during a scan.
    private static let scanTimeoutSeconds: TimeInterval = 15
    /// Time to wait for the connection + discovery handshake.
    private static let connectTimeoutSeconds: TimeInterval = 10

    override init() {
        bleQueue = DispatchQueue(label: "com.dofek.ble-heart-rate", qos: .userInitiated)
        super.init()
    }

    private func ensureCentralManager() -> CBCentralManager {
        if let manager = centralManager { return manager }
        let manager = CBCentralManager(delegate: self, queue: bleQueue)
        centralManager = manager
        return manager
    }

    var isBluetoothAvailable: Bool {
        ensureCentralManager().state == .poweredOn
    }

    // MARK: - Scan + connect

    /// Scan for a heart-rate strap and connect to the first one found.
    func scanAndConnect(
        completion: @escaping (Result<BleHeartRateDevice, BleHeartRateConnectionError>) -> Void
    ) {
        let manager = ensureCentralManager()
        bleQueue.async {
            self.connectCompletion = completion
            self.runOrDefer(.scan, manager: manager)
        }
    }

    /// Reconnect to a previously discovered strap by its peripheral identifier.
    func connect(
        peripheralId: String,
        completion: @escaping (Result<BleHeartRateDevice, BleHeartRateConnectionError>) -> Void
    ) {
        let manager = ensureCentralManager()
        bleQueue.async {
            self.connectCompletion = completion
            self.runOrDefer(.connect(peripheralId), manager: manager)
        }
    }

    func disconnect() {
        bleQueue.async {
            self.pendingOperation = nil
            self.centralManager?.stopScan()
            if let peripheral = self.connectedPeripheral {
                self.centralManager?.cancelPeripheralConnection(peripheral)
            }
            self.connectedPeripheral = nil
            self.state = .idle
        }
    }

    // MARK: - Operation dispatch

    private func runOrDefer(_ operation: PendingOperation, manager: CBCentralManager) {
        switch manager.state {
        case .poweredOn:
            perform(operation, manager: manager)
        case .unknown, .resetting:
            // Wait for the state to settle, then run (or fail on timeout).
            pendingOperation = operation
            bleQueue.asyncAfter(deadline: .now() + Self.poweredOnTimeoutSeconds) {
                guard self.pendingOperation != nil else { return }
                self.pendingOperation = nil
                self.failPendingConnect(with: .bluetoothUnavailable)
            }
        default:
            // poweredOff, unauthorized, unsupported — not going to work.
            failPendingConnect(with: .bluetoothUnavailable)
        }
    }

    private func perform(_ operation: PendingOperation, manager: CBCentralManager) {
        switch operation {
        case .scan:
            startScan(manager)
        case .connect(let peripheralId):
            performConnect(peripheralId: peripheralId, manager: manager)
        }
    }

    private func startScan(_ manager: CBCentralManager) {
        state = .scanning
        manager.scanForPeripherals(
            withServices: [BleHeartRateConstants.heartRateServiceUUID],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
        bleQueue.asyncAfter(deadline: .now() + Self.scanTimeoutSeconds) {
            guard self.state == .scanning else { return }
            manager.stopScan()
            self.state = .idle
            self.failPendingConnect(with: .scanTimeout)
        }
    }

    private func performConnect(peripheralId: String, manager: CBCentralManager) {
        guard let uuid = UUID(uuidString: peripheralId) else {
            failPendingConnect(with: .invalidPeripheralId(peripheralId))
            return
        }
        guard let peripheral = manager.retrievePeripherals(withIdentifiers: [uuid]).first else {
            failPendingConnect(with: .peripheralNotFound(peripheralId))
            return
        }
        beginConnecting(to: peripheral, manager: manager)
    }

    private func beginConnecting(to peripheral: CBPeripheral, manager: CBCentralManager) {
        connectedPeripheral = peripheral
        peripheral.delegate = self
        state = .connecting
        manager.connect(peripheral, options: nil)

        bleQueue.asyncAfter(deadline: .now() + Self.connectTimeoutSeconds) {
            guard self.state == .connecting || self.state == .discoveringServices else { return }
            manager.cancelPeripheralConnection(peripheral)
            self.state = .idle
            self.failPendingConnect(with: .connectTimeout)
        }
    }

    private func failPendingConnect(with error: BleHeartRateConnectionError) {
        let completion = connectCompletion
        connectCompletion = nil
        completion?(.failure(error))
    }

    private func device(for peripheral: CBPeripheral) -> BleHeartRateDevice {
        BleHeartRateDevice(id: peripheral.identifier.uuidString, name: peripheral.name)
    }
}

// MARK: - CBCentralManagerDelegate

extension BleHeartRateConnectionManager: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn {
            if let operation = pendingOperation {
                pendingOperation = nil
                perform(operation, manager: central)
            }
            return
        }

        // Bluetooth went (or stayed) unavailable — abandon any in-flight work.
        if pendingOperation != nil || state != .idle {
            pendingOperation = nil
            central.stopScan()
            state = .idle
            failPendingConnect(with: .bluetoothUnavailable)
        }
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard state == .scanning else { return }
        central.stopScan()
        beginConnecting(to: peripheral, manager: central)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        state = .discoveringServices
        peripheral.discoverServices([BleHeartRateConstants.heartRateServiceUUID])
    }

    func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        state = .idle
        connectedPeripheral = nil
        failPendingConnect(with: .connectTimeout)
    }

    func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        state = .idle
        connectedPeripheral = nil
        delegate?.connectionManagerDidDisconnect(
            self,
            peripheralId: peripheral.identifier.uuidString,
            error: error
        )
    }
}

// MARK: - CBPeripheralDelegate

extension BleHeartRateConnectionManager: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard
            let service = peripheral.services?.first(where: {
                $0.uuid == BleHeartRateConstants.heartRateServiceUUID
            })
        else {
            state = .idle
            failPendingConnect(with: .serviceNotFound)
            return
        }
        peripheral.discoverCharacteristics(
            [BleHeartRateConstants.heartRateMeasurementUUID],
            for: service
        )
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        guard
            let characteristic = service.characteristics?.first(where: {
                $0.uuid == BleHeartRateConstants.heartRateMeasurementUUID
            })
        else {
            state = .idle
            failPendingConnect(with: .characteristicNotFound)
            return
        }

        peripheral.setNotifyValue(true, for: characteristic)
        state = .ready

        let connectedDevice = device(for: peripheral)
        let completion = connectCompletion
        connectCompletion = nil
        completion?(.success(connectedDevice))
        delegate?.connectionManagerDidBecomeReady(self, device: connectedDevice)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard
            characteristic.uuid == BleHeartRateConstants.heartRateMeasurementUUID,
            let data = characteristic.value,
            let measurement = BleHeartRateMeasurementParser.parse(data)
        else { return }

        delegate?.connectionManager(self, didReceiveMeasurement: measurement, at: Date())
    }
}
