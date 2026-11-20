import Foundation

struct WhoopBleBatteryStatus: Equatable {
    var percentage: Double?
    var isCharging: Bool?
}

extension WhoopBleFrameParser {
    private enum BatteryEvent: UInt8 {
        case level = 3
        case chargingOn = 7
        case chargingOff = 8
    }

    static func extractBatteryStatus(from frame: WhoopFrame) -> WhoopBleBatteryStatus? {
        let payload = frame.payload
        let bodyEnd = payload.count - 4  // The validated frame still carries its trailing CRC32.
        guard frame.packetType == 0x30, bodyEnd >= 12,
              Int(payload.readUInt16LE(at: 10)) == bodyEnd - 12,
              let event = BatteryEvent(rawValue: payload[2]) else { return nil }

        switch event {
        case .chargingOn:
            return WhoopBleBatteryStatus(isCharging: true)
        case .chargingOff:
            return WhoopBleBatteryStatus(isCharging: false)
        case .level:
            guard bodyEnd > 22 else { return nil }
            let decipercent = payload.readUInt16LE(at: 13)
            guard decipercent <= 1_000 else { return nil }
            return WhoopBleBatteryStatus(
                percentage: Double(decipercent) / 10,
                isCharging: payload[22] & 1 != 0
            )
        }
    }
}
