import CoreBluetooth

/// Manages the BLE connection lifecycle: scanning, connecting, service/characteristic
/// discovery, auto-reconnect, and state restoration.
///
/// The connection manager owns all CoreBluetooth state and delegates domain-specific
/// processing (frame parsing, sample buffering) to its delegate via callbacks.
final class WhoopBleConnectionManager {
    weak var delegate: WhoopBleConnectionManagerDelegate?

    private(set) var state: ConnectionState = .idle
    private(set) var connectedPeripheral: CBPeripheral?
    private(set) var cmdCharacteristic: CBCharacteristic?

    let bleQueue: DispatchQueue
    let bleDelegate: WhoopBleDelegate

    static let bleQueueKey = DispatchSpecificKey<Bool>()

    var centralManager: CBCentralManager?
    var cmdResponseCharacteristic: CBCharacteristic?
    var dataCharacteristic: CBCharacteristic?
    var autoReconnect = false
    var wasStreaming = false

    var findCompletion: (([String: Any?]?) -> Void)?
    var connectCompletion: ((Result<Bool, WhoopBleConnectionError>) -> Void)?
    var pendingPoweredOnCompletion: (([String: Any?]?) -> Void)?

    /// Last write error for diagnostics.
    var lastWriteError: String?

    static let restoreIdentifier = "com.dofek.whoop-ble-central"

    init() {
        bleQueue = DispatchQueue(label: "com.dofek.whoop-ble", qos: .userInitiated)
        bleQueue.setSpecific(key: Self.bleQueueKey, value: true)
        bleDelegate = WhoopBleDelegate()
        bleDelegate.connectionManager = self
    }

    func syncOnBleQueue<T>(_ work: () -> T) -> T {
        if DispatchQueue.getSpecific(key: Self.bleQueueKey) == true {
            return work()
        }
        return bleQueue.sync(execute: work)
    }

    // MARK: - Public API

    /// Current Bluetooth state as a human-readable string.
    var bluetoothState: String {
        guard let manager = centralManager else { return "uninitialized" }
        switch manager.state {
        case .unknown: return "unknown"
        case .resetting: return "resetting"
        case .unsupported: return "unsupported"
        case .unauthorized: return "unauthorized"
        case .poweredOff: return "poweredOff"
        case .poweredOn: return "poweredOn"
        @unknown default: return "unknown"
        }
    }

    var isBluetoothAvailable: Bool {
        ensureCentralManager().state == .poweredOn
    }

    var hasDataCharacteristic: Bool { dataCharacteristic != nil }
    var isNotifying: Bool { dataCharacteristic?.isNotifying ?? false }
    var hasCmdCharacteristic: Bool { cmdCharacteristic != nil }
    var hasCmdResponseCharacteristic: Bool { cmdResponseCharacteristic != nil }

    // MARK: - Find

    func findWhoop(completion: @escaping ([String: Any?]?) -> Void) {
        let manager = ensureCentralManager()

        bleQueue.async {
            if manager.state == .poweredOn {
                NSLog("[WhoopBLE] findWhoop: Bluetooth poweredOn, searching immediately")
                self.performFind(manager: manager, completion: completion)
            } else {
                NSLog("[WhoopBLE] findWhoop: Bluetooth not ready (state=%ld), waiting for poweredOn",
                      manager.state.rawValue)
                self.pendingPoweredOnCompletion = completion
                self.bleQueue.asyncAfter(deadline: .now() + 3) {
                    guard let pending = self.pendingPoweredOnCompletion else { return }
                    NSLog("[WhoopBLE] findWhoop: timed out waiting for poweredOn (state=%ld)",
                          manager.state.rawValue)
                    self.pendingPoweredOnCompletion = nil
                    pending(nil)
                }
            }
        }
    }

    // MARK: - Connect

