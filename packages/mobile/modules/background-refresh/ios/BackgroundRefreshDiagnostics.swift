import Foundation

/// Only lifecycle metadata can enter the persisted journal.
struct BackgroundRefreshDiagnosticFields {
    var taskId: String?
    var taskIdentifier: String?
    var earliestBeginAt: Date?
    var success: Bool?
    var reason: String?
    var backgroundRefreshStatus: String?
    var lowPowerModeEnabled: Bool?
    var error: Error?
}

/// Thread-safe, metadata-only history. Reading never consumes retained events.
final class BackgroundRefreshDiagnostics: @unchecked Sendable {
    static let shared = BackgroundRefreshDiagnostics()
    private static let historyKey = "com.dofek.background-refresh.diagnostics"
    private static let capacity = 64
    private let userDefaults: UserDefaults
    private let now: () -> Date
    private let nativeSessionId = UUID().uuidString
    private let processId = Int(ProcessInfo.processInfo.processIdentifier)
    private let lock = NSLock()
    private var events: [[String: Any]]
    private var overflowCount: Int

    init(userDefaults: UserDefaults = .standard, now: @escaping () -> Date = Date.init) {
        self.userDefaults = userDefaults
        self.now = now
        let retained = userDefaults.dictionary(forKey: Self.historyKey)
        let history = retained?["events"] as? [[String: Any]] ?? []
        events = Array(history.suffix(Self.capacity))
        overflowCount = (retained?["overflowCount"] as? Int ?? 0) + max(0, history.count - Self.capacity)
    }

    var payload: [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        return ["events": events, "overflowCount": overflowCount]
    }

    func record(_ event: String, fields: BackgroundRefreshDiagnosticFields = .init()) {
        // Evaluate the clock outside the state lock; no external callbacks run while locked.
        let date = now()
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var entry: [String: Any] = [
            "eventId": UUID().uuidString,
            "occurredAt": formatter.string(from: date),
            "nativeSessionId": nativeSessionId,
            "processId": processId,
            "event": event,
        ]
        entry["taskId"] = fields.taskId.flatMap { UUID(uuidString: $0)?.uuidString }
        entry["taskIdentifier"] = fields.taskIdentifier
        entry["earliestBeginAt"] = fields.earliestBeginAt.map { formatter.string(from: $0) }
        entry["success"] = fields.success
        entry["reason"] = fields.reason
        entry["backgroundRefreshStatus"] = fields.backgroundRefreshStatus
        entry["lowPowerModeEnabled"] = fields.lowPowerModeEnabled
        if let error = fields.error as NSError? {
            entry["errorDomain"] = error.domain
            entry["errorCode"] = error.code
            entry["errorDescription"] = error.localizedDescription
        }
        lock.lock()
        defer { lock.unlock() }
        events.append(entry)
        if events.count > Self.capacity {
            let excess = events.count - Self.capacity
            events.removeFirst(excess)
            overflowCount += excess
        }
        userDefaults.set(["events": events, "overflowCount": overflowCount], forKey: Self.historyKey)
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        events.removeAll()
        overflowCount = 0
        userDefaults.removeObject(forKey: Self.historyKey)
    }
}
