import Foundation

/// A parsed WHOOP BLE frame.
struct WhoopFrame {
    let packetType: UInt8
    let recordType: UInt8
    let dataTimestamp: UInt32     // Unix epoch seconds
    let subSeconds: UInt16
    let payload: Data
}

// MARK: - WHOOP sensor scale factors

/// WHOOP accelerometer: ±8g range, 4096 LSB/g (confirmed from live capture — gravity vector ≈ 4096)
private let whoopAccelerometerScale: Float = 1.0 / 4096.0 // raw int16 → g

/// WHOOP gyroscope: assumed ±2000 dps (16.4 LSB/dps), common for wearable MEMS IMUs.
/// Converted to rad/s: raw / 16.4 * (π / 180)
private let whoopGyroscopeScale: Float = (1.0 / 16.4) * (.pi / 180.0) // raw int16 → rad/s

/// Stateless parser for WHOOP BLE frames and IMU sample extraction.
///
/// Frame format: `[0xAA] [payloadLen: u16 LE] [crc8: u8] [payload...] [crc32: u32 LE]`
///
/// The parser handles BLE notification fragmentation by accumulating bytes
/// across multiple notifications until a complete frame is detected.
final class WhoopBleFrameParser {

    /// Accumulated bytes from BLE notifications (frames may span multiple notifications)
    private var accumulator = Data()

