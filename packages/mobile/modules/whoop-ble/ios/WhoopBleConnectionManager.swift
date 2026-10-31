import CoreBluetooth
import Foundation

/// Manages the BLE connection lifecycle: scanning, connecting, service/characteristic
/// discovery, auto-reconnect, and state restoration.
///
/// The connection manager owns all CoreBluetooth state and delegates domain-specific
/// processing (frame parsing, sample buffering) to its delegate via callbacks.
final class WhoopBleConnectionManager {
    weak var delegate: WhoopBleConnectionManagerDelegate?

    private(set) var state: ConnectionState = .idle {
        didSet {
            if state != oldValue {
                recordConnectionEvent("state_transition", previousConnectionState: oldValue.rawValue)
            }
        }
    }
    private(set) var connectedPeripheral: CBPeripheral?
    private(set) var cmdCharacteristic: CBCharacteristic?

    let bleQueue: DispatchQueue
    let bleDelegate: WhoopBleDelegate
    let connectionDiagnostics: WhoopBleConnectionDiagnostics
    private(set) var centralState = "uninitialized"

    static let bleQueueKey = DispatchSpecificKey<Bool>()

    var centralManager: CBCentralManager?
    var cmdResponseCharacteristic: CBCharacteristic?
    var dataCharacteristic: CBCharacteristic?
    var notificationSubscriptionTracker: WhoopBleNotificationSubscriptionTracker?
    var autoReconnect = false
    var wasStreaming = false
    var deviceInfo: [String: String] = [:]

    @discardableResult
    func recordDeviceInformation(uuid: String, data: Data) -> Bool {
        let keys = ["2A24": "model", "2A25": "serial", "2A26": "firmware", "2A27": "hardware"]
        guard let key = keys[uuid.uppercased()] else { return false }
        if let value = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !value.isEmpty, value.count <= 200 { deviceInfo[key] = value }
        return true
    }

    var findCompletion: (([String: Any?]?) -> Void)?
    var connectCompletion: ((Result<Bool, WhoopBleConnectionError>) -> Void)?
    var pendingPoweredOnCompletion: (([String: Any?]?) -> Void)?
    var handshakeTimeoutWorkItem: DispatchWorkItem?
    let connectTimeoutSeconds: TimeInterval
    private var collectionActivityObserver: NSObjectProtocol?

    /// Last write error for diagnostics.
    var lastWriteError: String?

    static let restoreIdentifier = "com.dofek.whoop-ble-central"

