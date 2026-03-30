import Foundation

/// A single realtime data sample from a 0x28 REALTIME_DATA packet.
/// Contains heart rate, orientation quaternion from the strap's sensor fusion,
/// and the full raw payload for future analysis of optical/PPG fields.
struct WhoopRealtimeDataSample {
    let timestampSeconds: UInt32
    let subSeconds: UInt16
    let heartRate: UInt8
    let quaternionW: Float
    let quaternionX: Float
    let quaternionY: Float
    let quaternionZ: Float
    let rawPayload: Data
}

/// A single IMU sample extracted from a WHOOP BLE packet.
/// Contains 6-axis data: accelerometer XYZ + gyroscope XYZ.
/// Values are raw signed 16-bit integers from the strap's sensor.
struct WhoopImuSample {
    let timestampSeconds: UInt32    // Unix epoch seconds from frame header
    let subSeconds: UInt16          // Millisecond offset within second
    let sampleIndex: Int            // Position within the frame (for per-sample timing)
    let accelerometerX: Int16
    let accelerometerY: Int16
    let accelerometerZ: Int16
    let gyroscopeX: Int16
    let gyroscopeY: Int16
    let gyroscopeZ: Int16
}

/// A parsed WHOOP BLE frame.
struct WhoopFrame {
    let packetType: UInt8
    let recordType: UInt8
    let dataTimestamp: UInt32     // Unix epoch seconds
    let subSeconds: UInt16
    let payload: Data
}

/// Stateless parser for WHOOP BLE frames and IMU sample extraction.
///
/// Frame format: `[0xAA] [payloadLen: u16 LE] [crc8: u8] [payload...] [crc32: u32 LE]`
///
/// The parser handles BLE notification fragmentation by accumulating bytes
/// across multiple notifications until a complete frame is detected.
final class WhoopBleFrameParser {

    /// Accumulated bytes from BLE notifications (frames may span multiple notifications)
    private var accumulator = Data()

    /// Reset the accumulator (e.g., on disconnect)
    func reset() {
        accumulator = Data()
    }

    /// Feed raw BLE notification data into the parser.
    /// Returns any complete frames that were assembled.
    func feed(_ data: Data) -> [WhoopFrame] {
        var frames: [WhoopFrame] = []

        // If this notification starts with SOF and we have accumulated data,
        // try to parse the accumulated frame first
        if !data.isEmpty && data[0] == WhoopBleConstants.startOfFrame && !accumulator.isEmpty {
            if let frame = WhoopBleFrameParser.parseFrame(accumulator) {
                frames.append(frame)
            }
            accumulator = Data()
        }

        accumulator.append(data)

        // Try to parse the current accumulator
        if let frame = WhoopBleFrameParser.parseFrame(accumulator) {
            frames.append(frame)
            let payloadLen = Int(accumulator[2]) | (Int(accumulator[3]) << 8)
            let consumed = min(8 + payloadLen, accumulator.count)
            if consumed < accumulator.count {
                accumulator = Data(accumulator[consumed...])
            } else {
                accumulator = Data()
            }
        }

        return frames
    }

    // MARK: - Static parsing (testable without BLE)

    /// Parse a single WHOOP frame from raw bytes.
    ///
    /// Supports two header formats observed across WHOOP hardware generations:
    ///
    /// **Gen 4 (Harvard)** — u16 LE payload length:
    /// ```
    /// [0xAA] [payloadLen: u16 LE] [crc8] [payload...] [crc32]
    /// ```
    ///
    /// **Newer straps (Maverick/Puffin)** — u8 payload length with frame type:
    /// ```
    /// [0xAA] [frameType: u8] [payloadLen: u8] [crc8] [payload...] [crc32]
    /// ```
    ///
    /// We try u16 LE first. If the resulting length exceeds the buffer but
    /// interpreting byte[2] as a u8 length produces a valid frame, use that.
    static func parseFrame(_ data: Data) -> WhoopFrame? {
        guard data.count >= WhoopBleConstants.minimumFrameSize else { return nil }
        guard data[0] == WhoopBleConstants.startOfFrame else { return nil }

        // Maverick/Puffin frame format (8-byte header):
        // [SOF: 0xAA] [ver: 0x01] [payloadLen: u16 LE] [role1] [role2] [CRC16: u16 LE]
        // [payload: payloadLen bytes (includes trailing CRC32)]
        //
        // payloadLen at bytes 2-3 is the number of bytes AFTER the 8-byte header.
        let maverickHeaderSize = WhoopBleConstants.maverickHeaderSize
        let payloadLen = Int(data[2]) | (Int(data[3]) << 8)

        // Need at least the full header
        guard data.count >= maverickHeaderSize else { return nil }

        // Require the full payload before accepting the frame.
        guard data.count >= maverickHeaderSize + payloadLen else { return nil }

        let payloadEnd = min(maverickHeaderSize + payloadLen, data.count)
        let payload = data[maverickHeaderSize..<payloadEnd]

        guard !payload.isEmpty else { return nil }

        let packetType = payload[payload.startIndex]

        var recordType: UInt8 = 0
        var dataTimestamp: UInt32 = 0
        var subSeconds: UInt16 = 0

        // Data packets with Maverick header:
        // [0] packetType, [1] recordType, [2-6] other fields,
        // [7-10] Unix timestamp (u32 LE), [11-12] sub-seconds (u16 LE)
        // Note: timestamp is at offset 7, NOT 3. Confirmed via live capture
        // analysis — offset 3 produced 1970 dates, offset 7 gives correct 2026 dates.
        if payload.count >= 13 {
            recordType = payload[payload.startIndex + 1]
            dataTimestamp = payload.readUInt32LE(at: payload.startIndex + 7)
            subSeconds = payload.readUInt16LE(at: payload.startIndex + 11)
        }

        return WhoopFrame(
            packetType: packetType,
            recordType: recordType,
            dataTimestamp: dataTimestamp,
            subSeconds: subSeconds,
            payload: Data(payload)
        )
    }

