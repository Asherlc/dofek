import CoreBluetooth

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

    private var centralManager: CBCentralManager?
    private var cmdResponseCharacteristic: CBCharacteristic?
    private var dataCharacteristic: CBCharacteristic?
    private var autoReconnect = false
    private var wasStreaming = false

    private var findCompletion: (([String: Any?]?) -> Void)?
    private var connectCompletion: ((Result<Bool, WhoopBleConnectionError>) -> Void)?
    private var pendingPoweredOnCompletion: (([String: Any?]?) -> Void)?

    /// Last write error for diagnostics.
    var lastWriteError: String?

    private static let restoreIdentifier = "com.dofek.whoop-ble-central"

    init() {
        bleQueue = DispatchQueue(label: "com.dofek.whoop-ble", qos: .userInitiated)
        bleDelegate = WhoopBleDelegate()
        bleDelegate.connectionManager = self
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
        bleQueue.async {
            guard let centralManager = self.centralManager,
                  let uuid = UUID(uuidString: peripheralId) else {
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

    // MARK: - Internal handlers (called by BleDelegate)

    func handleCentralManagerPoweredOn() {
        NSLog("[WhoopBLE] centralManager poweredOn")

        if let pending = pendingPoweredOnCompletion, let manager = centralManager {
            NSLog("[WhoopBLE] resolving pending findWhoop after poweredOn")
            pendingPoweredOnCompletion = nil
            performFind(manager: manager, completion: pending)
        }

        if connectedPeripheral == nil && pendingPoweredOnCompletion == nil && autoReconnect {
            NSLog("[WhoopBLE] no strap connected, starting background scan for WHOOP")
            centralManager?.scanForPeripherals(
                withServices: WhoopBleConstants.allServiceUUIDs,
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
            )
        }

        if let peripheral = connectedPeripheral, state == .idle {
            if peripheral.state == .connected {
                state = .discoveringServices
                peripheral.discoverServices(WhoopBleConstants.allServiceUUIDs)
            } else {
                state = .connecting
                centralManager?.connect(peripheral, options: nil)
            }
        }
    }

    func handleRestoredPeripheral(_ peripheral: CBPeripheral) {
        connectedPeripheral = peripheral
        peripheral.delegate = bleDelegate
        autoReconnect = true
        wasStreaming = true

        if peripheral.state == .connected {
            state = .discoveringServices
            peripheral.discoverServices(WhoopBleConstants.allServiceUUIDs)
        }
    }

    func handlePeripheralDiscovered(_ peripheral: CBPeripheral) {
        if state == .scanning {
            centralManager?.stopScan()
            state = .idle

            let result: [String: Any?] = [
                "id": peripheral.identifier.uuidString,
                "name": peripheral.name,
            ]
            findCompletion?(result)
            findCompletion = nil
            return
        }

        if connectedPeripheral == nil && autoReconnect {
            NSLog("[WhoopBLE] background scan found WHOOP strap %@ (%@), auto-connecting",
                  peripheral.identifier.uuidString, peripheral.name ?? "unnamed")
            centralManager?.stopScan()
            connectedPeripheral = peripheral
            peripheral.delegate = bleDelegate
            state = .connecting
            centralManager?.connect(peripheral, options: nil)

            // Timeout — the normal connect() path has a 10s timeout, but this
            // auto-connect path had none. Without this, a peripheral that
            // advertises but can't complete GATT connection stays .connecting forever.
            bleQueue.asyncAfter(deadline: .now() + 10) { [weak self] in
                guard let self = self, self.state == .connecting,
                      self.connectedPeripheral?.identifier == peripheral.identifier else { return }
                NSLog("[WhoopBLE] auto-connect timeout for %@", peripheral.identifier.uuidString)
                self.centralManager?.cancelPeripheralConnection(peripheral)
            }
        }
    }

    func handlePeripheralConnected(_ peripheral: CBPeripheral) {
        NSLog("[WhoopBLE] peripheral connected: %@ (state=%@)",
              peripheral.identifier.uuidString, state.rawValue)
        guard state == .connecting else { return }

        state = .discoveringServices
        peripheral.discoverServices(WhoopBleConstants.allServiceUUIDs)
    }

    func handlePeripheralDisconnected(_ peripheral: CBPeripheral, error: Error?) {
        NSLog("[WhoopBLE] peripheral disconnected: %@ (wasState=%@, error=%@, autoReconnect=%@)",
              peripheral.identifier.uuidString, state.rawValue,
              error?.localizedDescription ?? "none", autoReconnect ? "true" : "false")

        wasStreaming = state == .streaming
        let shouldReconnect = autoReconnect
        let peripheralId = peripheral.identifier.uuidString

        cleanup()

        delegate?.connectionManagerDidDisconnect(self, peripheralId: peripheralId, error: error)

        connectCompletion?(.failure(.disconnected(error?.localizedDescription)))
        connectCompletion = nil

        if shouldReconnect {
            autoReconnect = true
            state = .connecting
            connectedPeripheral = peripheral
            peripheral.delegate = bleDelegate
            centralManager?.connect(peripheral, options: nil)
        }
    }

    func handleServicesDiscovered(_ peripheral: CBPeripheral) {
        let serviceUUIDs = peripheral.services?.map { $0.uuid.uuidString } ?? []
        NSLog("[WhoopBLE] services discovered: %@", serviceUUIDs.joined(separator: ", "))
        guard state == .discoveringServices else { return }

        guard let service = peripheral.services?.first(where: { service in
            WhoopBleConstants.allServiceUUIDs.contains(service.uuid)
        }) else {
            NSLog("[WhoopBLE] NO WHOOP service found among discovered services")
            connectCompletion?(.failure(.serviceNotFound))
            connectCompletion = nil
            state = .idle
            return
        }

        let cmdUUID = WhoopBleConstants.cmdToStrapUUID(forService: service.uuid)
        let cmdRespUUID = WhoopBleConstants.cmdFromStrapUUID(forService: service.uuid)
        let dataUUID = WhoopBleConstants.dataFromStrapUUID(forService: service.uuid)
        peripheral.discoverCharacteristics([cmdUUID, cmdRespUUID, dataUUID], for: service)
    }

    func handleCharacteristicsDiscovered(_ peripheral: CBPeripheral, service: CBService) {
        let charUUIDs = service.characteristics?.map { $0.uuid.uuidString } ?? []
        NSLog("[WhoopBLE] characteristics discovered for service %@: %@",
              service.uuid.uuidString, charUUIDs.joined(separator: ", "))
        guard state == .discoveringServices else { return }

        let cmdUUID = WhoopBleConstants.cmdToStrapUUID(forService: service.uuid)
        let cmdRespUUID = WhoopBleConstants.cmdFromStrapUUID(forService: service.uuid)
        let dataUUID = WhoopBleConstants.dataFromStrapUUID(forService: service.uuid)

        cmdCharacteristic = service.characteristics?.first { $0.uuid == cmdUUID }
        cmdResponseCharacteristic = service.characteristics?.first { $0.uuid == cmdRespUUID }
        dataCharacteristic = service.characteristics?.first { $0.uuid == dataUUID }

        guard let cmdChar = cmdCharacteristic, let dataChar = dataCharacteristic else {
            NSLog("[WhoopBLE] missing characteristics: cmd=%@, data=%@",
                  cmdCharacteristic == nil ? "MISSING" : "found",
                  dataCharacteristic == nil ? "MISSING" : "found")
            connectCompletion?(.failure(.characteristicsNotFound))
            connectCompletion = nil
            state = .idle
            return
        }

        NSLog("[WhoopBLE] subscribing to DATA_FROM_STRAP + CMD_FROM_STRAP notifications")
        peripheral.setNotifyValue(true, for: dataChar)
        if let cmdRespChar = cmdResponseCharacteristic {
            peripheral.setNotifyValue(true, for: cmdRespChar)
        }

        state = .ready
        let previouslyStreaming = wasStreaming
        wasStreaming = false

        connectCompletion?(.success(true))
        connectCompletion = nil

        delegate?.connectionManagerDidBecomeReady(
            self, peripheral: peripheral, cmdCharacteristic: cmdChar,
            wasStreaming: previouslyStreaming
        )
    }

    /// Route a BLE notification to the appropriate delegate callback.
    func handleNotification(from characteristic: CBCharacteristic, data: Data) {
        if characteristic.uuid == cmdResponseCharacteristic?.uuid {
            delegate?.connectionManager(self, didReceiveCommandResponse: data)
        } else {
            delegate?.connectionManager(self, didReceiveData: data)
        }
    }

    // MARK: - Private

    @discardableResult
    func ensureCentralManager() -> CBCentralManager {
        if let existing = centralManager {
            return existing
        }
        let manager = CBCentralManager(
            delegate: bleDelegate,
            queue: bleQueue,
            options: [
                CBCentralManagerOptionShowPowerAlertKey: false,
                CBCentralManagerOptionRestoreIdentifierKey: Self.restoreIdentifier,
            ]
        )
        centralManager = manager
        return manager
    }

    private func performFind(
        manager: CBCentralManager,
        completion: @escaping ([String: Any?]?) -> Void
    ) {
        NSLog("[WhoopBLE] performFind: checking already-connected peripherals")
        for serviceUUID in WhoopBleConstants.allServiceUUIDs {
            let connected = manager.retrieveConnectedPeripherals(withServices: [serviceUUID])
            if let peripheral = connected.first {
                NSLog("[WhoopBLE] performFind: found connected peripheral %@ (%@)",
                      peripheral.identifier.uuidString, peripheral.name ?? "unnamed")
                completion([
                    "id": peripheral.identifier.uuidString,
                    "name": peripheral.name,
                ])
                return
            }
        }

        NSLog("[WhoopBLE] performFind: no connected peripheral found, scanning for 5s")
        findCompletion = completion
        state = .scanning
        manager.scanForPeripherals(
            withServices: WhoopBleConstants.allServiceUUIDs,
            options: nil
        )

        bleQueue.asyncAfter(deadline: .now() + 5) {
            if self.state == .scanning {
                NSLog("[WhoopBLE] performFind: scan timed out, no WHOOP found")
                manager.stopScan()
                self.state = .idle
                self.findCompletion?(nil)
                self.findCompletion = nil
            }
        }
    }

    private func cleanup() {
        state = .idle
        connectedPeripheral = nil
        cmdCharacteristic = nil
        cmdResponseCharacteristic = nil
        dataCharacteristic = nil
    }
}
