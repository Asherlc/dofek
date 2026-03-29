import CoreBluetooth
import Foundation

// MARK: - Known WHOOP service UUIDs

let whoopServiceUUIDs: [(String, CBUUID)] = [
    ("Gen4/Harvard", CBUUID(string: "61080001-8d6d-82b8-614a-1c8cb0f8dcc6")),
    ("Maverick/Goose", CBUUID(string: "fd4b0001-cce1-4033-93ce-002d5875f58a")),
    ("Puffin", CBUUID(string: "11500001-6215-11ee-8c99-0242ac120002")),
]

let allWhoopServiceUUIDs = whoopServiceUUIDs.map(\.1)

// MARK: - Frame helpers

func hexDump(_ data: Data, maxBytes: Int = 64) -> String {
    data.prefix(maxBytes).map { String(format: "%02x", $0) }.joined(separator: " ")
}

func parseWhoopFrame(_ data: Data) -> (packetType: UInt8, payloadLen: Int, payload: Data)? {
    guard data.count >= 9, data[0] == 0xAA else { return nil }
    let payloadLen = Int(data[2]) | (Int(data[3]) << 8)
    guard data.count >= 4 + payloadLen else { return nil }
    let payload = data[4..<(4 + payloadLen)]
    guard !payload.isEmpty else { return nil }
    // Packet type is at payload offset 4 (after 4-byte preamble)
    let packetType = payload.count > 4 ? payload[payload.startIndex + 4] : payload[payload.startIndex]
    return (packetType, payloadLen, Data(payload))
}

let packetTypeNames: [UInt8: String] = [
    0x23: "COMMAND",
    0x24: "CMD_RESPONSE",
    0x28: "REALTIME_DATA",
    0x2B: "REALTIME_RAW",
    0x2F: "HISTORICAL",
    0x31: "METADATA",
    0x32: "CONSOLE_LOG",
    0x33: "REALTIME_IMU",
    0x34: "HISTORICAL_IMU",
]

func buildCommand(_ commandByte: UInt8, seq: UInt8) -> Data {
    var frame = Data()
    frame.append(0xAA)  // SOF
    frame.append(0x01)  // version
    frame.append(0x0C)  // payload length low = 12
    frame.append(0x00)  // payload length high
    // Payload: preamble + command structure
    frame.append(contentsOf: [0x00, 0x01, 0xE7, 0x41])  // preamble
    frame.append(0x23)  // COMMAND type
    frame.append(seq)
    frame.append(commandByte)
    frame.append(contentsOf: [0x01, 0x01, 0x00, 0x00, 0x00])  // params
    return frame
}

// MARK: - BLE Manager

