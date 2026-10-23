import Foundation

final class WatchAccountStateStore {
    static let syncEnabledKey = "dofek_watch_account_sync_enabled_v1"
    static let deviceErasureCutoffKey = "dofek_device_erasure_cutoff_v1"
    static let recordingDeadlineKey = "com.dofek.watch.accelerometer.recordingDeadline"
    static let maximumRecordingDuration: TimeInterval = 12 * 3600

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var isSyncEnabled: Bool {
        guard defaults.object(forKey: Self.syncEnabledKey) != nil else { return true }
        return defaults.bool(forKey: Self.syncEnabledKey)
    }

    var deviceErasureCutoff: Date? {
        defaults.object(forKey: Self.deviceErasureCutoffKey) as? Date
    }

    var recordingDeadline: Date? {
        defaults.object(forKey: Self.recordingDeadlineKey) as? Date
    }

    func isRecordingActive(at now: Date = Date()) -> Bool {
        isSyncEnabled && recordingDeadline.map { $0 > now } == true
    }

    func recordRecording(until deadline: Date) {
        guard isSyncEnabled else { return }
        defaults.set(deadline, forKey: Self.recordingDeadlineKey)
    }

    func recordingContext(
        at now: Date,
        recorderAvailable: Bool,
        authorized: Bool,
        gyroscopeStartedAt: Date?,
        altimeterStartedAt: Date?
    ) -> [String: TimeInterval] {
        var context: [String: TimeInterval] = [
            "recordingStartedAt": 0, "recordingUntil": 0,
            "gyroscopeStartedAt": 0, "altimeterStartedAt": 0,
        ]
        guard isSyncEnabled else { return context }
        context["gyroscopeStartedAt"] = recordingTimestamp(gyroscopeStartedAt, at: now)
        context["altimeterStartedAt"] = recordingTimestamp(altimeterStartedAt, at: now)
        guard recorderAvailable, authorized else {
            clearRecording()
            return context
        }
        guard isRecordingActive(at: now), let deadline = recordingDeadline else {
            return context
        }
        let startedAt = recordingTimestamp(
            deadline.addingTimeInterval(-Self.maximumRecordingDuration), at: now
        )
        guard startedAt > 0 else { return context }
        context["recordingStartedAt"] = startedAt
        context["recordingUntil"] = deadline.timeIntervalSince1970
        return context
    }

    private func recordingTimestamp(_ startedAt: Date?, at now: Date) -> TimeInterval {
        guard let startedAt else { return 0 }
        let timestamp = startedAt.timeIntervalSince1970
        guard timestamp.isFinite, timestamp > 0, startedAt <= now else { return 0 }
        if let cutoff = deviceErasureCutoff, startedAt <= cutoff { return 0 }
        return timestamp
    }

    func clearRecording() {
        defaults.removeObject(forKey: Self.recordingDeadlineKey)
    }

    func enableSync() {
        defaults.set(true, forKey: Self.syncEnabledKey)
    }

    func purge(at candidate: Date) {
        let cutoff = deviceErasureCutoff.map { max($0, candidate) } ?? candidate
        defaults.set(cutoff, forKey: Self.deviceErasureCutoffKey)
        defaults.set(false, forKey: Self.syncEnabledKey)
        clearRecording()
    }
}
