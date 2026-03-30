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
    private var cmdResponseCharacteristic: CBCharacteristic?
    private var dataCharacteristic: CBCharacteristic?
    private var state: ConnectionState = .idle

    /// Whether to automatically reconnect on disconnect (for always-on mode)
    private var autoReconnect = false
    /// Whether streaming was active before a disconnect (to resume after reconnect)
    private var wasStreaming = false

    private let frameParser = WhoopBleFrameParser()
    /// Separate parser for CMD_FROM_STRAP — sharing the data parser's
    /// accumulator with command responses corrupts R21 frame reassembly.
    private let cmdFrameParser = WhoopBleFrameParser()
    private var sampleBuffer: [WhoopImuSample] = []
    private var realtimeDataBuffer: [WhoopRealtimeDataSample] = []
    private let bufferLock = NSLock()
    private static let maxBufferSize = 500_000 // ~100 minutes at 80 Hz
    private static let maxRealtimeDataBufferSize = 86_400 // 24 hours at 1 Hz

    /// Madgwick AHRS filter for real-time orientation estimation
    private let orientationFilter = MadgwickFilter(sampleRate: 100, beta: 0.1)
    /// Throttle orientation events to ~30 Hz (emit every 3rd sample at 100 Hz input)
    private var orientationSampleCounter: Int = 0
    private static let orientationEmitInterval = 3

    /// Pending promise waiting for CBCentralManager to reach .poweredOn state.
    /// Only one findWhoop call can be pending at a time.
    private var pendingFindPromise: Promise?

    // Pending promises for async operations
    private var findPromise: Promise?
    private var connectPromise: Promise?
    private var startStreamingPromise: Promise?

    public func definition() -> ModuleDefinition {
        Name("WhoopBle")

        Events("onConnectionStateChanged", "onOrientation")

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
            return manager.state == .poweredOn
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
                // Already streaming (e.g., auto-resumed after state restoration) — success
                if self.state == .streaming {
                    NSLog("[WhoopBLE] startImuStreaming: already streaming, returning success")
                    promise.resolve(true)
                    return
                }

                guard self.state == .ready,
                      let peripheral = self.connectedPeripheral,
                      let cmdChar = self.cmdCharacteristic else {
                    let detail = "state=\(self.state.rawValue) peripheral=\(self.connectedPeripheral == nil ? "nil" : "set") cmdChar=\(self.cmdCharacteristic == nil ? "nil" : "set") dataChar=\(self.dataCharacteristic == nil ? "nil" : "set")"
                    NSLog("[WhoopBLE] startImuStreaming: NOT_READY (%@)", detail)
                    promise.reject("NOT_READY", "Not ready: \(detail)")
                    return
                }

                // Send TOGGLE_IMU_MODE — capture analysis shows the WHOOP app
                // sends this directly without a GET_HELLO handshake first.
                let commandData = WhoopBleFrameParser.buildCommandData(
                    command: WhoopBleConstants.commandToggleImuMode
                )
                NSLog("[WhoopBLE] startImuStreaming: sending TOGGLE_IMU_MODE (0x6A)")
                peripheral.writeValue(commandData, for: cmdChar, type: .withResponse)

                self.state = .streaming
                self.frameParser.reset()
                self.cmdFrameParser.reset()
                self.orientationFilter.reset()
                self.orientationSampleCounter = 0

                self.bufferLock.lock()
                self.sampleBuffer.removeAll()
                self.realtimeDataBuffer.removeAll()
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

        Function("getDataPathStats") { () -> [String: Any] in
            // Read diagnostic counters on bleQueue to avoid data races —
            // counters are written from BLE delegate callbacks on bleQueue.
            return self.bleQueue.sync {
                let packetTypeSummary = self.packetTypeCounts
                    .sorted(by: { $0.key < $1.key })
                    .map { String(format: "0x%02X:%llu", $0.key, $0.value) }
                    .joined(separator: ", ")

                return [
                    "dataNotificationCount": Int(self.dataNotificationCount),
                    "cmdNotificationCount": Int(self.cmdNotificationCount),
                    "totalFramesParsed": Int(self.totalFramesParsed),
                    "totalSamplesExtracted": Int(self.totalSamplesExtracted),
                    "droppedForNonStreaming": Int(self.droppedForNonStreaming),
                    "emptyExtractions": Int(self.emptyExtractions),
                    "bufferOverflows": Int(self.bufferOverflows),
                    "packetTypes": packetTypeSummary,
                    "lastCommandResponse": self.lastCommandResponse,
                    "connectionState": self.state.rawValue,
                    "hasDataCharacteristic": self.dataCharacteristic != nil,
                    "isNotifying": self.dataCharacteristic?.isNotifying ?? false,
                    "hasCmdCharacteristic": self.cmdCharacteristic != nil,
                    "hasCmdResponseCharacteristic": self.cmdResponseCharacteristic != nil,
                    "lastWriteError": self.lastWriteError ?? "none",
                ]
            }
        }

        // MARK: - Realtime HR command

        /// Send TOGGLE_REALTIME_HR (0x03) to enable continuous 1 Hz HR streaming
        /// beyond the normal sync window. Best-effort — may be rejected if the
        /// strap doesn't accept commands from our connection.
        AsyncFunction("startRealtimeHr") { (promise: Promise) in
            self.bleQueue.async {
                guard let peripheral = self.connectedPeripheral,
                      let cmdChar = self.cmdCharacteristic else {
                    promise.resolve(false)
                    return
                }

                let commandData = WhoopBleFrameParser.buildCommandData(
                    command: WhoopBleConstants.commandToggleRealtimeHr
                )
                NSLog("[WhoopBLE] sending TOGGLE_REALTIME_HR (0x03)")
                peripheral.writeValue(commandData, for: cmdChar, type: .withResponse)
                promise.resolve(true)
            }
        }

        /// Send TOGGLE_OPTICAL_MODE (0x6C) to enable raw optical/PPG data streaming.
        /// Best-effort — format of optical data in 0x28 packets is partially understood.
        AsyncFunction("startOpticalMode") { (promise: Promise) in
            self.bleQueue.async {
                guard let peripheral = self.connectedPeripheral,
                      let cmdChar = self.cmdCharacteristic else {
                    promise.resolve(false)
                    return
                }

                let commandData = WhoopBleFrameParser.buildCommandData(
                    command: WhoopBleConstants.commandToggleOpticalMode
                )
                NSLog("[WhoopBLE] sending TOGGLE_OPTICAL_MODE (0x6C)")
                peripheral.writeValue(commandData, for: cmdChar, type: .withResponse)
                promise.resolve(true)
            }
        }

        // MARK: - Buffer access

        /// Drain up to `maxCount` realtime data samples from the buffer (default 1000).
        /// Returns HR and quaternion for each sample.
        AsyncFunction("getBufferedRealtimeData") { (maxCount: Int?, promise: Promise) in
            let limit = maxCount ?? 1000

            self.bufferLock.lock()
            let drainCount = min(limit, self.realtimeDataBuffer.count)
            let samples = Array(self.realtimeDataBuffer.prefix(drainCount))
            self.realtimeDataBuffer.removeFirst(drainCount)
            let remaining = self.realtimeDataBuffer.count
            self.bufferLock.unlock()

            NSLog("[WhoopBLE] getBufferedRealtimeData: draining %d samples (%d remaining)", drainCount, remaining)

            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

            let result = samples.map { sample -> [String: Any] in
                let baseTime = TimeInterval(sample.timestampSeconds)
                    + TimeInterval(sample.subSeconds) / 1000.0
                let date = Date(timeIntervalSince1970: baseTime)

                return [
                    "timestamp": formatter.string(from: date),
                    "heartRate": Int(sample.heartRate),
                    "quaternionW": Double(sample.quaternionW),
                    "quaternionX": Double(sample.quaternionX),
                    "quaternionY": Double(sample.quaternionY),
                    "quaternionZ": Double(sample.quaternionZ),
                ]
            }

            promise.resolve(result)
        }

        /// Drain up to `maxCount` samples from the buffer (default 1000).
        /// Smaller batches avoid memory spikes when serializing across the bridge.
        AsyncFunction("getBufferedSamples") { (maxCount: Int?, promise: Promise) in
            let limit = maxCount ?? 1000

            self.bufferLock.lock()
            let drainCount = min(limit, self.sampleBuffer.count)
            let samples = Array(self.sampleBuffer.prefix(drainCount))
            self.sampleBuffer.removeFirst(drainCount)
            let remaining = self.sampleBuffer.count
            self.bufferLock.unlock()

            NSLog("[WhoopBLE] getBufferedSamples: draining %d samples (%d remaining)", drainCount, remaining)

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

        // MARK: - Background reconnection

        /// Try to reconnect to the WHOOP strap. Checks retrieveConnectedPeripherals
        /// first (instant, finds straps connected by the WHOOP app), then falls back
        /// to a 10-second background scan. Call from background refresh handlers.
        AsyncFunction("retryConnection") { (promise: Promise) in
            let manager = self.ensureCentralManager()

            self.bleQueue.async {
                // Already connected — nothing to do
                if self.connectedPeripheral?.state == .connected {
                    NSLog("[WhoopBLE] retryConnection: already connected")
                    promise.resolve(true)
                    return
                }

                guard manager.state == .poweredOn else {
                    NSLog("[WhoopBLE] retryConnection: Bluetooth not ready")
                    promise.resolve(false)
                    return
                }

                // Check retrieveConnectedPeripherals (instant — finds WHOOP app's connection)
                for serviceUUID in WhoopBleConstants.allServiceUUIDs {
                    let connected = manager.retrieveConnectedPeripherals(withServices: [serviceUUID])
                    if let peripheral = connected.first {
                        NSLog("[WhoopBLE] retryConnection: found connected strap %@, connecting", peripheral.identifier.uuidString)
                        self.connectedPeripheral = peripheral
                        peripheral.delegate = self.delegate
                        self.state = .connecting
                        self.autoReconnect = true
                        manager.connect(peripheral, options: nil)
                        promise.resolve(true)
                        return
                    }
                }

                // Fall back to scan (catches straps advertising nearby)
                NSLog("[WhoopBLE] retryConnection: no connected strap found, scanning 10s")
                self.autoReconnect = true  // enable auto-connect on discovery
                manager.scanForPeripherals(
                    withServices: WhoopBleConstants.allServiceUUIDs,
                    options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
                )

                // Stop scan after 10 seconds
                self.bleQueue.asyncAfter(deadline: .now() + 10) {
                    if self.connectedPeripheral == nil {
                        manager.stopScan()
                        NSLog("[WhoopBLE] retryConnection: scan timeout, no strap found")
                    }
                }

                promise.resolve(false)
            }
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

        // If no strap connected and no pending find, start background scanning.
        // This catches the case where the WHOOP app connects to the strap while
        // our app is in the background — we'll detect the strap via scan and
        // auto-connect.
        if connectedPeripheral == nil && pendingFindPromise == nil && autoReconnect {
            NSLog("[WhoopBLE] no strap connected, starting background scan for WHOOP")
            centralManager?.scanForPeripherals(
                withServices: WhoopBleConstants.allServiceUUIDs,
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
            )
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
        // If we're scanning for findWhoop(), resolve the promise
        if state == .scanning {
            centralManager?.stopScan()
            state = .idle

            let result: [String: Any?] = [
                "id": peripheral.identifier.uuidString,
                "name": peripheral.name,
            ]
            findPromise?.resolve(result)
            findPromise = nil
            return
        }

        // Background auto-connect: if we're not in a findWhoop scan but
        // found a WHOOP strap via background scanning, auto-connect to it.
        if connectedPeripheral == nil && autoReconnect {
            NSLog("[WhoopBLE] background scan found WHOOP strap %@ (%@), auto-connecting", peripheral.identifier.uuidString, peripheral.name ?? "unnamed")
            centralManager?.stopScan()
            connectedPeripheral = peripheral
            peripheral.delegate = delegate
            state = .connecting
            centralManager?.connect(peripheral, options: nil)
        }
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

        // Discover characteristics (CMD_TO_STRAP, CMD_FROM_STRAP, DATA_FROM_STRAP)
        let cmdUUID = WhoopBleConstants.cmdToStrapUUID(forService: service.uuid)
        let cmdRespUUID = WhoopBleConstants.cmdFromStrapUUID(forService: service.uuid)
        let dataUUID = WhoopBleConstants.dataFromStrapUUID(forService: service.uuid)
        peripheral.discoverCharacteristics([cmdUUID, cmdRespUUID, dataUUID], for: service)
    }

    func handleCharacteristicsDiscovered(_ peripheral: CBPeripheral, service: CBService) {
        let charUUIDs = service.characteristics?.map { $0.uuid.uuidString } ?? []
        NSLog("[WhoopBLE] characteristics discovered for service %@: %@", service.uuid.uuidString, charUUIDs.joined(separator: ", "))
        guard state == .discoveringServices else { return }

        let cmdUUID = WhoopBleConstants.cmdToStrapUUID(forService: service.uuid)
        let cmdRespUUID = WhoopBleConstants.cmdFromStrapUUID(forService: service.uuid)
        let dataUUID = WhoopBleConstants.dataFromStrapUUID(forService: service.uuid)

        cmdCharacteristic = service.characteristics?.first { $0.uuid == cmdUUID }
        cmdResponseCharacteristic = service.characteristics?.first { $0.uuid == cmdRespUUID }
        dataCharacteristic = service.characteristics?.first { $0.uuid == dataUUID }

        guard let cmdChar = cmdCharacteristic, let dataChar = dataCharacteristic else {
            NSLog("[WhoopBLE] missing characteristics: cmd=%@, data=%@", cmdCharacteristic == nil ? "MISSING" : "found", dataCharacteristic == nil ? "MISSING" : "found")
            connectPromise?.reject("NO_CHARACTERISTICS", "Required characteristics not found")
            connectPromise = nil
            state = .idle
            return
        }

        // Subscribe to DATA_FROM_STRAP and CMD_FROM_STRAP notifications
        NSLog("[WhoopBLE] subscribing to DATA_FROM_STRAP + CMD_FROM_STRAP notifications")
        peripheral.setNotifyValue(true, for: dataChar)
        if let cmdRespChar = cmdResponseCharacteristic {
            peripheral.setNotifyValue(true, for: cmdRespChar)
        }

        state = .ready
        connectPromise?.resolve(true)
        connectPromise = nil

        sendEvent("onConnectionStateChanged", [
            "state": "connected",
            "peripheralId": peripheral.identifier.uuidString,
        ])

        // Send TOGGLE_REALTIME_HR to enable continuous 1 Hz HR + quaternion streaming
        // beyond the normal sync window. Best-effort — command may be silently ignored.
        let realtimeHrCommand = WhoopBleFrameParser.buildCommandData(
            command: WhoopBleConstants.commandToggleRealtimeHr
        )
        NSLog("[WhoopBLE] sending TOGGLE_REALTIME_HR on connect")
        peripheral.writeValue(realtimeHrCommand, for: cmdChar, type: .withResponse)

        // Send TOGGLE_OPTICAL_MODE to enable raw PPG data in 0x28 packets.
        let opticalCommand = WhoopBleFrameParser.buildCommandData(
            command: WhoopBleConstants.commandToggleOpticalMode
        )
        NSLog("[WhoopBLE] sending TOGGLE_OPTICAL_MODE on connect")
        peripheral.writeValue(opticalCommand, for: cmdChar, type: .withResponse)

        // Auto-resume IMU streaming after reconnect (e.g., strap came back in range)
        if wasStreaming {
            wasStreaming = false
            let commandData = WhoopBleFrameParser.buildCommandData(
                command: WhoopBleConstants.commandToggleImuMode
            )
            peripheral.writeValue(commandData, for: cmdChar, type: .withResponse)
            state = .streaming
            frameParser.reset()
            cmdFrameParser.reset()
        }
    }

    /// Last write error for debugging (internal for delegate access)
    var lastWriteError: String?

    /// Data-path diagnostic counters (split by characteristic)
    private var dataNotificationCount: UInt64 = 0
    private var cmdNotificationCount: UInt64 = 0
    private var totalFramesParsed: UInt64 = 0
    private var totalSamplesExtracted: UInt64 = 0
    private var droppedForNonStreaming: UInt64 = 0
    private var emptyExtractions: UInt64 = 0
    private var bufferOverflows: UInt64 = 0

    /// Tracks which packet types we've received and how many of each
    private var packetTypeCounts: [UInt8: UInt64] = [:]

    /// Last command response received (for diagnosing TOGGLE_IMU_MODE success)
    private var lastCommandResponse: String = "none"

    func handleCommandResponse(_ data: Data) {
        cmdNotificationCount += 1

        let frames = cmdFrameParser.feed(data)
        for frame in frames {
            // Command response packet type is 0x24 (Maverick) or 0x26 (Puffin)
            let responseType = frame.packetType
            let responseHex = String(format: "0x%02X", responseType)

            if frame.payload.count >= 3 {
                let commandByte = frame.payload[frame.payload.startIndex + 2]
                let commandHex = String(format: "0x%02X", commandByte)

                // Check for error codes in response
                if frame.payload.count >= 5 {
                    let statusByte = frame.payload[frame.payload.startIndex + 3]
                    let statusHex = String(format: "0x%02X", statusByte)
                    lastCommandResponse = "\(responseHex) cmd=\(commandHex) status=\(statusHex)"
                    NSLog("[WhoopBLE] command response: type=%@ cmd=%@ status=%@ payload=%d bytes",
                          responseHex, commandHex, statusHex, frame.payload.count)
                } else {
                    lastCommandResponse = "\(responseHex) cmd=\(commandHex)"
                    NSLog("[WhoopBLE] command response: type=%@ cmd=%@ payload=%d bytes",
                          responseHex, commandHex, frame.payload.count)
                }
            } else {
                lastCommandResponse = "\(responseHex) (\(frame.payload.count) bytes)"
                NSLog("[WhoopBLE] command response: type=%@ payload=%d bytes",
                      responseHex, frame.payload.count)
            }
        }
    }

    func handleDataReceived(_ data: Data) {
        dataNotificationCount += 1

        let frames = frameParser.feed(data)
        totalFramesParsed += UInt64(frames.count)

        var newSamples: [WhoopImuSample] = []
        var newRealtimeData: [WhoopRealtimeDataSample] = []

        for frame in frames {
            // Track packet types for diagnostics
            packetTypeCounts[frame.packetType, default: 0] += 1

            // Log first occurrence of each packet type
            let count = packetTypeCounts[frame.packetType] ?? 0
            if count == 1 {
                NSLog("[WhoopBLE] first packet of type 0x%02X (record=%d, payload=%d bytes)",
                      frame.packetType, frame.recordType, frame.payload.count)
            }

            // Extract IMU samples from 0x2B/0x33/0x34 packets
            let samples = WhoopBleFrameParser.extractImuSamples(from: frame)
            newSamples.append(contentsOf: samples)

            // Extract realtime data (HR + quaternion) from 0x28 packets
            if let realtimeData = WhoopBleFrameParser.extractRealtimeData(from: frame) {
                newRealtimeData.append(realtimeData)
            }
        }

        // Buffer realtime data samples (HR + quaternion from 0x28 packets)
        if !newRealtimeData.isEmpty {
            bufferLock.lock()
            realtimeDataBuffer.append(contentsOf: newRealtimeData)
            if realtimeDataBuffer.count > WhoopBleModule.maxRealtimeDataBufferSize {
                let overflow = realtimeDataBuffer.count - WhoopBleModule.maxRealtimeDataBufferSize
                realtimeDataBuffer.removeFirst(overflow)
            }
            bufferLock.unlock()
        }

        if newSamples.isEmpty && newRealtimeData.isEmpty {
            emptyExtractions += 1
            return
        }

        totalSamplesExtracted += UInt64(newSamples.count)

        // Feed samples into orientation filter and emit throttled events
        for sample in newSamples {
            orientationFilter.update(
                accelerometerX: sample.accelerometerX,
                accelerometerY: sample.accelerometerY,
                accelerometerZ: sample.accelerometerZ,
                gyroscopeX: sample.gyroscopeX,
                gyroscopeY: sample.gyroscopeY,
                gyroscopeZ: sample.gyroscopeZ
            )

            orientationSampleCounter += 1
            if orientationSampleCounter >= WhoopBleModule.orientationEmitInterval {
                orientationSampleCounter = 0
                let quaternion = orientationFilter.quaternion
                let euler = orientationFilter.eulerAngles
                sendEvent("onOrientation", [
                    "w": quaternion.w,
                    "x": quaternion.x,
                    "y": quaternion.y,
                    "z": quaternion.z,
                    "roll": euler.roll,
                    "pitch": euler.pitch,
                    "yaw": euler.yaw,
                ])
            }
        }

        bufferLock.lock()
        sampleBuffer.append(contentsOf: newSamples)
        // Cap buffer size to prevent memory issues
        if sampleBuffer.count > WhoopBleModule.maxBufferSize {
            let overflow = sampleBuffer.count - WhoopBleModule.maxBufferSize
            sampleBuffer.removeFirst(overflow)
            bufferOverflows += 1
            NSLog("[WhoopBLE] buffer overflow: dropped %d oldest samples (overflow #%llu)", overflow, bufferOverflows)
        }
        bufferLock.unlock()
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

    /// Exposed for the BLE delegate to identify CMD_FROM_STRAP notifications.
    var cmdResponseCharacteristicUUID: CBUUID? {
        cmdResponseCharacteristic?.uuid
    }

    /// Exposed for the BLE delegate to identify DATA_FROM_STRAP notifications.
    var dataCharacteristicUUID: CBUUID? {
        dataCharacteristic?.uuid
    }


    private func cleanup() {
        state = .idle
        connectedPeripheral = nil
        cmdCharacteristic = nil
        cmdResponseCharacteristic = nil
        dataCharacteristic = nil
        frameParser.reset()
        cmdFrameParser.reset()
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
        didWriteValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        if let error = error {
            NSLog("[WhoopBLE] write error on %@: %@", characteristic.uuid.uuidString, error.localizedDescription)
            module?.lastWriteError = error.localizedDescription
        } else {
            NSLog("[WhoopBLE] write succeeded on %@", characteristic.uuid.uuidString)
            module?.lastWriteError = nil
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        if let error = error {
            NSLog("[WhoopBLE] notification error on %@: %@", characteristic.uuid.uuidString, error.localizedDescription)
            return
        }
        guard let data = characteristic.value else {
            NSLog("[WhoopBLE] notification with nil value on %@", characteristic.uuid.uuidString)
            return
        }

        // Route CMD_FROM_STRAP separately so we can parse command responses
        // and track data vs command notifications independently.
        // CMD_FROM_STRAP uses different framing and would corrupt the data
        // parser's accumulator if mixed with DATA_FROM_STRAP notifications.
        if let cmdRespUUID = module?.cmdResponseCharacteristicUUID,
           characteristic.uuid == cmdRespUUID {
            module?.handleCommandResponse(data)
        } else {
            module?.handleDataReceived(data)
        }
    }
}
