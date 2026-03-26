import CoreBluetooth
import ExpoModulesCore

/// Connection state machine for the WHOOP BLE module.
private enum ConnectionState: String {
    case idle
    case scanning
    case connecting
    case discoveringServices
    case ready
    case streaming
}

/// Expo native module that connects to a WHOOP strap via CoreBluetooth
/// and streams raw IMU (accelerometer + gyroscope) data.
///
/// The WHOOP strap can be connected to the WHOOP app simultaneously —
/// iOS allows multiple apps to connect to the same BLE peripheral.
/// We use `retrieveConnectedPeripherals(withServices:)` to find the
/// already-connected strap.
public class WhoopBleModule: Module {

    /// Restore identifier for CoreBluetooth state restoration.
    /// When the app is relaunched by iOS after being killed, the system
    /// restores the CBCentralManager with any active connections.
    private static let restoreIdentifier = "com.dofek.whoop-ble-central"

    private var centralManager: CBCentralManager?
    private let bleQueue = DispatchQueue(label: "com.dofek.whoop-ble", qos: .userInitiated)
    private let delegate = BleDelegate()

    private var connectedPeripheral: CBPeripheral?
    private var cmdCharacteristic: CBCharacteristic?
    private var dataCharacteristic: CBCharacteristic?
    private var state: ConnectionState = .idle

    /// Whether to automatically reconnect on disconnect (for always-on mode)
    private var autoReconnect = false
    /// Whether streaming was active before a disconnect (to resume after reconnect)
    private var wasStreaming = false

    private let frameParser = WhoopBleFrameParser()
    private var sampleBuffer: [WhoopImuSample] = []
    private let bufferLock = NSLock()
    private static let maxBufferSize = 500_000 // ~100 minutes at 80 Hz

    // Pending promises for async operations
    private var findPromise: Promise?
    private var connectPromise: Promise?
    private var startStreamingPromise: Promise?

    public func definition() -> ModuleDefinition {
        Name("WhoopBle")

        Events("onConnectionStateChanged")

        OnCreate {
            self.delegate.module = self
            self.centralManager = CBCentralManager(
                delegate: self.delegate,
                queue: self.bleQueue,
                options: [
                    CBCentralManagerOptionShowPowerAlertKey: false,
                    // Enable state restoration so iOS relaunches the app
                    // and restores active BLE connections after the app is killed.
                    // This allows background IMU streaming to survive app termination.
                    CBCentralManagerOptionRestoreIdentifierKey: WhoopBleModule.restoreIdentifier,
                ]
            )
        }

        // MARK: - Availability

        Function("isBluetoothAvailable") { () -> Bool in
            return self.centralManager?.state == .poweredOn
        }

        // MARK: - Discovery

        AsyncFunction("findWhoop") { (promise: Promise) in
            guard self.centralManager?.state == .poweredOn else {
                promise.resolve(nil)
                return
            }

            self.bleQueue.async {
                // First, check for already-connected peripherals (fast path)
                for serviceUUID in WhoopBleConstants.allServiceUUIDs {
                    let connected = self.centralManager?.retrieveConnectedPeripherals(
                        withServices: [serviceUUID]
                    ) ?? []
                    if let peripheral = connected.first {
                        let result: [String: Any?] = [
                            "id": peripheral.identifier.uuidString,
                            "name": peripheral.name,
                        ]
                        promise.resolve(result)
                        return
                    }
                }

                // Fallback: scan for 5 seconds
                self.findPromise = promise
                self.state = .scanning
                self.centralManager?.scanForPeripherals(
                    withServices: WhoopBleConstants.allServiceUUIDs,
                    options: nil
                )

                // Timeout after 5 seconds
                self.bleQueue.asyncAfter(deadline: .now() + 5) {
                    if self.state == .scanning {
                        self.centralManager?.stopScan()
                        self.state = .idle
                        self.findPromise?.resolve(nil)
                        self.findPromise = nil
                    }
                }
            }
        }

        // MARK: - Connection

        AsyncFunction("connect") { (peripheralId: String, promise: Promise) in
            self.bleQueue.async {
                guard let centralManager = self.centralManager,
                      let uuid = UUID(uuidString: peripheralId) else {
                    promise.reject("INVALID_ID", "Invalid peripheral ID: \(peripheralId)")
                    return
                }

                let peripherals = centralManager.retrievePeripherals(withIdentifiers: [uuid])
                guard let peripheral = peripherals.first else {
                    promise.reject("NOT_FOUND", "Peripheral not found: \(peripheralId)")
                    return
                }

                self.connectedPeripheral = peripheral
                peripheral.delegate = self.delegate
                self.connectPromise = promise
                self.state = .connecting
                self.autoReconnect = true
                centralManager.connect(peripheral, options: nil)

                // Timeout after 10 seconds
                self.bleQueue.asyncAfter(deadline: .now() + 10) {
                    if self.state == .connecting {
                        self.state = .idle
                        centralManager.cancelPeripheralConnection(peripheral)
                        self.connectPromise?.reject("TIMEOUT", "Connection timed out")
                        self.connectPromise = nil
                    }
                }
            }
        }

        // MARK: - IMU streaming

        AsyncFunction("startImuStreaming") { (promise: Promise) in
            self.bleQueue.async {
                guard self.state == .ready,
                      let peripheral = self.connectedPeripheral,
                      let cmdChar = self.cmdCharacteristic else {
                    promise.reject("NOT_READY", "Not connected or service not discovered")
                    return
                }

                // Send TOGGLE_IMU_MODE command
                let commandData = WhoopBleFrameParser.buildCommandData(
                    command: WhoopBleConstants.commandToggleImuMode
                )
                peripheral.writeValue(commandData, for: cmdChar, type: .withResponse)

                self.state = .streaming
                self.frameParser.reset()

                self.bufferLock.lock()
                self.sampleBuffer.removeAll()
                self.bufferLock.unlock()

                promise.resolve(true)
            }
        }

        AsyncFunction("stopImuStreaming") { (promise: Promise) in
            self.bleQueue.async {
                guard let peripheral = self.connectedPeripheral,
                      let cmdChar = self.cmdCharacteristic else {
                    promise.resolve(true)
                    return
                }

                // Send STOP_RAW_DATA command
                let commandData = WhoopBleFrameParser.buildCommandData(
                    command: WhoopBleConstants.commandStopRawData
                )
                peripheral.writeValue(commandData, for: cmdChar, type: .withResponse)

                if self.state == .streaming {
                    self.state = .ready
                }

                promise.resolve(true)
            }
        }

        // MARK: - Buffer access

        AsyncFunction("getBufferedSamples") { (promise: Promise) in
            self.bufferLock.lock()
            let samples = self.sampleBuffer
            self.sampleBuffer.removeAll()
            self.bufferLock.unlock()

            let result = samples.map { sample -> [String: Any] in
                // Convert strap timestamp to ISO 8601
                let date = Date(timeIntervalSince1970: TimeInterval(sample.timestampSeconds))
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

                return [
                    "timestamp": formatter.string(from: date),
                    "accelerometerX": Int(sample.accelerometerX),
                    "accelerometerY": Int(sample.accelerometerY),
                    "accelerometerZ": Int(sample.accelerometerZ),
                    "gyroscopeX": Int(sample.gyroscopeX),
                    "gyroscopeY": Int(sample.gyroscopeY),
                    "gyroscopeZ": Int(sample.gyroscopeZ),
                ]
            }

            promise.resolve(result)
        }

        // MARK: - Disconnect

        Function("disconnect") {
            self.bleQueue.async {
                self.autoReconnect = false
                if let peripheral = self.connectedPeripheral {
                    self.centralManager?.cancelPeripheralConnection(peripheral)
                }
                self.cleanup()
            }
        }
    }

