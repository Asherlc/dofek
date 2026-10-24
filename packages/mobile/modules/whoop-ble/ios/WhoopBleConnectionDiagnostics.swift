import Foundation

/// Queue-confined metadata journal. No samples, packet bytes, or credentials are accepted.
final class WhoopBleConnectionDiagnostics {
    private static let historyKey = "com.dofek.whoop-ble.connection-diagnostics"
    private static let capacity = 64
    private let diagnosticDefaults: UserDefaults
    private let now: () -> Date
    private let nativeSessionId = UUID().uuidString
    private let processId = Int(ProcessInfo.processInfo.processIdentifier)
    private let formatter: ISO8601DateFormatter
    private var events: [[String: Any]]
    private var overflowCount: Int

    init(diagnosticDefaults: UserDefaults = .standard, now: @escaping () -> Date = Date.init) {
        self.diagnosticDefaults = diagnosticDefaults
        self.now = now
        formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let retained = diagnosticDefaults.dictionary(forKey: Self.historyKey)
        events = retained?["events"] as? [[String: Any]] ?? []
        overflowCount = retained?["overflowCount"] as? Int ?? 0
    }

    var payload: [String: Any] {
        ["events": events, "overflowCount": overflowCount]
    }

    func record(
        event: String,
        connectionState: String,
        centralState: String,
        reconnectIntent: Bool,
        peripheralId: String? = nil,
        error: Error? = nil,
        reason: String? = nil,
        previousConnectionState: String? = nil,
        restoredPeripheralCount: Int? = nil
    ) {
        var entry: [String: Any] = [
            "eventId": UUID().uuidString,
            "occurredAt": formatter.string(from: now()),
            "nativeSessionId": nativeSessionId,
            "processId": processId,
            "event": event,
            "connectionState": connectionState,
            "centralState": centralState,
            "reconnectIntent": reconnectIntent,
        ]
        entry["peripheralId"] = peripheralId
        entry["reason"] = reason
        entry["previousConnectionState"] = previousConnectionState
        entry["restoredPeripheralCount"] = restoredPeripheralCount
        if let error = error as NSError? {
            entry["errorDomain"] = error.domain
            entry["errorCode"] = error.code
            entry["errorDescription"] = error.localizedDescription
        }
        events.append(entry)
        if events.count > Self.capacity {
            let excess = events.count - Self.capacity
            events.removeFirst(excess)
            overflowCount += excess
        }
        diagnosticDefaults.set(payload, forKey: Self.historyKey)
    }

    func clear() {
        events.removeAll()
        overflowCount = 0
        diagnosticDefaults.removeObject(forKey: Self.historyKey)
    }
}
