import Foundation

/// A decoded Heart Rate Measurement notification.
struct BleHeartRateMeasurement: Equatable {
    /// Heart rate in beats per minute.
    let heartRateBpm: Int
    /// Beat-to-beat (R-R) intervals in milliseconds, in the order reported.
    let rrIntervalsMs: [Int]
}

/// Parser for the Bluetooth Heart Rate Measurement characteristic (0x2A37).
///
/// Layout (little-endian), per the GATT Specification Supplement:
///  - byte 0: Flags
///      - bit 0: Heart Rate Value Format (0 = UInt8, 1 = UInt16)
///      - bits 1-2: Sensor Contact Status
///      - bit 3: Energy Expended Status present
///      - bit 4: R-R Interval present
///  - Heart Rate Value: UInt8 or UInt16 depending on flag bit 0
///  - Energy Expended (optional): UInt16, present when flag bit 3 is set
///  - R-R Intervals (optional): zero or more UInt16 in units of 1/1024 second
enum BleHeartRateMeasurementParser {
    /// R-R intervals are reported in units of 1/1024 of a second.
    private static let rrIntervalUnitsPerSecond = 1024.0

    static func parse(_ data: Data) -> BleHeartRateMeasurement? {
        // Need at least the flags byte and a UInt8 heart-rate value.
        guard data.count >= 2 else { return nil }

        // Index into the Data via its own indices, since a Data slice may not be
        // zero-based.
        let bytes = [UInt8](data)
        var offset = 0

        let flags = bytes[offset]
        offset += 1

        let isUInt16Format = (flags & 0x01) != 0
        let hasEnergyExpended = (flags & 0x08) != 0
        let hasRrIntervals = (flags & 0x10) != 0

        let heartRateBpm: Int
        if isUInt16Format {
            guard offset + 1 < bytes.count else { return nil }
            heartRateBpm = Int(bytes[offset]) | (Int(bytes[offset + 1]) << 8)
            offset += 2
        } else {
            guard offset < bytes.count else { return nil }
            heartRateBpm = Int(bytes[offset])
            offset += 1
        }

        // Energy Expended is a UInt16 we skip — it is a derived cumulative value,
        // not raw data we store. Reject a truncated packet that claims the field
        // but lacks the bytes, since skipping would misalign R-R parsing.
        if hasEnergyExpended {
            guard offset + 2 <= bytes.count else { return nil }
            offset += 2
        }

        var rrIntervalsMs: [Int] = []
        if hasRrIntervals {
            // R-R intervals come in whole UInt16s; a stray trailing byte means a
            // malformed notification, so reject it rather than emit partial data.
            guard (bytes.count - offset).isMultiple(of: 2) else { return nil }
            while offset + 1 < bytes.count {
                let rawUnits = Int(bytes[offset]) | (Int(bytes[offset + 1]) << 8)
                offset += 2
                let milliseconds = Int((Double(rawUnits) * 1000.0 / rrIntervalUnitsPerSecond).rounded())
                rrIntervalsMs.append(milliseconds)
            }
        }

        return BleHeartRateMeasurement(heartRateBpm: heartRateBpm, rrIntervalsMs: rrIntervalsMs)
    }
}