    /// Extract IMU samples from a parsed WHOOP frame.
    ///
    /// Handles two formats:
    /// 1. IMU stream (types 0x33/0x34): interleaved 12-byte samples at offset 28
    /// 2. R21 Maverick (type 0x2B, record 21): separate channel arrays at fixed offsets
    static func extractImuSamples(from frame: WhoopFrame) -> [WhoopImuSample] {
        let payload = frame.payload

        // IMU stream packet (type 0x33 or 0x34)
        if (frame.packetType == WhoopBleConstants.packetTypeRealtimeIMU ||
            frame.packetType == WhoopBleConstants.packetTypeHistoricalIMU) &&
            payload.count >= 28 {

            let countA = Int(payload.readUInt16LE(at: 24))
            let countB = Int(payload.readUInt16LE(at: 26))
            let count = min(countA, countB, 200) // safety cap

            var samples: [WhoopImuSample] = []
            samples.reserveCapacity(count)

            var offset = 28
            for sampleIndex in 0..<count {
                guard offset + 12 <= payload.count else { break }

                samples.append(WhoopImuSample(
                    timestampSeconds: frame.dataTimestamp,
                    subSeconds: frame.subSeconds,
                    sampleIndex: sampleIndex,
                    accelerometerX: payload.readInt16LE(at: offset),
                    accelerometerY: payload.readInt16LE(at: offset + 2),
                    accelerometerZ: payload.readInt16LE(at: offset + 4),
                    gyroscopeX: payload.readInt16LE(at: offset + 6),
                    gyroscopeY: payload.readInt16LE(at: offset + 8),
                    gyroscopeZ: payload.readInt16LE(at: offset + 10)
                ))
                offset += 12
            }
            return samples
        }

        // R21 Maverick raw packet (type 0x2B, record type 21)
        // Payload is ~1232-1236 bytes (depending on whether CRC32 is included).
        // Need at least 1032 + 200 = 1232 bytes for the gyroscope Z array.
        if frame.packetType == WhoopBleConstants.packetTypeRealtimeRawData &&
           frame.recordType == 21 &&
           payload.count >= 1232 {

            let countA = min(Int(payload.readUInt16LE(at: 16)), 100)
            let countB = min(Int(payload.readUInt16LE(at: 622)), 100)

            var samples: [WhoopImuSample] = []
            samples.reserveCapacity(countA)

            for sampleIndex in 0..<countA {
                samples.append(WhoopImuSample(
                    timestampSeconds: frame.dataTimestamp,
                    subSeconds: frame.subSeconds,
                    sampleIndex: sampleIndex,
                    accelerometerX: payload.readInt16LE(at: 20 + sampleIndex * 2),
                    accelerometerY: payload.readInt16LE(at: 220 + sampleIndex * 2),
                    accelerometerZ: payload.readInt16LE(at: 420 + sampleIndex * 2),
                    gyroscopeX: sampleIndex < countB ? payload.readInt16LE(at: 632 + sampleIndex * 2) : 0,
                    gyroscopeY: sampleIndex < countB ? payload.readInt16LE(at: 832 + sampleIndex * 2) : 0,
                    gyroscopeZ: sampleIndex < countB ? payload.readInt16LE(at: 1032 + sampleIndex * 2) : 0
                ))
            }
            return samples
        }

        return []
    }

