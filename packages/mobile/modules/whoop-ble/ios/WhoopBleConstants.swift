import CoreBluetooth

/// WHOOP BLE protocol constants reverse-engineered from APK v5.439.0
/// and iOS PacketLogger capture analysis.
enum WhoopBleConstants {

    // MARK: - Service UUIDs (one per hardware generation)

    /// Gen 4 (Harvard)
    static let gen4ServiceUUID = CBUUID(string: "61080001-8d6d-82b8-614a-1c8cb0f8dcc6")
    /// Maverick / Goose
    static let maverickServiceUUID = CBUUID(string: "fd4b0001-cce1-4033-93ce-002d5875f58a")
    /// Puffin
    static let puffinServiceUUID = CBUUID(string: "11500001-6215-11ee-8c99-0242ac120002")

    /// All known WHOOP service UUIDs for scanning/retrieval
    static let allServiceUUIDs: [CBUUID] = [
        gen4ServiceUUID,
        maverickServiceUUID,
        puffinServiceUUID,
    ]

    // MARK: - Characteristic UUID derivation

    /// Derive a characteristic UUID from a service UUID by replacing the
    /// `0001` suffix with the given suffix string.
    ///
    /// WHOOP uses a consistent pattern: all characteristics share the same
    /// base UUID as the service but with a different 4-digit prefix.
    ///
    /// Example: service `61080001-...` → CMD_TO_STRAP `61080002-...`
    static func characteristicUUID(forService serviceUUID: CBUUID, suffix: String) -> CBUUID {
        let uuidString = serviceUUID.uuidString
        // Replace the last 4 chars of the first group (before the first dash)
        // "61080001-..." → "61080002-..."
        guard let dashIndex = uuidString.firstIndex(of: "-") else {
            return serviceUUID
        }
        let prefix = uuidString[uuidString.startIndex..<uuidString.index(dashIndex, offsetBy: -4)]
        let rest = uuidString[dashIndex...]
        return CBUUID(string: "\(prefix)\(suffix)\(rest)")
    }

    /// CMD_TO_STRAP characteristic (write): suffix 0002
    static func cmdToStrapUUID(forService serviceUUID: CBUUID) -> CBUUID {
        characteristicUUID(forService: serviceUUID, suffix: "0002")
    }

    /// DATA_FROM_STRAP characteristic (notify): suffix 0005
    static func dataFromStrapUUID(forService serviceUUID: CBUUID) -> CBUUID {
        characteristicUUID(forService: serviceUUID, suffix: "0005")
    }

    // MARK: - Frame format

    /// Start-of-frame marker byte
    static let startOfFrame: UInt8 = 0xAA

    /// Minimum frame size: Maverick header(8) + at least 1 byte payload = 9
    static let minimumFrameSize = 9

    /// Maverick/Puffin header size: SOF(1) + version(1) + payloadLen(2) + role1(1) + role2(1) + CRC16(2) = 8
    static let maverickHeaderSize = 8

    // MARK: - Packet types (first byte of payload)

    static let packetTypeCommand: UInt8 = 0x23
    static let packetTypeRealtimeIMU: UInt8 = 0x33
    static let packetTypeHistoricalIMU: UInt8 = 0x34
    static let packetTypeRealtimeRawData: UInt8 = 0x2B

    // MARK: - Command bytes (written to CMD_TO_STRAP)

    static let commandGetHello: UInt8 = 0x91
    static let commandStartRawData: UInt8 = 0x51
    static let commandStopRawData: UInt8 = 0x52
    static let commandToggleImuModeHistorical: UInt8 = 0x69
    static let commandToggleImuMode: UInt8 = 0x6A

    /// CMD_FROM_STRAP characteristic (notify): suffix 0003
    static func cmdFromStrapUUID(forService serviceUUID: CBUUID) -> CBUUID {
        characteristicUUID(forService: serviceUUID, suffix: "0003")
    }
}
