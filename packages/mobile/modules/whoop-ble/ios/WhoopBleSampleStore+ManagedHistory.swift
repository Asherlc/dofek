import Foundation

extension WhoopBleSampleStore {
    static let managedHistoryKeyPrefix = "managed-history:"

    func isManagedHistoryEnabled(for peripheralId: UUID) throws -> Bool {
        try synchronized {
            try metadata(Self.managedHistoryKeyPrefix + peripheralId.uuidString) == "1"
        }
    }

    func setManagedHistoryEnabled(_ enabled: Bool, for peripheralId: UUID) throws {
        try transaction {
            guard try readBinding() != nil else {
                throw StoreError("Configure an authenticated WHOOP account before changing history sync")
            }
            let key = Self.managedHistoryKeyPrefix + peripheralId.uuidString
            if enabled {
                try setMetadata(key, "1")
            } else {
                try execute("DELETE FROM metadata WHERE key = ?", [key])
            }
        }
    }
}