    // MARK: - Internal handlers (called by delegate)

    func handleCentralManagerPoweredOn() {
        // If we have a restored peripheral waiting to reconnect, start service discovery
        if let peripheral = connectedPeripheral, state == .idle {
            state = .discoveringServices
            peripheral.discoverServices(WhoopBleConstants.allServiceUUIDs)
        }
    }

    /// Called during state restoration when iOS relaunches the app with
    /// a previously-connected peripheral. Re-establishes our reference
    /// so that when Bluetooth powers on, we can resume service discovery.
    func handleRestoredPeripheral(_ peripheral: CBPeripheral) {
        connectedPeripheral = peripheral
        peripheral.delegate = delegate
        autoReconnect = true
        wasStreaming = true // Assume we were streaming before the app was killed

        // If the peripheral is already connected, start discovery immediately
        if peripheral.state == .connected {
            state = .discoveringServices
            peripheral.discoverServices(WhoopBleConstants.allServiceUUIDs)
        }
        // Otherwise, wait for centralManagerDidUpdateState → poweredOn
    }

    func handlePeripheralDiscovered(_ peripheral: CBPeripheral) {
        guard state == .scanning else { return }

        centralManager?.stopScan()
        state = .idle

        let result: [String: Any?] = [
            "id": peripheral.identifier.uuidString,
            "name": peripheral.name,
        ]
        findPromise?.resolve(result)
        findPromise = nil
    }

    func handlePeripheralConnected(_ peripheral: CBPeripheral) {
        guard state == .connecting else { return }

        state = .discoveringServices
        peripheral.discoverServices(WhoopBleConstants.allServiceUUIDs)
    }

