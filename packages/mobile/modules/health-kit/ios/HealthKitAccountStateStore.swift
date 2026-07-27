import Foundation

final class HealthKitAccountStateStore {
    static let hasEverAuthorizedKey = "healthkit_has_ever_authorized"
    static let backgroundDeliveryEnabledKey = "healthkit_background_delivery_enabled"
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
        userDefaults.removeObject(forKey: Self.hasEverAuthorizedKey)
        userDefaults.removeObject(forKey: Self.backgroundDeliveryEnabledKey)

        for key in userDefaults.dictionaryRepresentation().keys
            where key.hasPrefix("healthkit_anchor_") {
            userDefaults.removeObject(forKey: key)
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
