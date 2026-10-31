import Foundation

/// Retain the wire record once; new measurement interpretation belongs to the server.
enum WhoopBleSensorRecord {
    /// Erasure covers both observation time and a capture-backed source clock.
    static func erasureTime(sample: [String: Any], receivedAt: Date) -> TimeInterval {
        guard let hex = sample["frameHex"] as? String, hex.count == 248 else { return receivedAt.timeIntervalSince1970 }
        var data = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let end = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<end], radix: 16) else { return receivedAt.timeIntervalSince1970 }
            data.append(byte)
            index = end
        }
        guard let frame = WhoopBleFrameParser.parseFrame(data), frame.packetType == 47,
              frame.recordType == 18, frame.payload[2] == 0x80 else {
            return receivedAt.timeIntervalSince1970
        }
        let sourceTime = TimeInterval(frame.dataTimestamp) + TimeInterval(frame.subSeconds) / 32_768
        return min(receivedAt.timeIntervalSince1970, sourceTime)
    }

    static func serialize(frame: WhoopFrame, deviceInfo: [String: String], receivedAt: Date = Date()) -> [String: Any]? {
        let fullRealtime = frame.packetType == 40 && frame.payload.count >= WhoopBleConstants.realtimeDataMinPayloadSize
        let additionalSensor = [UInt8(43), 47].contains(frame.packetType) && ![UInt8(16), 17, 21].contains(frame.recordType)
        guard fullRealtime || additionalSensor, !frame.rawData.isEmpty else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return [
            "captureId": UUID().uuidString,
            "timestamp": formatter.string(from: receivedAt),
            "frameHex": frame.rawData.map { String(format: "%02x", $0) }.joined(),
            "deviceInfo": deviceInfo,
        ]
    }
}