    func connect(
        peripheralId: String,
        completion: @escaping (Result<Bool, WhoopBleConnectionError>) -> Void
    ) {
        let centralManager = ensureCentralManager()

        bleQueue.async {
            guard let uuid = UUID(uuidString: peripheralId) else {
                completion(.failure(.invalidPeripheralId(peripheralId)))
                return
            }

            let peripherals = centralManager.retrievePeripherals(withIdentifiers: [uuid])
            guard let peripheral = peripherals.first else {
                completion(.failure(.peripheralNotFound(peripheralId)))
                return
            }

            self.connectedPeripheral = peripheral
            peripheral.delegate = self.bleDelegate
            self.connectCompletion = completion
            self.state = .connecting
            self.autoReconnect = true
            centralManager.connect(peripheral, options: nil)

            self.bleQueue.asyncAfter(deadline: .now() + 10) {
                if self.state == .connecting {
                    self.state = .idle
                    centralManager.cancelPeripheralConnection(peripheral)
                    self.connectCompletion?(.failure(.timeout))
                    self.connectCompletion = nil
                }
            }
        }
    }

    // MARK: - Retry

    func retryConnection(completion: @escaping (Bool) -> Void) {
        let manager = ensureCentralManager()

        bleQueue.async {
            if self.connectedPeripheral?.state == .connected {
                NSLog("[WhoopBLE] retryConnection: already connected")
                completion(true)
                return
            }

            guard manager.state == .poweredOn else {
                NSLog("[WhoopBLE] retryConnection: Bluetooth not ready")
                completion(false)
                return
            }

            for serviceUUID in WhoopBleConstants.allServiceUUIDs {
                let connected = manager.retrieveConnectedPeripherals(withServices: [serviceUUID])
                if let peripheral = connected.first {
                    NSLog("[WhoopBLE] retryConnection: found connected strap %@, connecting",
                          peripheral.identifier.uuidString)
                    self.connectedPeripheral = peripheral
                    peripheral.delegate = self.bleDelegate
                    self.state = .connecting
                    self.autoReconnect = true
                    manager.connect(peripheral, options: nil)
                    completion(true)
                    return
                }
            }

            NSLog("[WhoopBLE] retryConnection: no connected strap found, scanning 10s")
            self.autoReconnect = true
            manager.scanForPeripherals(
                withServices: WhoopBleConstants.allServiceUUIDs,
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
            )

            self.bleQueue.asyncAfter(deadline: .now() + 10) {
                if self.connectedPeripheral == nil {
                    manager.stopScan()
                    NSLog("[WhoopBLE] retryConnection: scan timeout, no strap found")
                }
            }

            completion(false)
        }
    }

    // MARK: - Disconnect

    func disconnect() {
        bleQueue.async {
            self.autoReconnect = false
            if let peripheral = self.connectedPeripheral {
                self.centralManager?.cancelPeripheralConnection(peripheral)
            }
            self.cleanup()
        }
    }

    // MARK: - Command writing

    /// Write raw bytes to CMD_TO_STRAP. No-op if not connected.
    func writeToStrap(_ data: Data) {
        guard let peripheral = connectedPeripheral,
              let cmdChar = cmdCharacteristic else { return }
        peripheral.writeValue(data, for: cmdChar, type: .withResponse)
    }

    // MARK: - State transitions (called by the module)

    /// Transition from `.ready` to `.streaming`.
    /// - Returns: `true` if already streaming or successfully transitioned.
    func startStreaming() -> Bool {
        if state == .streaming { return true }
        guard state == .ready else { return false }
        state = .streaming
        return true
    }

    /// Transition from `.streaming` to `.ready`.
    func stopStreaming() {
        if state == .streaming {
            state = .ready
        }
    }

    // MARK: - Internal state mutation

    func setState(_ newState: ConnectionState) {
        state = newState
    }

    func setConnectedPeripheral(_ peripheral: CBPeripheral?) {
        connectedPeripheral = peripheral
    }

    func setDiscoveredCharacteristics(
        cmdCharacteristic: CBCharacteristic?,
        cmdResponseCharacteristic: CBCharacteristic?,
        dataCharacteristic: CBCharacteristic?
    ) {
        self.cmdCharacteristic = cmdCharacteristic
        self.cmdResponseCharacteristic = cmdResponseCharacteristic
        self.dataCharacteristic = dataCharacteristic
    }

    func resetConnectionReferences() {
        state = .idle
        connectedPeripheral = nil
        cmdCharacteristic = nil
        cmdResponseCharacteristic = nil
        dataCharacteristic = nil
    }
}
