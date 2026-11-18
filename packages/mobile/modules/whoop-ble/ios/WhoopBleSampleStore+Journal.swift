extension WhoopBleSampleStore {
    func configureJournal() throws {
        // Small BLE transactions write whole SQLite pages into the WAL.
        let pageSize = 1024
        let storedPageSize: Int = try field("page_size", in: rows("PRAGMA page_size").first ?? [:])
        if storedPageSize != pageSize {
            let pageCount: Int = try field("page_count", in: rows("PRAGMA page_count").first ?? [:])
            if pageCount > 0 {
                // SQLite only changes the page size outside WAL mode. Keep the
                // rebuild durable and use the on-disk page size to resume it.
                try execute("PRAGMA synchronous = EXTRA")
                try setJournalMode("delete")
                try execute("PRAGMA page_size = \(pageSize)")
                try execute("VACUUM")
            } else {
                try execute("PRAGMA page_size = \(pageSize)")
            }
        }
        try setJournalMode("wal")
        try execute("PRAGMA synchronous = FULL")
        guard try field("page_size", in: rows("PRAGMA page_size").first ?? [:]) as Int == pageSize else {
            throw StoreError("WHOOP sample storage could not set the SQLite page size to \(pageSize) bytes")
        }
    }

    private func setJournalMode(_ mode: String) throws {
        let activeMode: String = try field("journal_mode", in: rows("PRAGMA journal_mode = \(mode)").first ?? [:])
        guard activeMode == mode else {
            throw StoreError("WHOOP sample storage could not enter SQLite \(mode) journal mode")
        }
    }
}
