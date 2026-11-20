import Foundation
import SQLite3

enum WhoopUploadStream: String, CaseIterable {
    case imu, realtime, sensorRecords

    var batchLimit: Int { self == .sensorRecords ? 16 : 500 }
    var bodyLimit: Int { self == .sensorRecords ? 262_144 : Int.max }
    var route: String {
        switch self {
        case .imu: return "inertialMeasurementUnitSync.pushSamples"
        case .realtime: return "whoopBleSync.pushRealtimeData"
        case .sensorRecords: return "whoopBleSync.pushSensorRecords"
        }
    }
}

struct WhoopUploadBinding: Codable, Equatable {
    let userId: String
    let serverURL: String
}

struct WhoopStoredBatch {
    let id: String
    let generation: String
    let binding: WhoopUploadBinding
    let stream: WhoopUploadStream
    let deviceId: String
    let body: Data
    let sampleCount: Int
}

struct WhoopSQLiteWriteMeasurement: Equatable {
    let walPagesWritten: Int
    let walPagesSpilled: Int

    func delta(since previous: Self) -> Self? {
        guard walPagesWritten >= previous.walPagesWritten,
              walPagesSpilled >= previous.walPagesSpilled else { return nil }
        return Self(
            walPagesWritten: walPagesWritten - previous.walPagesWritten,
            walPagesSpilled: walPagesSpilled - previous.walPagesSpilled
        )
    }
}

enum WhoopCleanupAttribute {
    case string(String)
    case integer(Int)
}

struct WhoopCleanupStage {
    let name: String
    let attributes: [String: WhoopCleanupAttribute]

    init(_ name: String, attributes: [String: WhoopCleanupAttribute] = [:]) {
        self.name = name
        self.attributes = attributes
    }
}

typealias WhoopCleanupStageHandler = (WhoopCleanupStage) -> Void

/// The database owns samples and reservations. Transport files are disposable projections.
final class WhoopBleSampleStore {
    private var database: OpaquePointer?

    var cacheWritePages: Int? {
        guard let database else { return nil }
        var current: Int32 = 0
        var highwater: Int32 = 0
        guard sqlite3_db_status(database, SQLITE_DBSTATUS_CACHE_WRITE, &current, &highwater, 0) == SQLITE_OK else { return nil }
        return Int(current)
    }
    var secureDeleteToRestore: Int?
    private let lock = NSLock()
    let formatter: ISO8601DateFormatter = {
        let value = ISO8601DateFormatter()
        value.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return value
    }()
    struct StoreError: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    let inboxEncoder: PropertyListEncoder = {
        let encoder = PropertyListEncoder()
        encoder.outputFormat = .binary
        return encoder
    }()
    let inboxDecoder = PropertyListDecoder()

