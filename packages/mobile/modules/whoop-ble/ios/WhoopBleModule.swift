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

    /// Pending promise waiting for CBCentralManager to reach .poweredOn state.
    /// Only one findWhoop call can be pending at a time.
    private var pendingFindPromise: Promise?

    // Pending promises for async operations
    private var findPromise: Promise?
    private var connectPromise: Promise?
    private var startStreamingPromise: Promise?

    public func definition() -> ModuleDefinition {
        Name("WhoopBle")

        Events("onConnectionStateChanged")

        OnCreate {
            self.delegate.module = self
            // Defer CBCentralManager creation to first use via ensureCentralManager().
            // Creating it eagerly in OnCreate caused launch crashes when the
            // NSBluetoothAlwaysUsageDescription key was missing from Info.plist,
            // because iOS throws an NSException on the background dispatch queue.
        }

        // MARK: - Availability

        Function("isBluetoothAvailable") { () -> Bool in
            let manager = self.ensureCentralManager()
            let available = manager.state == .poweredOn
            NSLog("[WhoopBLE] isBluetoothAvailable: %@ (state=%ld)", available ? "true" : "false", manager.state.rawValue)
            return available
        }

        // MARK: - Discovery

        AsyncFunction("findWhoop") { (promise: Promise) in
            let manager = self.ensureCentralManager()

            // If the manager is already powered on, search immediately.
            // Otherwise, wait up to 3 seconds for it to reach .poweredOn.
            // This handles the first-call race: CBCentralManager starts in
            // .unknown state and transitions to .poweredOn asynchronously
            // via the delegate callback. The original guard returned nil
            // immediately, which always aborted the first findWhoop() call.
            self.bleQueue.async {
                if manager.state == .poweredOn {
                    NSLog("[WhoopBLE] findWhoop: Bluetooth poweredOn, searching immediately")
                    self.performFindWhoop(manager: manager, promise: promise)
                } else {
                    NSLog("[WhoopBLE] findWhoop: Bluetooth not ready (state=%ld), waiting for poweredOn", manager.state.rawValue)
                    self.pendingFindPromise = promise
                    // Timeout — don't wait forever for Bluetooth
                    self.bleQueue.asyncAfter(deadline: .now() + 3) {
                        guard let pending = self.pendingFindPromise else { return }
                        NSLog("[WhoopBLE] findWhoop: timed out waiting for poweredOn (state=%ld)", manager.state.rawValue)
                        self.pendingFindPromise = nil
                        pending.resolve(nil)
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
                    NSLog("[WhoopBLE] startImuStreaming: NOT_READY (state=%@, peripheral=%@, cmdChar=%@)", self.state.rawValue, self.connectedPeripheral == nil ? "nil" : "set", self.cmdCharacteristic == nil ? "nil" : "set")
                    promise.reject("NOT_READY", "Not connected or service not discovered")
                    return
                }

                NSLog("[WhoopBLE] startImuStreaming: sending TOGGLE_IMU_MODE command")
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

                NSLog("[WhoopBLE] startImuStreaming: now streaming, buffer cleared")
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

        // MARK: - Diagnostics

        Function("getConnectionState") { () -> String in
            return self.state.rawValue
        }

        Function("getBluetoothState") { () -> String in
            guard let manager = self.centralManager else {
                return "uninitialized"
            }
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

        Function("getBufferedSampleCount") { () -> Int in
            self.bufferLock.lock()
            let count = self.sampleBuffer.count
            self.bufferLock.unlock()
            return count
        }

        // MARK: - Buffer access

        AsyncFunction("getBufferedSamples") { (promise: Promise) in
            self.bufferLock.lock()
            let samples = self.sampleBuffer
            self.sampleBuffer.removeAll()
            self.bufferLock.unlock()

            NSLog("[WhoopBLE] getBufferedSamples: draining %d samples from buffer", samples.count)

            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let samplingInterval = 1.0 / 50.0 // 50 Hz = 20ms per sample

            let result = samples.map { sample -> [String: Any] in
                // Compute per-sample timestamp: base epoch + sub-second offset + sample position
                let baseTime = TimeInterval(sample.timestampSeconds)
                    + TimeInterval(sample.subSeconds) / 1000.0
                let sampleTime = baseTime + Double(sample.sampleIndex) * samplingInterval
                let date = Date(timeIntervalSince1970: sampleTime)

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
        NSLog("[WhoopBLE] centralManager poweredOn")

        // Resolve any pending findWhoop call that was waiting for .poweredOn
        if let pending = pendingFindPromise, let manager = centralManager {
            NSLog("[WhoopBLE] resolving pending findWhoop after poweredOn")
            pendingFindPromise = nil
            performFindWhoop(manager: manager, promise: pending)
        }

        // If we have a restored peripheral waiting to reconnect
        if let peripheral = connectedPeripheral, state == .idle {
            if peripheral.state == .connected {
                // Already connected — proceed to service discovery
                state = .discoveringServices
                peripheral.discoverServices(WhoopBleConstants.allServiceUUIDs)
            } else {
                // Peripheral was disconnected while the app was suspended/killed —
                // initiate a new connection instead of trying to discover services
                // on a disconnected peripheral (which silently fails).
                state = .connecting
                centralManager?.connect(peripheral, options: nil)
            }
        }
    }

    /// Perform the actual WHOOP strap search (called after manager is .poweredOn).
    private func performFindWhoop(manager: CBCentralManager, promise: Promise) {
        NSLog("[WhoopBLE] performFindWhoop: checking already-connected peripherals")
        // First, check for already-connected peripherals (fast path)
        for serviceUUID in WhoopBleConstants.allServiceUUIDs {
            let connected = manager.retrieveConnectedPeripherals(
                withServices: [serviceUUID]
            )
            if let peripheral = connected.first {
                NSLog("[WhoopBLE] performFindWhoop: found connected peripheral %@ (%@)", peripheral.identifier.uuidString, peripheral.name ?? "unnamed")
                let result: [String: Any?] = [
                    "id": peripheral.identifier.uuidString,
                    "name": peripheral.name,
                ]
                promise.resolve(result)
                return
            }
        }

        // Fallback: scan for 5 seconds
        NSLog("[WhoopBLE] performFindWhoop: no connected peripheral found, scanning for 5s")
        self.findPromise = promise
        self.state = .scanning
        manager.scanForPeripherals(
            withServices: WhoopBleConstants.allServiceUUIDs,
            options: nil
        )

        // Timeout after 5 seconds
        self.bleQueue.asyncAfter(deadline: .now() + 5) {
            if self.state == .scanning {
                NSLog("[WhoopBLE] performFindWhoop: scan timed out, no WHOOP found")
                manager.stopScan()
                self.state = .idle
                self.findPromise?.resolve(nil)
                self.findPromise = nil
            }
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
        NSLog("[WhoopBLE] peripheral connected: %@ (state=%@)", peripheral.identifier.uuidString, state.rawValue)
        guard state == .connecting else { return }

        state = .discoveringServices
        peripheral.discoverServices(WhoopBleConstants.allServiceUUIDs)
    }

    func handlePeripheralDisconnected(_ peripheral: CBPeripheral, error: Error?) {
        NSLog("[WhoopBLE] peripheral disconnected: %@ (wasState=%@, error=%@, autoReconnect=%@)", peripheral.identifier.uuidString, state.rawValue, error?.localizedDescription ?? "none", autoReconnect ? "true" : "false")
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
        let serviceUUIDs = peripheral.services?.map { $0.uuid.uuidString } ?? []
        NSLog("[WhoopBLE] services discovered: %@", serviceUUIDs.joined(separator: ", "))
        guard state == .discoveringServices else { return }

        // Find the WHOOP service
        guard let service = peripheral.services?.first(where: { service in
            WhoopBleConstants.allServiceUUIDs.contains(service.uuid)
        }) else {
            NSLog("[WhoopBLE] NO WHOOP service found among discovered services")
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
        let charUUIDs = service.characteristics?.map { $0.uuid.uuidString } ?? []
        NSLog("[WhoopBLE] characteristics discovered for service %@: %@", service.uuid.uuidString, charUUIDs.joined(separator: ", "))
        guard state == .discoveringServices else { return }

        let cmdUUID = WhoopBleConstants.cmdToStrapUUID(forService: service.uuid)
        let dataUUID = WhoopBleConstants.dataFromStrapUUID(forService: service.uuid)

        cmdCharacteristic = service.characteristics?.first { $0.uuid == cmdUUID }
        dataCharacteristic = service.characteristics?.first { $0.uuid == dataUUID }

        guard let cmdChar = cmdCharacteristic, let dataChar = dataCharacteristic else {
            NSLog("[WhoopBLE] missing characteristics: cmd=%@, data=%@", cmdCharacteristic == nil ? "MISSING" : "found", dataCharacteristic == nil ? "MISSING" : "found")
            connectPromise?.reject("NO_CHARACTERISTICS", "Required characteristics not found")
            connectPromise = nil
            state = .idle
            return
        }

        // Subscribe to DATA_FROM_STRAP notifications
        NSLog("[WhoopBLE] subscribing to DATA_FROM_STRAP notifications")
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

    /// Counter to throttle data-path logs (avoid flooding at 80 Hz)
    private var dataReceivedCount: UInt64 = 0
    private var totalFramesParsed: UInt64 = 0
    private var totalSamplesExtracted: UInt64 = 0
    private var droppedForNonStreaming: UInt64 = 0
    private var emptyExtractions: UInt64 = 0
    private var bufferOverflows: UInt64 = 0

    func handleDataReceived(_ data: Data) {
        dataReceivedCount += 1

        guard state == .streaming else {
            droppedForNonStreaming += 1
            if droppedForNonStreaming == 1 || droppedForNonStreaming % 100 == 0 {
                NSLog("[WhoopBLE] handleDataReceived: dropped %llu notifications (state=%@, not streaming)", droppedForNonStreaming, state.rawValue)
            }
            return
        }

        let frames = frameParser.feed(data)
        totalFramesParsed += UInt64(frames.count)

        var newSamples: [WhoopImuSample] = []
        for frame in frames {
            let samples = WhoopBleFrameParser.extractImuSamples(from: frame)
            newSamples.append(contentsOf: samples)
        }

        if newSamples.isEmpty {
            emptyExtractions += 1
            if emptyExtractions == 1 || emptyExtractions % 100 == 0 {
                NSLog("[WhoopBLE] handleDataReceived: %llu empty extractions so far (notifications=%llu, frames=%llu, bytes=%d)", emptyExtractions, dataReceivedCount, totalFramesParsed, data.count)
            }
            return
        }

        totalSamplesExtracted += UInt64(newSamples.count)

        bufferLock.lock()
        sampleBuffer.append(contentsOf: newSamples)
        // Cap buffer size to prevent memory issues
        if sampleBuffer.count > WhoopBleModule.maxBufferSize {
            let overflow = sampleBuffer.count - WhoopBleModule.maxBufferSize
            sampleBuffer.removeFirst(overflow)
            bufferOverflows += 1
            NSLog("[WhoopBLE] buffer overflow: dropped %d oldest samples (overflow #%llu)", overflow, bufferOverflows)
        }
        let bufferSize = sampleBuffer.count
        bufferLock.unlock()

        // Log stats every 500 notifications (~6s at 80Hz) to avoid flooding
        if dataReceivedCount % 500 == 0 {
            NSLog("[WhoopBLE] stats: notifications=%llu frames=%llu samples=%llu buffer=%d emptyExtractions=%llu", dataReceivedCount, totalFramesParsed, totalSamplesExtracted, bufferSize, emptyExtractions)
        }
    }

    /// Lazily create the CBCentralManager on first use instead of at module init.
    /// This avoids a launch crash if the NSBluetoothAlwaysUsageDescription key
    /// is missing or if Bluetooth is restricted by MDM.
    private func ensureCentralManager() -> CBCentralManager {
        if let existing = centralManager {
            return existing
        }
        let manager = CBCentralManager(
            delegate: delegate,
            queue: bleQueue,
            options: [
                CBCentralManagerOptionShowPowerAlertKey: false,
                CBCentralManagerOptionRestoreIdentifierKey: WhoopBleModule.restoreIdentifier,
            ]
        )
        centralManager = manager
        return manager
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
        if let error = error {
            NSLog("[WhoopBLE] service discovery error: %@", error.localizedDescription)
            return
        }
        module?.handleServicesDiscovered(peripheral)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        if let error = error {
            NSLog("[WhoopBLE] characteristic discovery error: %@", error.localizedDescription)
            return
        }
        module?.handleCharacteristicsDiscovered(peripheral, service: service)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        if let error = error {
            NSLog("[WhoopBLE] data notification error: %@", error.localizedDescription)
            return
        }
        guard let data = characteristic.value else {
            NSLog("[WhoopBLE] data notification with nil value")
            return
        }
        module?.handleDataReceived(data)
    }
}
