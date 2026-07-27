import Foundation

/// A single realtime data sample from a 0x28 REALTIME_DATA packet.
/// Contains beat timing, orientation quaternion, and raw optical/PPG bytes
/// from the strap's sensor fusion. Device-reported heart rate is decoded
/// internally but not exported to JS or stored.
public struct WhoopRealtimeDataSample {
    public let timestampSeconds: UInt32
    public let subSeconds: UInt16
    public let heartRate: UInt8
    /// R-R interval in milliseconds (beat-to-beat timing from PPG).
    /// 0 when not available (e.g., no valid reading flag in compact packet).
    public let rrIntervalMs: UInt16
    public let quaternionW: Float
    public let quaternionX: Float
    public let quaternionY: Float
    public let quaternionZ: Float
    /// Raw optical/PPG bytes from payload offsets 23-40 (18 bytes).
    /// Format is partially understood — preserved for analysis.
    public let opticalBytes: Data

    public init(
        timestampSeconds: UInt32,
        subSeconds: UInt16,
        heartRate: UInt8,
        rrIntervalMs: UInt16,
        quaternionW: Float,
        quaternionX: Float,
        quaternionY: Float,
        quaternionZ: Float,
        opticalBytes: Data
    ) {
        self.timestampSeconds = timestampSeconds
        self.subSeconds = subSeconds
        self.heartRate = heartRate
        self.rrIntervalMs = rrIntervalMs
        self.quaternionW = quaternionW
        self.quaternionX = quaternionX
        self.quaternionY = quaternionY
        self.quaternionZ = quaternionZ
        self.opticalBytes = opticalBytes
    }
}

/// A single IMU sample extracted from a WHOOP BLE packet.
/// Contains 6-axis data: accelerometer XYZ (g) + gyroscope XYZ (rad/s).
/// Values are normalized from raw int16 sensor readings to standard physical units.
public struct WhoopImuSample {
    public let timestampSeconds: UInt32    // Unix epoch seconds from frame header
    public let subSeconds: UInt16          // Millisecond offset within second
    public let sampleIndex: Int            // Position within the frame (for per-sample timing)
    public let samplesInFrame: Int         // Total samples in the source frame (for rate derivation)
    public let accelerometerX: Float       // acceleration in g
    public let accelerometerY: Float       // acceleration in g
    public let accelerometerZ: Float       // acceleration in g
    public let gyroscopeX: Float           // rotation rate in rad/s
    public let gyroscopeY: Float           // rotation rate in rad/s
    public let gyroscopeZ: Float           // rotation rate in rad/s

    public init(
        timestampSeconds: UInt32,
        subSeconds: UInt16,
        sampleIndex: Int,
        samplesInFrame: Int,
        accelerometerX: Float,
        accelerometerY: Float,
        accelerometerZ: Float,
        gyroscopeX: Float,
        gyroscopeY: Float,
        gyroscopeZ: Float
    ) {
        self.timestampSeconds = timestampSeconds
        self.subSeconds = subSeconds
        self.sampleIndex = sampleIndex
        self.samplesInFrame = samplesInFrame
        self.accelerometerX = accelerometerX
        self.accelerometerY = accelerometerY
        self.accelerometerZ = accelerometerZ
        self.gyroscopeX = gyroscopeX
        self.gyroscopeY = gyroscopeY
        self.gyroscopeZ = gyroscopeZ
    }
}
