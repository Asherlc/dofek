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
        authorized: Bool
    ) -> [String: TimeInterval] {
        let inactive: [String: TimeInterval] = ["recordingStartedAt": 0, "recordingUntil": 0]
        guard recorderAvailable, authorized else {
            clearRecording()
            return inactive
        }
        guard isRecordingActive(at: now), let deadline = recordingDeadline else {
            return inactive
        }
        return [
            "recordingStartedAt": deadline.addingTimeInterval(-Self.maximumRecordingDuration)
                .timeIntervalSince1970,
            "recordingUntil": deadline.timeIntervalSince1970,
        ]
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
