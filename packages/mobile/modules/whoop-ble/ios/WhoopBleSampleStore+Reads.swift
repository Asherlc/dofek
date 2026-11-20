import Foundation

extension WhoopBleSampleStore {
    func queuedCount(stream: WhoopUploadStream, limit: Int = 500, includeInbox: Bool = true) throws -> Int {
        guard limit > 0 else { return 0 }
        return try synchronized {
            let result: [[String: Any]]
            if includeInbox {
                result = try rows("""
                    SELECT (received - confirmed - erased - cleared)
                        + COALESCE((SELECT SUM(count) FROM incoming_samples WHERE stream = ?), 0) AS count
                        FROM stats WHERE stream = ?
                    """, [stream.rawValue, stream.rawValue])
            } else {
                result = try rows("""
                    SELECT received - confirmed - erased - cleared AS count FROM stats WHERE stream = ?
                    """, [stream.rawValue])
            }
            guard let row = result.first else { throw StoreError("WHOOP queue count is missing") }
            return min(limit, try field("count", in: row) as Int)
        }
    }

    func statistics(stream: WhoopUploadStream) throws -> [String: Any] {
        try synchronized {
            // One statement yields a consistent snapshot: a promotion between two
            // queries could otherwise pair a new count with an old bound.
            let counts = try rows("""
                SELECT
                    stats.received, stats.confirmed, stats.erased, stats.cleared, stats.lastConfirmed,
                    received - confirmed - erased - cleared AS count,
                    COALESCE(inbox.total, 0) AS inboxCount,
                    inbox.oldest AS inboxOldest,
                    inbox.newest AS inboxNewest,
                    (SELECT MIN(timestamp) FROM samples WHERE stream = stats.stream) AS sampleOldest,
                    (SELECT MAX(timestamp) FROM samples WHERE stream = stats.stream) AS sampleNewest
                    FROM stats
                    LEFT JOIN (
                        SELECT stream, SUM(count) AS total, MIN(oldest) AS oldest, MAX(newest) AS newest
                        FROM incoming_samples GROUP BY stream
                    ) AS inbox ON inbox.stream = stats.stream
                    WHERE stats.stream = ?
                """, [stream.rawValue])
            guard let row = counts.first else { throw StoreError("WHOOP queue diagnostics are missing") }
            func bound(_ first: Any?, _ second: Any?, earliest: Bool) -> Double? {
                let values = [first as? Double, second as? Double].compactMap { $0 }
                guard !values.isEmpty else { return nil }
                return earliest ? values.min() : values.max()
            }
            func date(_ value: Any?) -> Any {
                (value as? Double).map { formatter.string(from: Date(timeIntervalSince1970: $0)) } ?? (NSNull() as Any)
            }
            let inboxCount: Int = try field("inboxCount", in: row)
            return [
                "count": (try field("count", in: row) as Int) + inboxCount,
                "oldestTimestamp": date(bound(row["inboxOldest"], row["sampleOldest"], earliest: true)),
                "newestTimestamp": date(bound(row["inboxNewest"], row["sampleNewest"], earliest: false)),
                "receivedCount": (try field("received", in: row) as Int) + inboxCount,
                "confirmedCount": try field("confirmed", in: row) as Int,
                "overflowDiscardedCount": 0,
                "erasureDiscardedCount": try field("erased", in: row) as Int,
                "clearedCount": try field("cleared", in: row) as Int,
                "legacyDrainedCount": 0,
                "lastConfirmedAt": date(row["lastConfirmed"]),
            ]
        }
    }
}
