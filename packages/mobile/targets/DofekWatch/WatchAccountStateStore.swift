import Foundation

final class WatchAccountStateStore {
    static let syncEnabledKey = "dofek_watch_account_sync_enabled_v1"
    static let deviceErasureCutoffKey = "dofek_device_erasure_cutoff_v1"

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

    func enableSync() {
        defaults.set(true, forKey: Self.syncEnabledKey)
    }

    func purge(at candidate: Date) {
        let cutoff = deviceErasureCutoff.map { max($0, candidate) } ?? candidate
        defaults.set(cutoff, forKey: Self.deviceErasureCutoffKey)
        defaults.set(false, forKey: Self.syncEnabledKey)
    }
}
