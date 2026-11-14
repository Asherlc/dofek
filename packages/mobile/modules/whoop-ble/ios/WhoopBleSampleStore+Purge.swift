import Foundation

extension WhoopBleSampleStore {
    /// Stage observers must not re-enter the store.
    func purge(onStage: (String) -> Void = { _ in }) throws {
        onStage("store_lock_wait")
        try synchronized {
            try restoreSecureDeleteLocked()
            if try metadata("purge_pending") != nil {
                try finishPendingPurgeLocked(onStage: onStage)
                return
            }
            try transactionLocked(onStage: onStage) {
                secureDeleteToRestore = try field("secure_delete", in: rows("PRAGMA secure_delete").first ?? [:])
                do {
                    try execute("PRAGMA secure_delete = FAST")
                    try setMetadata("purge_pending", "1")
                    try purgeLocked(onStage: onStage)
                } catch {
                    try restoreSecureDeleteLocked()
                    throw error
                }
                try restoreSecureDeleteLocked()
            }
            try finishPendingPurgeLocked(onStage: onStage)
        }
    }

    func restoreSecureDeleteLocked() throws {
        guard let mode = secureDeleteToRestore else { return }
        try execute("PRAGMA secure_delete = \(mode == 2 ? "FAST" : String(mode))")
        secureDeleteToRestore = nil
    }

    func finishPendingPurgeLocked(onStage: (String) -> Void = { _ in }) throws {
        guard try metadata("purge_pending") != nil else { return }
        onStage("store_vacuum")
        try execute("VACUUM")
        guard let checkpoint = try rows("PRAGMA wal_checkpoint(TRUNCATE)").first,
              try field("busy", in: checkpoint) as Int == 0 else {
            throw StoreError("WHOOP sample storage could not checkpoint the purged queue")
        }
        try execute("DELETE FROM metadata WHERE key = ?", ["purge_pending"])
    }

    func purgeLocked(onStage: (String) -> Void = { _ in }) throws {
        onStage("store_reset_stats")
        try execute("UPDATE stats SET received = 0, confirmed = 0, erased = 0, cleared = 0, lastConfirmed = NULL")
        onStage("store_delete_samples")
        try execute("DELETE FROM samples")
        onStage("store_delete_batches")
        try execute("DELETE FROM batches")
        onStage("store_clear_binding")
        try execute("DELETE FROM metadata WHERE key = ?", ["binding"])
        onStage("store_rotate_generation")
        try setMetadata("generation", UUID().uuidString)
    }
}
