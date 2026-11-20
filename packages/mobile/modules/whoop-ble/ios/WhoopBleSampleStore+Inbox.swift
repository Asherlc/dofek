import Foundation
import SQLite3

/// One staged sample inside a compressed inbox row. The payload is the existing
/// validated JSON body; only the inbox representation uses this Codable form.
private struct WhoopInboxEntry: Codable {
    let timestamp: Double
    let payload: Data
}

extension WhoopBleSampleStore {
    func append(deviceId: String, samplesByStream: [WhoopUploadStream: [[String: Any]]]) throws {
        try transaction {
            guard try readBinding() != nil else { throw StoreError("Configure an authenticated WHOOP account before capture") }
            for stream in WhoopUploadStream.allCases {
                guard let samples = samplesByStream[stream], !samples.isEmpty else { continue }
                try appendLocked(stream: stream, deviceId: deviceId, samples: samples)
            }
        }
    }

    /// Validate and stage one stream of a notification inside its FULL transaction.
    private func appendLocked(stream: WhoopUploadStream, deviceId: String, samples: [[String: Any]]) throws {
        let cutoff = try metadata("cutoff").flatMap(Double.init)
        var retained: [(time: Double, payload: Data)] = []
        retained.reserveCapacity(samples.count)
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
            retained.append((erasureTime, payload))
        }
        // Immediately erased arrivals are counted without a stored body. The common
        // path writes no stats row; retained rows accrue received when indexed.
        if erased > 0 {
            try execute(
                "UPDATE stats SET received = received + ?, erased = erased + ? WHERE stream = ?",
                [erased, erased, stream.rawValue]
            )
        }
        guard !retained.isEmpty else { return }
        try appendInboxLocked(stream: stream, deviceId: deviceId, retained: retained)
    }

    /// Stage one notification's retained samples for a single stream. Called
    /// inside the notification's existing FULL transaction, before any commit.
    func appendInboxLocked(stream: WhoopUploadStream, deviceId: String,
                           retained: [(time: Double, payload: Data)]) throws {
        let entries = retained.map { WhoopInboxEntry(timestamp: $0.time, payload: $0.payload) }
        let encoded = try inboxEncoder.encode(entries)
        let payload = try (encoded as NSData).compressed(using: .lzfse) as Data
        let oldest = retained.reduce(Double.greatestFiniteMagnitude) { min($0, $1.time) }
        let newest = retained.reduce(-Double.greatestFiniteMagnitude) { max($0, $1.time) }
        try execute(
            """
            INSERT INTO incoming_samples(stream, device, count, oldest, newest, payload)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [stream.rawValue, deviceId, retained.count, oldest, newest, payload]
        )
    }

    /// Move staged rows into the indexed queue in rowid order, preserving each
    /// row's original per-stream order. A prepared cursor reads one compressed
    /// row at a time; decode/insert failures throw so the transaction rolls back
    /// without discarding a chunk.
    @discardableResult
    func drainInbox() throws -> Bool {
        try transaction {
            let cursor = try prepare("SELECT id, stream, device, count, payload FROM incoming_samples ORDER BY id")
            defer { sqlite3_finalize(cursor) }
            var step = sqlite3_step(cursor)
            guard step == SQLITE_ROW else {
                guard step == SQLITE_DONE else { throw databaseError() }
                return false
            }
            let insert = try prepare("INSERT INTO samples(stream, device, timestamp, payload) VALUES (?, ?, ?, ?)")
            defer { sqlite3_finalize(insert) }
            var receivedByStream: [String: Int] = [:]
            while step == SQLITE_ROW {
                let row = try currentRow(cursor)
                let stream: String = try field("stream", in: row)
                let device: String = try field("device", in: row)
                let count: Int = try field("count", in: row)
                let compressed: Data = try field("payload", in: row)
                for entry in try decodeInboxPayload(compressed) {
                    sqlite3_reset(insert)
                    sqlite3_clear_bindings(insert)
                    try bind([stream, device, entry.timestamp, entry.payload], to: insert)
                    try finish(insert)
                }
                receivedByStream[stream, default: 0] += count
                step = sqlite3_step(cursor)
            }
            guard step == SQLITE_DONE else { throw databaseError() }
            for (stream, count) in receivedByStream {
                try execute("UPDATE stats SET received = received + ? WHERE stream = ?", [count, stream])
            }
            try execute("DELETE FROM incoming_samples")
            return true
        }
    }

    /// Apply a cutoff to staged rows and move their counts into stats atomically.
    func applyInboxErasure(cutoff: Double) throws {
        for stream in WhoopUploadStream.allCases {
            let erased = try eraseInboxLocked(stream: stream.rawValue, cutoff: cutoff)
            if erased > 0 {
                try execute(
                    "UPDATE stats SET received = received + ?, erased = erased + ? WHERE stream = ?",
                    [erased, erased, stream.rawValue]
                )
            }
        }
    }

    /// Remove staged samples at or before the cutoff. Wholly covered chunks use
    /// their stored summaries without decompression; only true partial overlaps
    /// are decoded and rewritten. Returns the number of staged samples erased.
    func eraseInboxLocked(stream: String, cutoff: Double) throws -> Int {
        var erased = 0
        let covered = try rows(
            """
            SELECT COALESCE(SUM(count), 0) AS total FROM incoming_samples
            WHERE stream = ? AND newest <= ?
            """,
            [stream, cutoff]
        )
        erased += try field("total", in: covered[0])
        try execute("DELETE FROM incoming_samples WHERE stream = ? AND newest <= ?", [stream, cutoff])

        // Generated rowids are positive, so zero is below the first key. Each
        // query finishes before its UPDATE/DELETE, and the keyset advances past
        // the captured row so a rewrite cannot select it again.
        var lastID = 0
        while true {
            let partial = try rows(
                """
                SELECT id, payload FROM incoming_samples
                WHERE stream = ? AND oldest <= ? AND newest > ? AND id > ?
                ORDER BY id LIMIT 1
                """,
                [stream, cutoff, cutoff, lastID]
            )
            guard let row = partial.first else { break }
            let id: Int = try field("id", in: row)
            lastID = id
            let compressed: Data = try field("payload", in: row)
            let entries = try decodeInboxPayload(compressed)
            let kept = entries.filter { $0.timestamp > cutoff }
            erased += entries.count - kept.count
            if kept.isEmpty {
                try execute("DELETE FROM incoming_samples WHERE id = ?", [id])
            } else {
                let encoded = try inboxEncoder.encode(kept)
                let payload = try (encoded as NSData).compressed(using: .lzfse) as Data
                let oldest = kept.reduce(Double.greatestFiniteMagnitude) { min($0, $1.timestamp) }
                let newest = kept.reduce(-Double.greatestFiniteMagnitude) { max($0, $1.timestamp) }
                try execute(
                    """
                    UPDATE incoming_samples SET count = ?, oldest = ?, newest = ?, payload = ? WHERE id = ?
                    """,
                    [kept.count, oldest, newest, payload, id]
                )
            }
        }
        return erased
    }

    private func decodeInboxPayload(_ compressed: Data) throws -> [WhoopInboxEntry] {
        let encoded: Data
        do {
            encoded = try (compressed as NSData).decompressed(using: .lzfse) as Data
        } catch {
            throw StoreError("WHOOP inbox payload could not be decompressed")
        }
        do {
            return try inboxDecoder.decode([WhoopInboxEntry].self, from: encoded)
        } catch {
            throw StoreError("WHOOP inbox payload could not be decoded")
        }
    }
}
