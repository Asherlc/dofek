import Foundation

final class WatchMotionAccountStateStore {
    static let syncEnabledKey = "dofek_watch_account_sync_enabled_v1"
    static let deviceErasureCutoffKey = "dofek_device_erasure_cutoff_v1"

    private let userDefaults: UserDefaults

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
    }

    var isSyncEnabled: Bool {
        guard userDefaults.object(forKey: Self.syncEnabledKey) != nil else {
            return true
        }
        return userDefaults.bool(forKey: Self.syncEnabledKey)
    }

    var deviceErasureCutoff: Date? {
        userDefaults.object(forKey: Self.deviceErasureCutoffKey) as? Date
    }

    func enableSync() {
        userDefaults.set(true, forKey: Self.syncEnabledKey)
    }

    func purge(at candidate: Date) {
        let cutoff = deviceErasureCutoff.map { max($0, candidate) } ?? candidate
        userDefaults.set(cutoff, forKey: Self.deviceErasureCutoffKey)
        userDefaults.set(false, forKey: Self.syncEnabledKey)
    }

    func shouldInclude(timestamp: Date) -> Bool {
        guard let deviceErasureCutoff else { return true }
        return timestamp > deviceErasureCutoff
    }
}
