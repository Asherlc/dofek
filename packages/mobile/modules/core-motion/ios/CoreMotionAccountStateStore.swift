import Foundation

final class CoreMotionAccountStateStore {
    static let lastSyncKey = "com.dofek.coreMotion.lastSyncTimestamp"
    static let recordingDeadlineKey = "com.dofek.coreMotion.recordingDeadline"
    static let maximumRecordingDuration: TimeInterval = 12 * 3600
    static let deviceErasureCutoffKey = "dofek_device_erasure_cutoff_v1"

    private let userDefaults: UserDefaults
    private let now: () -> Date

    init(userDefaults: UserDefaults = .standard, now: @escaping () -> Date = Date.init) {
        self.userDefaults = userDefaults
        self.now = now
    }

    var deviceErasureCutoff: Date? {
        userDefaults.object(forKey: Self.deviceErasureCutoffKey) as? Date
    }

    var isRecordingActive: Bool {
        guard let deadline = userDefaults.object(forKey: Self.recordingDeadlineKey) as? Date else {
            return false
        }
        return deadline > now()
    }

    func recordingStarted(forDuration duration: TimeInterval, authorized: Bool) {
        guard authorized else {
            userDefaults.removeObject(forKey: Self.recordingDeadlineKey)
            return
        }
        userDefaults.set(
            now().addingTimeInterval(min(duration, Self.maximumRecordingDuration)),
            forKey: Self.recordingDeadlineKey
        )
    }

    func purge(at cutoff: Date) {
        advanceDeviceErasureCutoff(to: cutoff)
        userDefaults.removeObject(forKey: Self.lastSyncKey)
        userDefaults.removeObject(forKey: Self.recordingDeadlineKey)
    }

    func effectiveSyncStart(_ storedCursor: Date?) -> Date? {
        switch (storedCursor, deviceErasureCutoff) {
        case let (cursor?, cutoff?):
            return max(cursor, cutoff)
        case let (cursor?, nil):
            return cursor
        case let (nil, cutoff?):
            return cutoff
        case (nil, nil):
            return nil
        }
    }

    func shouldInclude(sampleDate: Date) -> Bool {
        guard let deviceErasureCutoff else {
            return true
        }
        return sampleDate > deviceErasureCutoff
    }

    private func advanceDeviceErasureCutoff(to candidate: Date) {
        guard deviceErasureCutoff.map({ candidate > $0 }) ?? true else {
            return
        }
        userDefaults.set(candidate, forKey: Self.deviceErasureCutoffKey)
    }
}
