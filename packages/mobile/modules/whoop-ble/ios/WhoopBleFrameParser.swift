import Foundation

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

    /// Counter for debugging feed calls
    private var feedCount: UInt64 = 0

    /// Feed raw BLE notification data into the parser.
    /// Returns any complete frames that were assembled.
    func feed(_ data: Data) -> [WhoopFrame] {
        feedCount += 1
        var frames: [WhoopFrame] = []

        // If this notification starts with SOF and we have accumulated data,
        // try to parse the accumulated frame first
        if !data.isEmpty && data[0] == WhoopBleConstants.startOfFrame && !accumulator.isEmpty {
            if let frame = WhoopBleFrameParser.parseFrame(accumulator) {
                frames.append(frame)
            } else if feedCount <= 20 {
                let accHex = accumulator.prefix(32).map { String(format: "%02x", $0) }.joined(separator: " ")
                NSLog("[WhoopBLE] feed #%llu: SOF in new data, old accumulator (%d bytes) failed to parse (first 32: %@)", feedCount, accumulator.count, accHex)
            }
            accumulator = Data()
        }

        accumulator.append(data)

        // Try to parse the current accumulator
        if let frame = WhoopBleFrameParser.parseFrame(accumulator) {
            frames.append(frame)
            if feedCount <= 20 {
                NSLog("[WhoopBLE] feed #%llu: parsed frame type=0x%02x record=%d payload=%d bytes", feedCount, frame.packetType, frame.recordType, frame.payload.count)
            }
            // Advance past the consumed frame, preserving any trailing bytes
            // that belong to the next frame (header + payload + CRC32)
            let payloadLen = Int(accumulator[1]) | (Int(accumulator[2]) << 8)
            let consumed = min(
                WhoopBleConstants.headerSize + payloadLen + 4,
                accumulator.count
            )
            if consumed < accumulator.count {
                accumulator = Data(accumulator[consumed...])
            } else {
                accumulator = Data()
            }
        } else if feedCount <= 20 {
            let accHex = accumulator.prefix(32).map { String(format: "%02x", $0) }.joined(separator: " ")
            NSLog("[WhoopBLE] feed #%llu: accumulator %d bytes, no complete frame yet (first 32: %@)", feedCount, accumulator.count, accHex)
        }

        return frames
    }

    // MARK: - Static parsing (testable without BLE)

    /// Parse a single WHOOP frame from raw bytes.
    ///
    /// Frame format:
    /// ```
    /// [0xAA]              1 byte   Start-of-frame
    /// [payloadLen]        2 bytes  Little-endian u16
    /// [crc8]              1 byte   Header checksum
    /// [payload...]        N bytes  Payload (packetType at offset 0)
    /// [crc32]             4 bytes  Little-endian u32 (over all preceding bytes)
    /// ```
    static func parseFrame(_ data: Data) -> WhoopFrame? {
        guard data.count >= WhoopBleConstants.minimumFrameSize else { return nil }
        guard data[0] == WhoopBleConstants.startOfFrame else { return nil }

        let payloadLen = Int(data[1]) | (Int(data[2]) << 8) // u16 LE
        let headerSize = WhoopBleConstants.headerSize

        // Require the full payload before accepting the frame.
        // This prevents premature parsing when BLE notifications fragment
        // a large frame across multiple packets. We tolerate a missing CRC32
        // trailer (4 bytes) since we don't validate it.
        guard data.count >= headerSize + payloadLen else { return nil }

        let payloadEnd = min(headerSize + payloadLen, data.count)
        let payload = data[headerSize..<payloadEnd]

        guard !payload.isEmpty else { return nil }

        let packetType = payload[payload.startIndex]

        var recordType: UInt8 = 0
        var dataTimestamp: UInt32 = 0
        var subSeconds: UInt16 = 0

        // Data packets with standard header (13+ bytes in payload)
        if payload.count >= 13 {
            recordType = payload[payload.startIndex + 1]
            dataTimestamp = payload.readUInt32LE(at: payload.startIndex + 3)
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

        // R21 Maverick raw packet (type 0x2B, record type 21, ~1244 bytes)
        if frame.packetType == WhoopBleConstants.packetTypeRealtimeRawData &&
           frame.recordType == 21 &&
           payload.count >= 1244 {

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

    /// Build a command frame to write to CMD_TO_STRAP.
    ///
    /// Constructs a minimal WHOOP command frame:
    /// ```
    /// [0xAA] [0x02 0x00] [0x00] [0x23 commandByte]
    /// ```
    /// Note: CRC is omitted for simplicity — the strap accepts commands without
    /// strict CRC validation based on observed behavior in captures.
    static func buildCommandData(command: UInt8) -> Data {
        var data = Data()
        data.append(WhoopBleConstants.startOfFrame)  // SOF
        data.append(0x02)                              // payload length low byte
        data.append(0x00)                              // payload length high byte
        data.append(0x00)                              // header CRC8 (placeholder)
        data.append(WhoopBleConstants.packetTypeCommand)  // 0x23 = COMMAND
        data.append(command)                           // the actual command byte
        return data
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
}
