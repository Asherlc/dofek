import Foundation

final class CoreMotionAccountStateStore {
    static let lastSyncKey = "com.dofek.coreMotion.lastSyncTimestamp"
    static let recordingActiveKey = "com.dofek.coreMotion.recordingActive"
    static let deviceErasureCutoffKey = "dofek_device_erasure_cutoff_v1"

    private let userDefaults: UserDefaults

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
    }

    var deviceErasureCutoff: Date? {
        userDefaults.object(forKey: Self.deviceErasureCutoffKey) as? Date
    }

    func purge(at cutoff: Date) {
        advanceDeviceErasureCutoff(to: cutoff)
        userDefaults.removeObject(forKey: Self.lastSyncKey)
        userDefaults.removeObject(forKey: Self.recordingActiveKey)
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
