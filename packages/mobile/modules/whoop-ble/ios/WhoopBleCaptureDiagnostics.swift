import Foundation

/// Queue-confined capture metadata. It never retains sensor values or sample payloads.
struct WhoopBleCaptureDiagnostics {
    private var lastDataNotificationAt: Date?
    private var lastParsedImuAt: Date?
    private var lastParsedRealtimeAt: Date?
    private var lastValidHeartRateAt: Date?

    mutating func recordNotification(at observedAt: Date = Date()) {
        lastDataNotificationAt = observedAt
    }

    mutating func recordParsed(
        imuCount: Int,
        realtimeSamples: [WhoopRealtimeDataSample],
        at observedAt: Date = Date()
    ) {
        if imuCount > 0 { lastParsedImuAt = observedAt }
        if !realtimeSamples.isEmpty { lastParsedRealtimeAt = observedAt }
        for sample in realtimeSamples where sample.heartRate > 0 {
            let sampleDate = Date(
                timeIntervalSince1970:
                    TimeInterval(sample.timestampSeconds) + TimeInterval(sample.subSeconds) / 32_768.0
            )
            guard sampleDate.timeIntervalSince1970 >= 946_684_800,
                  sampleDate <= observedAt.addingTimeInterval(300) else { continue }
            lastValidHeartRateAt = lastValidHeartRateAt.map { max($0, sampleDate) } ?? sampleDate
        }
    }

    var payload: [String: Any] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return [
            "lastDataNotificationAt": lastDataNotificationAt.map(formatter.string) ?? NSNull(),
            "lastParsedImuAt": lastParsedImuAt.map(formatter.string) ?? NSNull(),
            "lastParsedRealtimeAt": lastParsedRealtimeAt.map(formatter.string) ?? NSNull(),
            "lastValidHeartRateAt": lastValidHeartRateAt.map(formatter.string) ?? NSNull(),
        ]
    }
}
