import Foundation

/// Converts captured protocol fields to the existing ingestion API's raw sample contract.
enum WhoopBleSampleSerializer {
    static func imu(_ samples: [WhoopImuSample]) -> [[String: Any]] {
        let formatter = timestampFormatter()
        return samples.map { sample in
            let interval = sample.samplesInFrame > 0 ? 1.0 / Double(sample.samplesInFrame) : 0.01
            let time = bounded(timestamp(sample.timestampSeconds, sample.subSeconds) + Double(sample.sampleIndex) * interval)
            return [
                "timestamp": formatter.string(from: Date(timeIntervalSince1970: time)),
                "x": Double(sample.accelerometerX), "y": Double(sample.accelerometerY),
                "z": Double(sample.accelerometerZ), "gyroscopeX": Double(sample.gyroscopeX),
                "gyroscopeY": Double(sample.gyroscopeY), "gyroscopeZ": Double(sample.gyroscopeZ),
            ]
        }
    }

    static func realtime(_ samples: [WhoopRealtimeDataSample]) -> [[String: Any]] {
        let formatter = timestampFormatter()
        return samples.map { sample in
            let time = bounded(timestamp(sample.timestampSeconds, sample.subSeconds))
            return [
                "timestamp": formatter.string(from: Date(timeIntervalSince1970: time)),
                "heartRateBpm": Int(sample.heartRate), "rrIntervalMs": Int(sample.rrIntervalMs),
                "quaternionW": Double(sample.quaternionW), "quaternionX": Double(sample.quaternionX),
                "quaternionY": Double(sample.quaternionY), "quaternionZ": Double(sample.quaternionZ),
                "opticalRawHex": sample.opticalBytes.map { String(format: "%02x", $0) }.joined(),
            ]
        }
    }

    private static func timestamp(_ seconds: UInt32, _ fractions: UInt16) -> TimeInterval {
        TimeInterval(seconds) + TimeInterval(fractions) / 32_768.0
    }

    private static func bounded(_ time: TimeInterval) -> TimeInterval {
        min(max(time, 946_684_800), Date().addingTimeInterval(300).timeIntervalSince1970)
    }

    private static func timestampFormatter() -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }
}