    /// Number of partial frames discarded when a new SOF arrives before the
    /// previous frame was complete. Each drop can represent up to 100 IMU samples.
    private(set) var droppedFrameCount: UInt64 = 0

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
            if let frame = Self.parseFrame(accumulator) {
                frames.append(frame)
            } else {
                // Partial frame discarded — the accumulator had an incomplete frame
                // that couldn't be parsed before the next SOF arrived.
                droppedFrameCount += 1
                NSLog("[WhoopBLE] dropped partial frame (%d bytes, total drops: %llu)",
                      accumulator.count, droppedFrameCount)
            }
            accumulator = Data()
        }

        accumulator.append(data)

        // Try to parse the current accumulator
        if let frame = Self.parseFrame(accumulator) {
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

        if payload.count >= 6 {
            recordType = payload[payload.startIndex + 1]
        }

        // Timestamp location depends on packet type:
        // - 0x28 compact (24 bytes): timestamp at payload offset 2 (u32 LE)
        //   Confirmed: bytes 2-5 = 0x1D45C969 LE = 1774798109 = 2026-03-29T15:28:29Z
        // - Other packets (0x2B, 0x2F, etc.): timestamp at payload offset 7 (u32 LE)
        //   Sub-seconds at offset 11 (u16 LE)
        if packetType == WhoopBleConstants.packetTypeRealtimeData && payload.count >= 6 {
            dataTimestamp = payload.readUInt32LE(at: payload.startIndex + 2)
            // No sub-seconds field in compact format
        } else if payload.count >= 13 {
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
    /// Raw int16 sensor values are normalized to standard physical units:
    /// - Accelerometer: g (1g = Earth gravity)
    /// - Gyroscope: rad/s
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
                    samplesInFrame: count,
                    accelerometerX: Float(payload.readInt16LE(at: offset)) * whoopAccelerometerScale,
                    accelerometerY: Float(payload.readInt16LE(at: offset + 2)) * whoopAccelerometerScale,
                    accelerometerZ: Float(payload.readInt16LE(at: offset + 4)) * whoopAccelerometerScale,
                    gyroscopeX: Float(payload.readInt16LE(at: offset + 6)) * whoopGyroscopeScale,
                    gyroscopeY: Float(payload.readInt16LE(at: offset + 8)) * whoopGyroscopeScale,
                    gyroscopeZ: Float(payload.readInt16LE(at: offset + 10)) * whoopGyroscopeScale
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
                    samplesInFrame: countA,
                    accelerometerX: Float(payload.readInt16LE(at: 20 + sampleIndex * 2)) * whoopAccelerometerScale,
                    accelerometerY: Float(payload.readInt16LE(at: 220 + sampleIndex * 2)) * whoopAccelerometerScale,
                    accelerometerZ: Float(payload.readInt16LE(at: 420 + sampleIndex * 2)) * whoopAccelerometerScale,
                    gyroscopeX: sampleIndex < countB ? Float(payload.readInt16LE(at: 632 + sampleIndex * 2)) * whoopGyroscopeScale : 0,
                    gyroscopeY: sampleIndex < countB ? Float(payload.readInt16LE(at: 832 + sampleIndex * 2)) * whoopGyroscopeScale : 0,
                    gyroscopeZ: sampleIndex < countB ? Float(payload.readInt16LE(at: 1032 + sampleIndex * 2)) * whoopGyroscopeScale : 0
                ))
            }
            return samples
        }

        return []
    }

    // swiftlint:disable function_body_length
    /// Extract a realtime data sample (HR + orientation quaternion) from a 0x28 packet.
    ///
    /// Two payload sizes observed:
    /// - **Full (≥57 bytes)**: HR at offset 22, quaternion at 41-56, optical at 23-40
    /// - **Compact (~24 bytes)**: Minimal format; raw payload preserved for analysis
    ///
    /// Both formats are captured. For compact packets, HR and quaternion fields
    /// are zero but the raw payload is preserved in opticalBytes for decoding.
    static func extractRealtimeData(from frame: WhoopFrame) -> WhoopRealtimeDataSample? {
    // swiftlint:enable function_body_length
        // Handle 0x2F HISTORICAL_DATA record type 18 (116-byte payload)
        // HR at byte 14, R-R at bytes 16-17, quaternion at bytes 33-48
        if frame.packetType == WhoopBleConstants.packetTypeHistoricalData
            && frame.recordType == 18
            && frame.payload.count >= 50 {
            let payload = frame.payload
            let heartRate = payload[payload.startIndex + 14]
            let validFlag = payload[payload.startIndex + 15]
            let rrIntervalMs = validFlag != 0 ? payload.readUInt16LE(at: payload.startIndex + 16) : 0

            let quaternionW = payload.readFloat32LE(at: payload.startIndex + 33)
            let quaternionX = payload.readFloat32LE(at: payload.startIndex + 37)
            let quaternionY = payload.readFloat32LE(at: payload.startIndex + 41)
            let quaternionZ = payload.readFloat32LE(at: payload.startIndex + 45)

            var opticalBytes = Data(count: WhoopBleConstants.realtimeDataOpticalByteCount)
            // Preserve bytes 14-31 (HR + R-R + surrounding data) for analysis
            let dataStart = payload.startIndex + 14
            let copyLen = min(payload.endIndex - dataStart, opticalBytes.count)
            if copyLen > 0 {
                opticalBytes.replaceSubrange(0..<copyLen, with: payload[dataStart..<(dataStart + copyLen)])
            }

            return WhoopRealtimeDataSample(
                timestampSeconds: frame.dataTimestamp,
                subSeconds: frame.subSeconds,
                heartRate: heartRate,
                rrIntervalMs: rrIntervalMs,
                quaternionW: quaternionW,
                quaternionX: quaternionX,
                quaternionY: quaternionY,
                quaternionZ: quaternionZ,
                opticalBytes: opticalBytes
            )
        }

        guard frame.packetType == WhoopBleConstants.packetTypeRealtimeData else { return nil }

        let payload = frame.payload
        // Need at least the 13-byte common header (type + record + timestamp + subseconds)
        guard payload.count >= 13 else { return nil }

        // Full-size payload (≥57 bytes): extract HR, quaternion, and optical bytes
        if payload.count >= WhoopBleConstants.realtimeDataMinPayloadSize {
            let heartRate = payload[payload.startIndex + WhoopBleConstants.realtimeDataHeartRateOffset]

            let opticalStart = payload.startIndex + WhoopBleConstants.realtimeDataOpticalStartOffset
            let opticalEnd = opticalStart + WhoopBleConstants.realtimeDataOpticalByteCount
            let opticalBytes: Data
            if opticalEnd <= payload.endIndex {
                opticalBytes = Data(payload[opticalStart..<opticalEnd])
            } else {
                opticalBytes = Data(count: WhoopBleConstants.realtimeDataOpticalByteCount)
            }

            let quaternionW = payload.readFloat32LE(at: payload.startIndex + WhoopBleConstants.realtimeDataQuaternionWOffset)
            let quaternionX = payload.readFloat32LE(at: payload.startIndex + WhoopBleConstants.realtimeDataQuaternionXOffset)
            let quaternionY = payload.readFloat32LE(at: payload.startIndex + WhoopBleConstants.realtimeDataQuaternionYOffset)
            let quaternionZ = payload.readFloat32LE(at: payload.startIndex + WhoopBleConstants.realtimeDataQuaternionZOffset)

            return WhoopRealtimeDataSample(
                timestampSeconds: frame.dataTimestamp,
                subSeconds: frame.subSeconds,
                heartRate: heartRate,
                rrIntervalMs: 0, // not yet mapped in full-size format
                quaternionW: quaternionW,
                quaternionX: quaternionX,
                quaternionY: quaternionY,
                quaternionZ: quaternionZ,
                opticalBytes: opticalBytes
            )
        }

        // Compact payload (24 bytes, record type 0x02):
        //   [0] 0x28 packet type
        //   [1] 0x02 record type
        //   [2] sequence counter (u8, increments per packet)
        //   [3-7] device/session identifiers (constant per session)
        //   [8] heart rate (bpm) — confirmed from PacketLogger capture (60-62 bpm range)
        //   [9] flag (0x01 = valid reading, 0x00 = no reading)
        //   [10-11] u16 LE — likely PPG ADC value or R-R interval in ms (~900-1010)
        //   [12-17] zeros (reserved)
        //   [18] constant 0x01
        //   [19] constant 0x00
        //   [20-23] CRC32 or checksum (changes every packet)
        guard payload.count >= 12 else { return nil }

        let heartRate = payload[payload.startIndex + 8]
        let validFlag = payload[payload.startIndex + 9]
        let rrIntervalMs = validFlag != 0 ? payload.readUInt16LE(at: payload.startIndex + 10) : 0

        // Preserve the full payload after header for analysis
        var opticalBytes = Data(count: WhoopBleConstants.realtimeDataOpticalByteCount)
        let dataStart = payload.startIndex + 8
        let copyLen = min(payload.endIndex - dataStart, opticalBytes.count)
        if copyLen > 0 {
            opticalBytes.replaceSubrange(0..<copyLen, with: payload[dataStart..<(dataStart + copyLen)])
        }

        return WhoopRealtimeDataSample(
            timestampSeconds: frame.dataTimestamp,
            subSeconds: frame.subSeconds,
            heartRate: heartRate,
            rrIntervalMs: rrIntervalMs,
            quaternionW: 0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
            opticalBytes: opticalBytes
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