class BleProbe: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    let centralManager: CBCentralManager
    let queue = DispatchQueue(label: "ble-probe", qos: .userInitiated)

    var connectedPeripheral: CBPeripheral?
    var discoveredCharacteristics: [String: CBCharacteristic] = [:]  // suffix -> char
    var serviceUUID: CBUUID?

    var commandSeq: UInt8 = 1
    var notificationCount: UInt64 = 0
    var packetTypeCounts: [UInt8: Int] = [:]
    var verbose = false

    override init() {
        centralManager = CBCentralManager(delegate: nil, queue: nil)
        super.init()
        centralManager.delegate = self
    }

    // MARK: - Commands

    func scan() {
        guard centralManager.state == .poweredOn else {
            print("⚠️  Bluetooth not powered on (state: \(centralManager.state.rawValue))")
            return
        }
        print("🔍 Scanning for BLE devices (5 seconds)...")
        centralManager.scanForPeripherals(withServices: nil, options: nil)
        queue.asyncAfter(deadline: .now() + 5) {
            self.centralManager.stopScan()
            print("⏹  Scan stopped")
        }
    }

    func scanWhoop() {
        guard centralManager.state == .poweredOn else {
            print("⚠️  Bluetooth not powered on")
            return
        }
        print("🔍 Scanning for WHOOP straps...")
        // Check already-connected peripherals first
        for (name, uuid) in whoopServiceUUIDs {
            let connected = centralManager.retrieveConnectedPeripherals(withServices: [uuid])
            for peripheral in connected {
                print("  ✅ Already connected (\(name)): \(peripheral.name ?? "unnamed") [\(peripheral.identifier)]")
            }
        }
        // Then scan
        centralManager.scanForPeripherals(withServices: allWhoopServiceUUIDs, options: nil)
        queue.asyncAfter(deadline: .now() + 5) {
            self.centralManager.stopScan()
            print("⏹  Scan stopped")
        }
    }

    func connect(_ uuidString: String) {
        guard let uuid = UUID(uuidString: uuidString) else {
            print("❌ Invalid UUID: \(uuidString)")
            return
        }
        let peripherals = centralManager.retrievePeripherals(withIdentifiers: [uuid])
        guard let peripheral = peripherals.first else {
            // Try retrieveConnectedPeripherals
            for serviceUUID in allWhoopServiceUUIDs {
                let connected = centralManager.retrieveConnectedPeripherals(withServices: [serviceUUID])
                if let match = connected.first(where: { $0.identifier == uuid }) {
                    doConnect(match)
                    return
                }
            }
            print("❌ Peripheral not found: \(uuidString)")
            return
        }
        doConnect(peripheral)
    }

    private func doConnect(_ peripheral: CBPeripheral) {
        print("🔗 Connecting to \(peripheral.name ?? "unnamed") [\(peripheral.identifier)]...")
        connectedPeripheral = peripheral
        peripheral.delegate = self
        centralManager.connect(peripheral, options: nil)
    }

    func discover() {
        guard let peripheral = connectedPeripheral else {
            print("❌ Not connected. Use: connect <UUID>")
            return
        }
        print("🔎 Discovering all services...")
        peripheral.discoverServices(nil)
    }

    func subscribe(_ suffix: String) {
        guard let char = discoveredCharacteristics[suffix] else {
            print("❌ No characteristic with suffix \(suffix). Run 'discover' first.")
            print("   Available: \(discoveredCharacteristics.keys.sorted().joined(separator: ", "))")
            return
        }
        guard let peripheral = connectedPeripheral else { return }
        print("📡 Subscribing to notifications on ....\(suffix)")
        peripheral.setNotifyValue(true, for: char)
    }

    func unsubscribe(_ suffix: String) {
        guard let char = discoveredCharacteristics[suffix], let peripheral = connectedPeripheral else { return }
        peripheral.setNotifyValue(false, for: char)
        print("🔇 Unsubscribed from ....\(suffix)")
    }

    func sendCommand(_ commandByte: UInt8) {
        guard let peripheral = connectedPeripheral else {
            print("❌ Not connected")
            return
        }
        guard let cmdChar = discoveredCharacteristics["0002"] else {
            print("❌ CMD_TO_STRAP (0002) not found. Run 'discover' first.")
            return
        }
        let data = buildCommand(commandByte, seq: commandSeq)
        commandSeq &+= 1
        let hex = hexDump(data, maxBytes: 100)
        print("📤 Writing to CMD_TO_STRAP: \(hex)")
        peripheral.writeValue(data, for: cmdChar, type: .withResponse)
    }

    func sendRaw(_ hexString: String) {
        guard let peripheral = connectedPeripheral else {
            print("❌ Not connected")
            return
        }
        guard let cmdChar = discoveredCharacteristics["0002"] else {
            print("❌ CMD_TO_STRAP (0002) not found")
            return
        }
        let cleaned = hexString.replacingOccurrences(of: " ", with: "")
        guard cleaned.count % 2 == 0 else {
            print("❌ Invalid hex string (odd length)")
            return
        }
        var bytes: [UInt8] = []
        var index = cleaned.startIndex
        while index < cleaned.endIndex {
            let nextIndex = cleaned.index(index, offsetBy: 2)
            guard let byte = UInt8(cleaned[index..<nextIndex], radix: 16) else {
                print("❌ Invalid hex byte at position \(cleaned.distance(from: cleaned.startIndex, to: index))")
                return
            }
            bytes.append(byte)
            index = nextIndex
        }
        let data = Data(bytes)
        print("📤 Writing raw \(data.count) bytes: \(hexDump(data, maxBytes: 100))")
        peripheral.writeValue(data, for: cmdChar, type: .withResponse)
    }

    func stats() {
        print("📊 Notification stats:")
        print("   Total notifications: \(notificationCount)")
        for (type, count) in packetTypeCounts.sorted(by: { $0.key < $1.key }) {
            let name = packetTypeNames[type] ?? "UNKNOWN"
            print("   0x\(String(format: "%02x", type)) (\(name)): \(count)")
        }
    }

    func resetStats() {
        notificationCount = 0
        packetTypeCounts = [:]
        print("📊 Stats reset")
    }

    // MARK: - CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let states = ["unknown", "resetting", "unsupported", "unauthorized", "poweredOff", "poweredOn"]
        let stateName = central.state.rawValue < states.count ? states[Int(central.state.rawValue)] : "?"
        print("📶 Bluetooth state: \(stateName)")
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                         advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = peripheral.name ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? "unnamed"
        print("  📱 \(name) [\(peripheral.identifier)] RSSI=\(RSSI)")
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        print("✅ Connected to \(peripheral.name ?? "unnamed")")
        print("   Run 'discover' to find services, then 'subscribe 0005' for data")
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        print("❌ Failed to connect: \(error?.localizedDescription ?? "unknown")")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        print("🔌 Disconnected: \(error?.localizedDescription ?? "clean")")
    }

    // MARK: - CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error = error {
            print("❌ Service discovery error: \(error.localizedDescription)")
            return
        }
        guard let services = peripheral.services else {
            print("   No services found")
            return
        }
        print("📋 Found \(services.count) services:")
        for service in services {
            let known = whoopServiceUUIDs.first(where: { $0.1 == service.uuid })
            let label = known.map { " (\($0.0))" } ?? ""
            print("   🔹 \(service.uuid)\(label)")
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if let error = error {
            print("❌ Characteristic discovery error: \(error.localizedDescription)")
            return
        }
        guard let chars = service.characteristics else { return }

        let isWhoop = whoopServiceUUIDs.contains(where: { $0.1 == service.uuid })
        if isWhoop { serviceUUID = service.uuid }

        print("   Characteristics for \(service.uuid):")
        for char in chars {
            // Extract suffix (last 4 chars of first UUID group)
            let uuidStr = char.uuid.uuidString
            let suffix: String
            if let dashIndex = uuidStr.firstIndex(of: "-") {
                let start = uuidStr.index(dashIndex, offsetBy: -4)
                suffix = String(uuidStr[start..<dashIndex])
            } else {
                suffix = uuidStr
            }

            let props = describeProperies(char.properties)
            let knownNames: [String: String] = [
                "0002": "CMD_TO_STRAP",
                "0003": "CMD_FROM_STRAP",
                "0004": "EVENTS_FROM_STRAP",
                "0005": "DATA_FROM_STRAP",
                "0007": "MEMFAULT",
            ]
            let name = knownNames[suffix] ?? ""
            print("      ....\(suffix) \(name) [\(props)]")

            if isWhoop {
                discoveredCharacteristics[suffix] = char
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        let suffix = extractSuffix(characteristic.uuid)
        if let error = error {
            print("❌ Write failed on ....\(suffix): \(error.localizedDescription)")
        } else {
            print("✅ Write succeeded on ....\(suffix)")
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        let suffix = extractSuffix(characteristic.uuid)
        if let error = error {
            print("❌ Notification subscribe failed on ....\(suffix): \(error.localizedDescription)")
        } else {
            print("📡 Notifications \(characteristic.isNotifying ? "enabled" : "disabled") on ....\(suffix)")
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error = error {
            print("❌ Notification error: \(error.localizedDescription)")
            return
        }
        guard let data = characteristic.value else { return }
        let suffix = extractSuffix(characteristic.uuid)
        notificationCount += 1

        // Parse WHOOP frame
        if let frame = parseWhoopFrame(data) {
            packetTypeCounts[frame.packetType, default: 0] += 1
            let typeName = packetTypeNames[frame.packetType] ?? "UNKNOWN"

            if verbose || notificationCount <= 10 || notificationCount % 100 == 0 {
                print("📨 #\(notificationCount) ....\(suffix) [\(data.count)B] type=0x\(String(format: "%02x", frame.packetType)) (\(typeName)) payload=\(frame.payloadLen)B")
                if verbose {
                    print("   \(hexDump(data))")
                }
            }
        } else {
            if verbose || notificationCount <= 10 {
                print("📨 #\(notificationCount) ....\(suffix) [\(data.count)B] (unparsed): \(hexDump(data))")
            }
        }
    }

    // MARK: - Helpers

    private func extractSuffix(_ uuid: CBUUID) -> String {
        let uuidStr = uuid.uuidString
        guard let dashIndex = uuidStr.firstIndex(of: "-") else { return uuidStr }
        let start = uuidStr.index(dashIndex, offsetBy: -4)
        return String(uuidStr[start..<dashIndex])
    }

    private func describeProperies(_ props: CBCharacteristicProperties) -> String {
        var parts: [String] = []
        if props.contains(.read) { parts.append("R") }
        if props.contains(.write) { parts.append("W") }
        if props.contains(.writeWithoutResponse) { parts.append("WnR") }
        if props.contains(.notify) { parts.append("N") }
        if props.contains(.indicate) { parts.append("I") }
        return parts.joined(separator: ",")
    }
}

// MARK: - REPL

let probe = BleProbe()

func printHelp() {
    print("""

    BLE Probe — Interactive BLE reverse engineering tool

    Commands:
      scan                 Scan for all nearby BLE devices (5s)
      whoop                Scan for WHOOP straps specifically
      connect <UUID>       Connect to a peripheral by UUID
      discover             Discover all services and characteristics
      subscribe <suffix>   Subscribe to notifications (e.g., 'subscribe 0005')
      unsubscribe <suffix> Unsubscribe from notifications
      cmd <hex>            Send a WHOOP command byte (e.g., 'cmd 6a' for TOGGLE_IMU_MODE)
      raw <hex bytes>      Write raw hex bytes to CMD_TO_STRAP
      stats                Show notification packet type counts
      reset                Reset notification stats
      verbose              Toggle verbose mode (show all notifications)
      help                 Show this help

    WHOOP-specific commands:
      cmd 91               GET_HELLO (handshake)
      cmd 6a               TOGGLE_IMU_MODE (start IMU streaming)
      cmd 69               TOGGLE_IMU_MODE_HISTORICAL
      cmd 51               START_RAW_DATA
      cmd 52               STOP_RAW_DATA

    Typical WHOOP workflow:
      1. whoop              (find the strap)
      2. connect <UUID>     (connect to it)
      3. discover           (find characteristics)
      4. subscribe 0003     (command responses)
      5. subscribe 0005     (data stream)
      6. cmd 6a             (start IMU streaming)
      7. stats              (see what packet types arrive)

    """)
}

print("BLE Probe v0.1 — type 'help' for commands")
print("Waiting for Bluetooth to power on...")

// Process commands from stdin on a background thread so the main
// run loop stays free for CoreBluetooth delegate callbacks.
DispatchQueue.global(qos: .userInteractive).async {
    // Wait for Bluetooth to initialize (needs run loop processing)
    for _ in 0..<30 {
        if probe.centralManager.state == .poweredOn { break }
        Thread.sleep(forTimeInterval: 0.1)
    }
    if probe.centralManager.state == .poweredOn {
        print("✅ Bluetooth ready")
    } else {
        print("⚠️  Bluetooth not powered on after 3s (state: \(probe.centralManager.state.rawValue))")
    }

    // REPL
    while true {
        print("\n> ", terminator: "")
        guard let line = readLine()?.trimmingCharacters(in: .whitespaces) else {
            exit(0)
        }
        if line.isEmpty { continue }

        let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
        let command = parts[0].lowercased()
        let arg = parts.count > 1 ? parts[1] : ""

        switch command {
        case "help", "?", "h":
            printHelp()
        case "scan":
            probe.scan()
        case "whoop":
            probe.scanWhoop()
        case "connect", "c":
            probe.connect(arg)
        case "discover", "disc", "d":
            probe.discover()
        case "subscribe", "sub", "s":
            probe.subscribe(arg)
        case "unsubscribe", "unsub":
            probe.unsubscribe(arg)
        case "cmd":
            guard let byte = UInt8(arg.replacingOccurrences(of: "0x", with: ""), radix: 16) else {
                print("❌ Invalid hex byte: \(arg)")
                continue
            }
            probe.sendCommand(byte)
        case "raw":
            probe.sendRaw(arg)
        case "stats":
            probe.stats()
        case "reset":
            probe.resetStats()
        case "verbose", "v":
            probe.verbose.toggle()
            print("Verbose mode: \(probe.verbose ? "ON" : "OFF")")
        case "quit", "exit", "q":
            exit(0)
        default:
            print("❌ Unknown command: \(command). Type 'help' for commands.")
        }
    }
}

// Keep the main run loop alive for CoreBluetooth callbacks
RunLoop.main.run()
