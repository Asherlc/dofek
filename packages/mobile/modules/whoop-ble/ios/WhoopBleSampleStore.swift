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

/// The database owns samples and reservations. Transport files are disposable projections.
final class WhoopBleSampleStore {
    private var database: OpaquePointer?
    private let lock = NSLock()
    private let formatter: ISO8601DateFormatter = {
        let value = ISO8601DateFormatter()
        value.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return value
    }()
    private struct StoreError: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(directory: URL) throws {
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
        try execute("PRAGMA journal_mode = WAL")
        try execute("PRAGMA synchronous = FULL")
        try execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        try execute("""
            CREATE TABLE IF NOT EXISTS samples (
                id INTEGER PRIMARY KEY, stream TEXT NOT NULL, device TEXT NOT NULL,
                timestamp REAL NOT NULL, payload BLOB NOT NULL, batch TEXT)
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
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: path)
        #endif
    }

    deinit { sqlite3_close(database) }

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

    func append(stream: WhoopUploadStream, deviceId: String, samples: [[String: Any]]) throws {
        try transaction {
            guard try readBinding() != nil else { throw StoreError("Configure an authenticated WHOOP account before capture") }
            let cutoff = try metadata("cutoff").flatMap(Double.init)
            try execute("UPDATE stats SET received = received + ? WHERE stream = ?", [samples.count, stream.rawValue])
            // One prepared statement per notification, including larger replay fixtures.
            let statement = try prepare("INSERT INTO samples(stream, device, timestamp, payload) VALUES (?, ?, ?, ?)")
            defer { sqlite3_finalize(statement) }
            var erased = 0
            for sample in samples {
                guard let timestamp = sample["timestamp"] as? String,
                      let date = formatter.date(from: timestamp) ?? ISO8601DateFormatter().date(from: timestamp) else {
                    throw StoreError("WHOOP sample requires a valid ISO8601 timestamp")
                }
                guard JSONSerialization.isValidJSONObject(sample) else { throw StoreError("WHOOP sample is not valid JSON") }
                let erasureTime = stream == .sensorRecords
                    ? WhoopBleSensorRecord.erasureTime(sample: sample, receivedAt: date)
                    : date.timeIntervalSince1970
                if let cutoff, erasureTime <= cutoff { erased += 1; continue }
                let payload = try JSONSerialization.data(withJSONObject: sample, options: [.sortedKeys])
                guard payload.count <= stream.bodyLimit - 2048 else {
                    throw StoreError("WHOOP sensor record exceeds the upload body limit")
                }
                sqlite3_reset(statement)
                sqlite3_clear_bindings(statement)
                try bind([stream.rawValue, deviceId, erasureTime, payload], to: statement)
                try finish(statement)
            }
            try execute("UPDATE stats SET erased = erased + ? WHERE stream = ?", [erased, stream.rawValue])
        }
    }

    func reserve(stream: WhoopUploadStream, limit: Int = 500) throws -> WhoopStoredBatch? {
        try transaction {
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
            var input: [String: Any] = ["deviceId": device, "samples": payloads, "telemetry": ["batchId": id]]
            if stream == .imu { input["deviceType"] = "whoop" }
            let body = try JSONSerialization.data(withJSONObject: input, options: [.sortedKeys])
            guard body.count <= stream.bodyLimit else { throw StoreError("WHOOP upload body exceeds its size limit") }
            try execute("INSERT INTO batches VALUES (?, ?, ?, ?, ?, ?)", [id, generation, stream.rawValue, device, body, selected.count])
            for row in selected {
                let rowId: Int = try field("id", in: row)
                try execute("UPDATE samples SET batch = ? WHERE id = ?", [id, rowId])
            }
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
    func queuedCount(stream: WhoopUploadStream, limit: Int = 500) throws -> Int {
        guard limit > 0 else { return 0 }
        return try synchronized {
            let result = try rows("""
                SELECT received - confirmed - erased - cleared AS count FROM stats WHERE stream = ?
                """, [stream.rawValue])
            guard let row = result.first else { throw StoreError("WHOOP queue count is missing") }
            return min(limit, try field("count", in: row) as Int)
        }
    }
    func purge() throws { try transaction { try purgeLocked() } }

    func advanceErasureCutoff(to date: Date) throws {
        try transaction {
            let cutoff = max(try metadata("cutoff").flatMap(Double.init) ?? -Double.greatestFiniteMagnitude, date.timeIntervalSince1970)
            try setMetadata("cutoff", String(cutoff))
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

    func statistics(stream: WhoopUploadStream) throws -> [String: Any] {
        try synchronized {
            let counts = try rows("""
                SELECT
                    (SELECT MIN(timestamp) FROM samples WHERE stream = ?) AS oldest,
                    (SELECT MAX(timestamp) FROM samples WHERE stream = ?) AS newest
                """, [stream.rawValue, stream.rawValue])
            guard let row = counts.first,
                  let counters = try rows("""
                    SELECT *, received - confirmed - erased - cleared AS count FROM stats WHERE stream = ?
                    """, [stream.rawValue]).first else {
                throw StoreError("WHOOP queue diagnostics are missing")
            }
            func date(_ value: Any?) -> Any {
                (value as? Double).map { formatter.string(from: Date(timeIntervalSince1970: $0)) } ?? (NSNull() as Any)
            }
            return [
                "count": try field("count", in: counters) as Int,
                "oldestTimestamp": date(row["oldest"]),
                "newestTimestamp": date(row["newest"]),
                "receivedCount": try field("received", in: counters) as Int,
                "confirmedCount": try field("confirmed", in: counters) as Int,
                "overflowDiscardedCount": 0,
                "erasureDiscardedCount": try field("erased", in: counters) as Int,
                "clearedCount": try field("cleared", in: counters) as Int,
                "legacyDrainedCount": 0,
                "lastConfirmedAt": date(counters["lastConfirmed"]),
            ]
        }
    }

    private func purgeLocked() throws {
        try execute("UPDATE stats SET received = 0, confirmed = 0, erased = 0, cleared = 0, lastConfirmed = NULL")
        try execute("DELETE FROM samples")
        try execute("DELETE FROM batches")
        try execute("DELETE FROM metadata WHERE key = ?", ["binding"])
        try setMetadata("generation", UUID().uuidString)
    }
    private func readBinding() throws -> WhoopUploadBinding? {
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
    private func field<T>(_ name: String, in row: [String: Any]) throws -> T {
        guard let value = row[name] as? T else {
            throw StoreError("WHOOP queue has invalid or missing \(name); sample storage could not be read")
        }
        return value
    }
    private func metadata(_ key: String) throws -> String? {
        guard let row = try rows("SELECT value FROM metadata WHERE key = ?", [key]).first else { return nil }
        return try field("value", in: row)
    }
    private func setMetadata(_ key: String, _ value: String) throws {
        try execute("INSERT OR REPLACE INTO metadata VALUES (?, ?)", [key, value])
    }
    private func synchronized<T>(_ action: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }
        return try action()
    }
    private func transaction<T>(_ action: () throws -> T) throws -> T {
        try synchronized {
            try execute("BEGIN IMMEDIATE")
            var committed = false
            defer { if !committed { sqlite3_exec(database, "ROLLBACK", nil, nil, nil) } }
            let result = try action()
            try execute("COMMIT")
            committed = true
            return result
        }
    }
    private func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw databaseError() }
        return statement
    }
    private func bind(_ values: [Any], to statement: OpaquePointer) throws {
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
    private func finish(_ statement: OpaquePointer) throws {
        var result = sqlite3_step(statement)
        while result == SQLITE_ROW { result = sqlite3_step(statement) }
        guard result == SQLITE_DONE else { throw databaseError() }
    }
    private func execute(_ sql: String, _ values: [Any] = []) throws {
        let statement = try prepare(sql); defer { sqlite3_finalize(statement) }
        try bind(values, to: statement)
        try finish(statement)
    }
    private func rows(_ sql: String, _ values: [Any] = []) throws -> [[String: Any]] {
        let statement = try prepare(sql); defer { sqlite3_finalize(statement) }
        try bind(values, to: statement)
        var rows: [[String: Any]] = []
        var result = sqlite3_step(statement)
        while result == SQLITE_ROW {
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
            rows.append(row)
            result = sqlite3_step(statement)
        }
        guard result == SQLITE_DONE else { throw databaseError() }
        return rows
    }
    private func databaseError() -> StoreError { StoreError("WHOOP sample storage: \(String(cString: sqlite3_errmsg(database)))") }
}
