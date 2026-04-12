import Foundation

/// A single realtime data sample from a 0x28 REALTIME_DATA packet.
/// Contains heart rate, orientation quaternion, and raw optical/PPG bytes
/// from the strap's sensor fusion.
struct WhoopRealtimeDataSample {
    let timestampSeconds: UInt32
    let subSeconds: UInt16
    let heartRate: UInt8
    /// R-R interval in milliseconds (beat-to-beat timing from PPG).
    /// 0 when not available (e.g., no valid reading flag in compact packet).
    let rrIntervalMs: UInt16
    let quaternionW: Float
    let quaternionX: Float
    let quaternionY: Float
    let quaternionZ: Float
    /// Raw optical/PPG bytes from payload offsets 23-40 (18 bytes).
    /// Format is partially understood — preserved for analysis.
    let opticalBytes: Data
}

/// A single IMU sample extracted from a WHOOP BLE packet.
/// Contains 6-axis data: accelerometer XYZ (g) + gyroscope XYZ (rad/s).
/// Values are normalized from raw int16 sensor readings to standard physical units.
struct WhoopImuSample {
    let timestampSeconds: UInt32    // Unix epoch seconds from frame header
    let subSeconds: UInt16          // Millisecond offset within second
    let sampleIndex: Int            // Position within the frame (for per-sample timing)
    let samplesInFrame: Int         // Total samples in the source frame (for rate derivation)
    let accelerometerX: Float       // acceleration in g
    let accelerometerY: Float       // acceleration in g
    let accelerometerZ: Float       // acceleration in g
    let gyroscopeX: Float           // rotation rate in rad/s
    let gyroscopeY: Float           // rotation rate in rad/s
    let gyroscopeZ: Float           // rotation rate in rad/s
}

/// A parsed WHOOP BLE frame.
struct WhoopFrame {
    let packetType: UInt8
    let recordType: UInt8
    let dataTimestamp: UInt32     // Unix epoch seconds
    let subSeconds: UInt16
    let payload: Data
}

// MARK: - Data extensions for little-endian reading

extension Data {
    func readUInt16LE(at offset: Int) -> UInt16 {
        guard offset + 2 <= endIndex else { return 0 }
        return UInt16(self[offset]) | (UInt16(self[offset + 1]) << 8)
    }

    func readInt16LE(at offset: Int) -> Int16 {
        return Int16(bitPattern: readUInt16LE(at: offset))
    }

    func readUInt32LE(at offset: Int) -> UInt32 {
        guard offset + 4 <= endIndex else { return 0 }
        return UInt32(self[offset])
            | (UInt32(self[offset + 1]) << 8)
            | (UInt32(self[offset + 2]) << 16)
            | (UInt32(self[offset + 3]) << 24)
    }

    func readFloat32LE(at offset: Int) -> Float {
        let bits = readUInt32LE(at: offset)
        return Float(bitPattern: bits)
    }
}