    init(directory: URL, skipInboxCutoffReconciliation: Bool = false) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var directory = directory
        var resources = URLResourceValues()
        resources.isExcludedFromBackup = true
        try directory.setResourceValues(resources)
        #if os(iOS)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path
        )
        #endif
        let path = directory.appendingPathComponent("samples.sqlite").path
        guard sqlite3_open_v2(path, &database, SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            let message = database.map { String(cString: sqlite3_errmsg($0)) } ?? "Cannot open WHOOP sample database"
            sqlite3_close(database)
            database = nil
            throw StoreError(message)
        }
        sqlite3_busy_timeout(database, 5000)
        do {
            try prepareDatabase(skipInboxCutoffReconciliation: skipInboxCutoffReconciliation)
            #if os(iOS)
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: path
            )
            #endif
        } catch {
            sqlite3_close(database)
            database = nil
            throw error
        }
    }

    deinit { sqlite3_close(database) }

    private func prepareDatabase(skipInboxCutoffReconciliation: Bool) throws {
        try configureJournal()
        try execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        try execute("""
            CREATE TABLE IF NOT EXISTS samples (
                id INTEGER PRIMARY KEY, stream TEXT NOT NULL, device TEXT NOT NULL,
                timestamp REAL NOT NULL, payload BLOB NOT NULL, batch TEXT)
            """)
        // Staging inbox: one compressed row per retained stream of one notification.
        // No secondary indexes; promotion drains it in rowid order into `samples`.
        try execute("""
            CREATE TABLE IF NOT EXISTS incoming_samples (
                id INTEGER PRIMARY KEY, stream TEXT NOT NULL, device TEXT NOT NULL,
                count INTEGER NOT NULL, oldest REAL NOT NULL, newest REAL NOT NULL, payload BLOB NOT NULL)
            """)
        // Older binaries rotate ownership with INSERT OR REPLACE on this key.
        // Fencing the inbox here prevents their staged rows surviving a downgrade.
        try execute("""
            CREATE TRIGGER IF NOT EXISTS incoming_samples_clear_on_generation
            AFTER INSERT ON metadata WHEN NEW.key = 'generation'
            BEGIN DELETE FROM incoming_samples; END
            """)
        try execute("CREATE INDEX IF NOT EXISTS samples_stream_device ON samples(stream, device, id)")
        try execute("CREATE INDEX IF NOT EXISTS samples_stream_id ON samples(stream, id)")
        try execute("CREATE INDEX IF NOT EXISTS samples_timestamp ON samples(timestamp)")
        try execute("CREATE INDEX IF NOT EXISTS samples_stream_timestamp ON samples(stream, timestamp)")
        try execute("CREATE INDEX IF NOT EXISTS samples_batch ON samples(batch) WHERE batch IS NOT NULL")
        try execute("""
            CREATE TABLE IF NOT EXISTS batches (
                id TEXT PRIMARY KEY, generation TEXT NOT NULL, stream TEXT NOT NULL UNIQUE,
                device TEXT NOT NULL, body BLOB NOT NULL, count INTEGER NOT NULL)
            """)
        try execute("""
            CREATE TABLE IF NOT EXISTS stats (
                stream TEXT PRIMARY KEY, received INTEGER NOT NULL DEFAULT 0,
                confirmed INTEGER NOT NULL DEFAULT 0, erased INTEGER NOT NULL DEFAULT 0,
                cleared INTEGER NOT NULL DEFAULT 0, lastConfirmed REAL)
            """)
        for stream in WhoopUploadStream.allCases {
            try execute("INSERT OR IGNORE INTO stats(stream) VALUES (?)", [stream.rawValue])
        }
        if try metadata("generation") == nil { try setMetadata("generation", UUID().uuidString) }
        try finishPendingPurgeLocked()
        // A previous binary could advance the durable cutoff without knowing
        // about the inbox. Reconcile staged rows before any read or reservation.
        // Cold whole-account cleanup skips this: it purges staged rows without
        // decoding them and must not fail on a corrupt chunk first.
        if !skipInboxCutoffReconciliation,
           let cutoff = try metadata("cutoff").flatMap(Double.init) {
            try transaction { try applyInboxErasure(cutoff: cutoff) }
        }
    }

    var binding: WhoopUploadBinding? { get throws { try synchronized { try readBinding() } } }
    var generation: String { get throws { try synchronized { try currentGeneration() } } }

    func configure(_ binding: WhoopUploadBinding) throws {
        try transaction {
            guard try readBinding() != binding else { return }
            try purgeLocked()
            let data = try JSONEncoder().encode(binding)
            guard let value = String(data: data, encoding: .utf8) else { throw StoreError("Cannot encode WHOOP account binding") }
            try setMetadata("binding", value)
        }
    }

    func reserve(
        stream: WhoopUploadStream,
        limit: Int = 500,
        includeInbox: Bool = true,
        reportWrites: ((WhoopSQLiteWriteMeasurement?) -> Void)? = nil
    ) throws -> WhoopStoredBatch? {
        // Promotion runs before the measured transaction so staging writes never
        // contaminate reservation-only write telemetry. An existing reservation or
        // a nonpositive limit must never wait on an unreadable inbox.
        if includeInbox {
            let shouldDrain = try synchronized {
                guard limit > 0, try readBinding() != nil else { return false }
                let batches = try readBatches()
                return !batches.contains { $0.stream == stream }
            }
            if shouldDrain { try drainInbox() }
        }
        var reserved = false
        let measurementCallback: ((WhoopSQLiteWriteMeasurement?) -> Void)?
        if let reportWrites {
            measurementCallback = { measurement in
                if reserved { reportWrites(measurement) }
            }
        } else {
            measurementCallback = nil
        }
        return try transaction(reportWrites: measurementCallback) {
            if let existing = try readBatches().first(where: { $0.stream == stream }) { return existing }
            guard limit > 0, let binding = try readBinding() else { return nil }
            let head = try rows("SELECT device FROM samples WHERE stream = ? ORDER BY id LIMIT 1", [stream.rawValue])
            guard let first = head.first else { return nil }
            let device: String = try field("device", in: first)
            let candidates = try rows(
                "SELECT id, payload FROM samples WHERE stream = ? AND device = ? ORDER BY id LIMIT ?",
                [stream.rawValue, device, min(limit, stream.batchLimit)]
            )
            var selected: [[String: Any]] = []
            var payloadBytes = 0
            for candidate in candidates {
                let payload: Data = try field("payload", in: candidate)
                guard payloadBytes + payload.count + selected.count + 2048 <= stream.bodyLimit else { break }
                selected.append(candidate)
                payloadBytes += payload.count
            }
            guard !selected.isEmpty else { throw StoreError("WHOOP sensor record exceeds the upload body limit") }
            let id = UUID().uuidString
            let generation = try currentGeneration()
            let payloads = try selected.map { row -> Any in
                let payload: Data = try field("payload", in: row)
                return try JSONSerialization.jsonObject(with: payload)
            }
            var input: [String: Any] = [
                "deviceId": device, "samples": payloads,
                "telemetry": ["batchId": id, "bufferInstanceId": generation],
            ]
            if stream == .imu { input["deviceType"] = "whoop" }
            let body = try JSONSerialization.data(withJSONObject: input, options: [.sortedKeys])
            guard body.count <= stream.bodyLimit else { throw StoreError("WHOOP upload body exceeds its size limit") }
            try execute("INSERT INTO batches VALUES (?, ?, ?, ?, ?, ?)", [id, generation, stream.rawValue, device, body, selected.count])
            for row in selected {
                let rowId: Int = try field("id", in: row)
                try execute("UPDATE samples SET batch = ? WHERE id = ?", [id, rowId])
            }
            reserved = true
            return WhoopStoredBatch(
                id: id, generation: generation, binding: binding, stream: stream,
                deviceId: device, body: body, sampleCount: selected.count
            )
        }
    }

    @discardableResult
    func acknowledge(id: String, generation: String) throws -> Bool {
        try transaction {
            guard try currentGeneration() == generation,
                  let batch = try readBatches().first(where: { $0.id == id && $0.generation == generation }) else { return false }
            try execute("DELETE FROM samples WHERE batch = ?", [id])
            try execute("DELETE FROM batches WHERE id = ?", [id])
            try execute(
                "UPDATE stats SET confirmed = confirmed + ?, lastConfirmed = ? WHERE stream = ?",
                [batch.sampleCount, Date().timeIntervalSince1970, batch.stream.rawValue]
            )
            return true
        }
    }

    func pendingBatches() throws -> [WhoopStoredBatch] { try synchronized { try readBatches() } }
    func advanceErasureCutoff(to date: Date, discardInbox: Bool = false) throws {
        try transaction {
            let cutoff = max(try metadata("cutoff").flatMap(Double.init) ?? -Double.greatestFiniteMagnitude, date.timeIntervalSince1970)
            try setMetadata("cutoff", String(cutoff))
            // Whole-account erase covers every staged row without decoding it;
            // indexed rows still use the supplied real cutoff.
            try applyInboxErasure(cutoff: discardInbox ? Double.greatestFiniteMagnitude : cutoff)
            for stream in WhoopUploadStream.allCases {
                try execute("""
                    UPDATE stats SET erased = erased +
                        (SELECT COUNT(*) FROM samples WHERE stream = ? AND timestamp <= ?) WHERE stream = ?
                    """, [stream.rawValue, cutoff, stream.rawValue])
            }
            try execute("DELETE FROM batches WHERE id IN (SELECT batch FROM samples WHERE timestamp <= ?)", [cutoff])
            try execute("UPDATE samples SET batch = NULL WHERE batch IS NOT NULL AND batch NOT IN (SELECT id FROM batches)")
            try execute("DELETE FROM samples WHERE timestamp <= ?", [cutoff])
        }
    }

    func readBinding() throws -> WhoopUploadBinding? {
        guard let value = try metadata("binding") else { return nil }
        return try JSONDecoder().decode(WhoopUploadBinding.self, from: Data(value.utf8))
    }
    private func currentGeneration() throws -> String {
        guard let generation = try metadata("generation") else { throw StoreError("WHOOP queue generation is missing") }
        return generation
    }
    private func readBatches() throws -> [WhoopStoredBatch] {
        guard let binding = try readBinding() else { return [] }
        return try rows("SELECT * FROM batches ORDER BY stream").map { row in
            let streamName: String = try field("stream", in: row)
            guard let stream = WhoopUploadStream(rawValue: streamName) else { throw StoreError("Invalid WHOOP queue stream") }
            return try WhoopStoredBatch(
                id: field("id", in: row), generation: field("generation", in: row),
                binding: binding, stream: stream, deviceId: field("device", in: row),
                body: field("body", in: row), sampleCount: field("count", in: row)
            )
        }
    }
    func field<T>(_ name: String, in row: [String: Any]) throws -> T {
        guard let value = row[name] as? T else {
            throw StoreError("WHOOP queue has invalid or missing \(name); sample storage could not be read")
        }
        return value
    }
    func metadata(_ key: String) throws -> String? {
        guard let row = try rows("SELECT value FROM metadata WHERE key = ?", [key]).first else { return nil }
        return try field("value", in: row)
    }
    func setMetadata(_ key: String, _ value: String) throws {
        try execute("INSERT OR REPLACE INTO metadata VALUES (?, ?)", [key, value])
    }
    func synchronized<T>(_ action: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }
        return try action()
    }
    func transaction<T>(
        onStage: WhoopCleanupStageHandler = { _ in },
        reportWrites: ((WhoopSQLiteWriteMeasurement?) -> Void)? = nil,
        _ action: () throws -> T
    ) throws -> T {
        onStage(WhoopCleanupStage("store_lock_wait"))
        return try synchronized {
            try restoreSecureDeleteLocked()
            try finishPendingPurgeLocked()
            let countersBefore = reportWrites == nil ? nil : writeCounters()
            let result = try transactionLocked(onStage: onStage, action)
            if let reportWrites {
                let measurement = countersBefore.flatMap { before in
                    writeCounters()?.delta(since: before)
                }
                reportWrites(measurement)
            }
            return result
        }
    }

    private func writeCounters() -> WhoopSQLiteWriteMeasurement? {
        guard let database else { return nil }
        var cacheWrites: Int32 = 0
        var cacheSpills: Int32 = 0
        var highwater: Int32 = 0
        guard sqlite3_db_status(database, SQLITE_DBSTATUS_CACHE_WRITE, &cacheWrites, &highwater, 0) == SQLITE_OK,
              sqlite3_db_status(database, SQLITE_DBSTATUS_CACHE_SPILL, &cacheSpills, &highwater, 0) == SQLITE_OK else {
            return nil
        }
        return WhoopSQLiteWriteMeasurement(walPagesWritten: Int(cacheWrites), walPagesSpilled: Int(cacheSpills))
    }
    func transactionLocked<T>(onStage: WhoopCleanupStageHandler = { _ in }, _ action: () throws -> T) throws -> T {
        onStage(WhoopCleanupStage("store_begin"))
        try execute("BEGIN IMMEDIATE")
        var committed = false
        defer { if !committed { sqlite3_exec(database, "ROLLBACK", nil, nil, nil) } }
        let result = try action()
        onStage(WhoopCleanupStage("store_commit"))
        try execute("COMMIT")
        committed = true
        onStage(WhoopCleanupStage("store_completed"))
        return result
    }
    func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw databaseError() }
        return statement
    }
    func bind(_ values: [Any], to statement: OpaquePointer) throws {
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            let result: Int32
            switch value {
            case let value as String: result = sqlite3_bind_text(statement, index, value, -1, transient)
            case let value as Int: result = sqlite3_bind_int64(statement, index, Int64(value))
            case let value as Double: result = sqlite3_bind_double(statement, index, value)
            case let value as Data:
                result = value.withUnsafeBytes {
                    sqlite3_bind_blob(statement, index, $0.baseAddress, Int32(value.count), transient)
                }
            default: throw StoreError("Unsupported WHOOP database parameter")
            }
            guard result == SQLITE_OK else { throw databaseError() }
        }
    }
    func finish(_ statement: OpaquePointer) throws {
        var result = sqlite3_step(statement)
        while result == SQLITE_ROW { result = sqlite3_step(statement) }
        guard result == SQLITE_DONE else { throw databaseError() }
    }
    func execute(_ sql: String, _ values: [Any] = []) throws {
        let statement = try prepare(sql); defer { sqlite3_finalize(statement) }
        try bind(values, to: statement)
        try finish(statement)
    }
    /// Decode the row a statement is currently positioned on. Callers step the
    /// statement themselves so large moves never materialize every chunk.
    func currentRow(_ statement: OpaquePointer) throws -> [String: Any] {
        var row: [String: Any] = [:]
        for index in 0..<sqlite3_column_count(statement) {
            let name = String(cString: sqlite3_column_name(statement, index))
            switch sqlite3_column_type(statement, index) {
            case SQLITE_INTEGER: row[name] = Int(sqlite3_column_int64(statement, index))
            case SQLITE_FLOAT: row[name] = sqlite3_column_double(statement, index)
            case SQLITE_TEXT: row[name] = String(cString: sqlite3_column_text(statement, index))
            case SQLITE_BLOB:
                let count = Int(sqlite3_column_bytes(statement, index))
                if let bytes = sqlite3_column_blob(statement, index) {
                    row[name] = Data(bytes: bytes, count: count)
                } else {
                    row[name] = Data()
                }
            default: row[name] = NSNull()
            }
        }
        return row
    }
    func rows(_ sql: String, _ values: [Any] = []) throws -> [[String: Any]] {
        let statement = try prepare(sql); defer { sqlite3_finalize(statement) }
        try bind(values, to: statement)
        var rows: [[String: Any]] = []
        var result = sqlite3_step(statement)
        while result == SQLITE_ROW {
            rows.append(try currentRow(statement))
            result = sqlite3_step(statement)
        }
        guard result == SQLITE_DONE else { throw databaseError() }
        return rows
    }
    func databaseError() -> StoreError { StoreError("WHOOP sample storage: \(String(cString: sqlite3_errmsg(database)))") }
}