    func handlePeripheralDisconnected(_ peripheral: CBPeripheral, error: Error?) {
        wasStreaming = state == .streaming
        let shouldReconnect = autoReconnect

        cleanup()

        sendEvent("onConnectionStateChanged", [
            "state": "disconnected",
            "peripheralId": peripheral.identifier.uuidString,
            "error": error?.localizedDescription as Any,
        ])

        // Reject any pending promises
        connectPromise?.reject("DISCONNECTED", error?.localizedDescription ?? "Disconnected")
        connectPromise = nil

        // Auto-reconnect after unexpected disconnect (BLE link loss, strap out of range, etc.)
        // The strap may come back in range, or iOS may have suspended the connection temporarily.
        if shouldReconnect {
            autoReconnect = true
            state = .connecting
            connectedPeripheral = peripheral
            peripheral.delegate = delegate
            centralManager?.connect(peripheral, options: nil)
        }
    }

    func handleServicesDiscovered(_ peripheral: CBPeripheral) {
        guard state == .discoveringServices else { return }

        // Find the WHOOP service
        guard let service = peripheral.services?.first(where: { service in
            WhoopBleConstants.allServiceUUIDs.contains(service.uuid)
        }) else {
            connectPromise?.reject("NO_SERVICE", "WHOOP service not found")
            connectPromise = nil
            state = .idle
            return
        }

        // Discover characteristics
        let cmdUUID = WhoopBleConstants.cmdToStrapUUID(forService: service.uuid)
        let dataUUID = WhoopBleConstants.dataFromStrapUUID(forService: service.uuid)
        peripheral.discoverCharacteristics([cmdUUID, dataUUID], for: service)
    }

    func handleCharacteristicsDiscovered(_ peripheral: CBPeripheral, service: CBService) {
        guard state == .discoveringServices else { return }

        let cmdUUID = WhoopBleConstants.cmdToStrapUUID(forService: service.uuid)
        let dataUUID = WhoopBleConstants.dataFromStrapUUID(forService: service.uuid)

        cmdCharacteristic = service.characteristics?.first { $0.uuid == cmdUUID }
        dataCharacteristic = service.characteristics?.first { $0.uuid == dataUUID }

        guard let cmdChar = cmdCharacteristic, let dataChar = dataCharacteristic else {
            connectPromise?.reject("NO_CHARACTERISTICS", "Required characteristics not found")
            connectPromise = nil
            state = .idle
            return
        }

        // Subscribe to DATA_FROM_STRAP notifications
        peripheral.setNotifyValue(true, for: dataChar)

        state = .ready
        connectPromise?.resolve(true)
        connectPromise = nil

        sendEvent("onConnectionStateChanged", [
            "state": "connected",
            "peripheralId": peripheral.identifier.uuidString,
        ])

        // Auto-resume IMU streaming after reconnect (e.g., strap came back in range)
        if wasStreaming {
            wasStreaming = false
            let commandData = WhoopBleFrameParser.buildCommandData(
                command: WhoopBleConstants.commandToggleImuMode
            )
            peripheral.writeValue(commandData, for: cmdChar, type: .withResponse)
            state = .streaming
            frameParser.reset()
        }
    }

    func handleDataReceived(_ data: Data) {
        guard state == .streaming else { return }

        let frames = frameParser.feed(data)

        var newSamples: [WhoopImuSample] = []
        for frame in frames {
            let samples = WhoopBleFrameParser.extractImuSamples(from: frame)
            newSamples.append(contentsOf: samples)
        }

        guard !newSamples.isEmpty else { return }

        bufferLock.lock()
        sampleBuffer.append(contentsOf: newSamples)
        // Cap buffer size to prevent memory issues
        if sampleBuffer.count > WhoopBleModule.maxBufferSize {
            sampleBuffer.removeFirst(sampleBuffer.count - WhoopBleModule.maxBufferSize)
        }
        bufferLock.unlock()
    }

    private func cleanup() {
        state = .idle
        connectedPeripheral = nil
        cmdCharacteristic = nil
        dataCharacteristic = nil
        frameParser.reset()
    }
}

// MARK: - BLE Delegate

/// Delegate holder to avoid module retain cycles.
/// CBCentralManager and CBPeripheral both require ObjC-compatible delegates.
private class BleDelegate: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    weak var module: WhoopBleModule?

    // MARK: CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn {
            module?.handleCentralManagerPoweredOn()
        }
    }

    /// Called by iOS when the app is relaunched to restore BLE state.
    /// Re-establishes references to peripherals that were connected before the app was killed.
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        guard let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral],
              let peripheral = peripherals.first else {
            return
        }

        // Re-establish the peripheral reference and delegate
        peripheral.delegate = self
        module?.handleRestoredPeripheral(peripheral)
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        module?.handlePeripheralDiscovered(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        module?.handlePeripheralConnected(peripheral)
    }

    func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        module?.handlePeripheralDisconnected(peripheral, error: error)
    }

    func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        module?.handlePeripheralDisconnected(peripheral, error: error)
    }

    // MARK: CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil else { return }
        module?.handleServicesDiscovered(peripheral)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        guard error == nil else { return }
        module?.handleCharacteristicsDiscovered(peripheral, service: service)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard error == nil, let data = characteristic.value else { return }
        module?.handleDataReceived(data)
    }
}