    init(
        connectTimeoutSeconds: TimeInterval = 10,
        connectionDiagnostics: WhoopBleConnectionDiagnostics = WhoopBleConnectionDiagnostics()
    ) {
        self.connectionDiagnostics = connectionDiagnostics
        self.connectTimeoutSeconds = connectTimeoutSeconds
        bleQueue = DispatchQueue(label: "com.dofek.whoop-ble", qos: .userInitiated)
        bleQueue.setSpecific(key: Self.bleQueueKey, value: true)
        bleDelegate = WhoopBleDelegate()
        bleDelegate.connectionManager = self
        recordConnectionEvent("native_session_start")
        collectionActivityObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("Dofek.collectionActivityRequested"),
            object: nil,
            queue: nil
        ) { [weak self] notification in
            guard let self, let collectors = notification.object as? NSMutableSet else { return }
            let isCollecting = self.syncOnBleQueue {
                self.state == .ready || self.state == .streaming
            }
            if isCollecting {
                collectors.add("whoop")
            }
        }
    }

    deinit {
        if let collectionActivityObserver {
            NotificationCenter.default.removeObserver(collectionActivityObserver)
        }
    }

    func syncOnBleQueue<T>(_ work: () throws -> T) rethrows -> T {
        if DispatchQueue.getSpecific(key: Self.bleQueueKey) == true {
            return try work()
        }
        return try bleQueue.sync(execute: work)
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
            self.recordConnectionEvent("connect_requested", peripheralId: peripheralId, reason: "explicit_connect")
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
            self.startHandshakeTimeout(for: peripheral)
        }
    }

    // MARK: - Retry

    func retryConnection(completion: @escaping (Bool) -> Void) {
        let manager = ensureCentralManager()

        bleQueue.async {
            self.recordConnectionEvent("retry_requested", reason: "explicit_retry")
            if let peripheral = self.connectedPeripheral,
               peripheral.state == .connected || self.state == .connecting {
                NSLog("[WhoopBLE] retryConnection: existing connection owns recovery")
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
                    self.recordConnectionEvent("connect_requested", reason: "retry_connected_peripheral")
                    manager.connect(peripheral, options: nil)
                    self.startHandshakeTimeout(for: peripheral)
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

    func disconnect(completion: (() -> Void)? = nil) {
        bleQueue.async {
            self.recordConnectionEvent("disconnect_requested", reason: "intentional_disconnect")
            self.autoReconnect = false
            self.wasStreaming = false
            if let peripheral = self.connectedPeripheral {
                self.centralManager?.cancelPeripheralConnection(peripheral)
            }
            self.cleanup()
            self.finishConnect(.failure(.disconnected(nil)))
            WhoopBleConnectionEvent.intentionallyDisconnected.post()
            completion?()
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

    /// Cancel pending streaming restoration and transition from `.streaming` to `.ready`.
    func stopStreaming() {
        wasStreaming = false
        if state == .streaming {
            state = .ready
        }
    }

    // MARK: - Internal state mutation

    func recordConnectionEvent(
        _ event: String,
        peripheralId: String? = nil,
        error: Error? = nil,
        reason: String? = nil,
        previousConnectionState: String? = nil,
        restoredPeripheralCount: Int? = nil
    ) {
        connectionDiagnostics.record(
            event: event, connectionState: state.rawValue, centralState: centralState,
            reconnectIntent: autoReconnect,
            peripheralId: peripheralId ?? connectedPeripheral?.identifier.uuidString,
            error: error, reason: reason, previousConnectionState: previousConnectionState,
            restoredPeripheralCount: restoredPeripheralCount
        )
    }

    func handleCentralManagerStateUpdated(_ updatedState: CBManagerState) {
        switch updatedState {
        case .unknown: centralState = "unknown"
        case .resetting: centralState = "resetting"
        case .unsupported: centralState = "unsupported"
        case .unauthorized: centralState = "unauthorized"
        case .poweredOff: centralState = "poweredOff"
        case .poweredOn: centralState = "poweredOn"
        @unknown default: centralState = "unknown"
        }
        recordConnectionEvent("central_state")
        if updatedState == .poweredOn {
            handleCentralManagerPoweredOn()
        }
    }

    func handleRestoration(_ peripherals: [CBPeripheral]) {
        recordConnectionEvent("restoration", peripheralId: peripherals.first?.identifier.uuidString,
                              restoredPeripheralCount: peripherals.count)
        guard let peripheral = peripherals.first else { return }
        peripheral.delegate = bleDelegate
        handleRestoredPeripheral(peripheral)
    }

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
        notificationSubscriptionTracker = nil
        deviceInfo = [:]
    }

    /// Applies the asynchronous notification-subscription result to the
    /// connection handshake. A non-nil return means every requested
    /// characteristic is notifying and contains the previous streaming intent.
    func settleNotificationSubscriptionUpdate(
        _ update: WhoopBleNotificationSubscriptionTracker.UpdateResult,
        failureDetail: String,
        underlyingError: Error? = nil,
        cancelPeripheral: () -> Void
    ) -> Bool? {
        guard state == .subscribing else { return nil }

        switch update {
        case .ignored, .waiting:
            return nil
        case .failed:
            abortHandshake(
                with: .notificationSubscriptionFailed(failureDetail),
                underlyingError: underlyingError,
                cancelPeripheral: cancelPeripheral
            )
            return nil
        case .ready:
            notificationSubscriptionTracker = nil
            setState(.ready)
            let previouslyStreaming = wasStreaming
            wasStreaming = false
            WhoopBleConnectionEvent.connected.post()
            finishConnect(.success(true))
            return previouslyStreaming
        }
    }
}