    /// Extract a realtime data sample (HR + orientation quaternion) from a 0x28 packet.
    ///
    /// The REALTIME_DATA packet (~116 bytes payload) is sent at ~1 Hz during sync:
    /// - Byte 22: heart rate (bpm)
    /// - Bytes 41-44: quaternion W (float32 LE)
    /// - Bytes 45-48: quaternion X (float32 LE)
    /// - Bytes 49-52: quaternion Y (float32 LE)
    /// - Bytes 53-56: quaternion Z (float32 LE)
    static func extractRealtimeData(from frame: WhoopFrame) -> WhoopRealtimeDataSample? {
        guard frame.packetType == WhoopBleConstants.packetTypeRealtimeData else { return nil }

        let payload = frame.payload
        guard payload.count >= WhoopBleConstants.realtimeDataMinPayloadSize else { return nil }

        let heartRate = payload[payload.startIndex + WhoopBleConstants.realtimeDataHeartRateOffset]
        let quaternionW = payload.readFloat32LE(at: payload.startIndex + WhoopBleConstants.realtimeDataQuaternionWOffset)
        let quaternionX = payload.readFloat32LE(at: payload.startIndex + WhoopBleConstants.realtimeDataQuaternionXOffset)
        let quaternionY = payload.readFloat32LE(at: payload.startIndex + WhoopBleConstants.realtimeDataQuaternionYOffset)
        let quaternionZ = payload.readFloat32LE(at: payload.startIndex + WhoopBleConstants.realtimeDataQuaternionZOffset)

        return WhoopRealtimeDataSample(
            timestampSeconds: frame.dataTimestamp,
            subSeconds: frame.subSeconds,
            heartRate: heartRate,
            quaternionW: quaternionW,
            quaternionX: quaternionX,
            quaternionY: quaternionY,
            quaternionZ: quaternionZ,
            rawPayload: Data(payload)
        )
    }

    /// Sequence counter for command frames (increments per command sent).
    private static var commandSequence: UInt8 = 0x01

    /// Build a complete Maverick command frame to write to CMD_TO_STRAP.
    ///
    /// Frame format (verified against PacketLogger capture byte-for-byte):
    /// ```
    /// Header (8 bytes):
    ///   [SOF: 0xAA] [ver: 0x01] [payloadLen: u16 LE] [role1: 0x00] [role2: 0x01] [CRC16: u16 LE]
    /// Payload (payloadLen bytes):
    ///   [0x23] [seq] [cmd] [params: 01 01 00 00 00] [CRC32: u32 LE]
    /// ```
    ///
    /// - Header CRC16: CRC16-MODBUS of the first 6 header bytes
    /// - Payload CRC32: IEEE 802.3 CRC32 of the command bytes (excluding the CRC32 itself)
    static func buildCommandData(command: UInt8) -> Data {
        let seq = commandSequence
        commandSequence &+= 1

        // Command bytes (before CRC32)
        let commandBytes = Data([
            WhoopBleConstants.packetTypeCommand,  // 0x23
            seq,
            command,
            0x01, 0x01, 0x00, 0x00, 0x00,        // parameters
        ])

        // Payload = command bytes + CRC32 trailer
        let payloadCrc = crc32ieee(commandBytes)
        var payload = commandBytes
        payload.append(UInt8(payloadCrc & 0xFF))
        payload.append(UInt8((payloadCrc >> 8) & 0xFF))
        payload.append(UInt8((payloadCrc >> 16) & 0xFF))
        payload.append(UInt8((payloadCrc >> 24) & 0xFF))

        let payloadLen = UInt16(payload.count)

        // Header (first 6 bytes, before CRC16)
        let headerPrefix = Data([
            WhoopBleConstants.startOfFrame,           // 0xAA
            0x01,                                      // version
            UInt8(payloadLen & 0xFF),                  // payloadLen low
            UInt8(payloadLen >> 8),                    // payloadLen high
            0x00,                                      // role1
            0x01,                                      // role2
        ])

        let headerCrc = crc16modbus(headerPrefix)

        var frame = headerPrefix
        frame.append(UInt8(headerCrc & 0xFF))
        frame.append(UInt8(headerCrc >> 8))
        frame.append(payload)

        return frame
    }

    // MARK: - CRC algorithms

    /// CRC16-MODBUS: polynomial 0xA001 (reflected 0x8005), init 0xFFFF.
    static func crc16modbus(_ data: Data) -> UInt16 {
        var crc: UInt16 = 0xFFFF
        for byte in data {
            crc ^= UInt16(byte)
            for _ in 0..<8 {
                if crc & 1 != 0 {
                    crc = (crc >> 1) ^ 0xA001
                } else {
                    crc >>= 1
                }
            }
        }
        return crc
    }

    /// IEEE 802.3 CRC32 (same as java.util.zip.CRC32).
    static func crc32ieee(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFFFFFF
        for byte in data {
            crc ^= UInt32(byte)
            for _ in 0..<8 {
                if crc & 1 != 0 {
                    crc = (crc >> 1) ^ 0xEDB88320
                } else {
                    crc >>= 1
                }
            }
        }
        return crc ^ 0xFFFFFFFF
    }
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
