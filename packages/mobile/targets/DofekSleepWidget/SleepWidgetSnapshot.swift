import Foundation

/// Version-one App Group wire contract for the Sleep widget.
/// Missing, unreadable, invalid, and expired payloads resolve to `.needsUpdate`.
enum SleepWidgetSnapshot: Equatable, Sendable {
    case sleep(date: String, durationMinutes: Int, expiresAt: Int64)
    case empty(expiresAt: Int64)
    case signedOut
    case needsUpdate
    /// Generic redacted Locked placeholder (WidgetKit privacy / gallery). Not a wire payload.
    case locked

    static let kind = "DofekSleepWidget"
    static let relativeCachePath = "Library/Caches/DofekSleepWidget.json"

    var destinationURL: URL? {
        switch self {
        case .sleep, .empty:
            return URL(string: "dofek://sleep")
        case .signedOut:
            return URL(string: "dofek://login")
        case .needsUpdate, .locked:
            return URL(string: "dofek:///")
        }
    }

    /// Decodes a valid wire payload without applying the clock. Returns `nil` for rejected JSON.
    static func decode(data: Data) -> Self? {
        let decoder = JSONDecoder()
        guard let wire = try? decoder.decode(WireSnapshot.self, from: data), wire.version == 1 else {
            return nil
        }

        switch wire.kind {
        case "sleep":
            guard let date = wire.date,
                  isValidCalendarDate(date),
                  let durationMinutes = wire.durationMinutes,
                  durationMinutes >= 0,
                  let expiresAt = wire.expiresAt
            else {
                return nil
            }
            return .sleep(date: date, durationMinutes: durationMinutes, expiresAt: expiresAt)
        case "empty":
            guard let expiresAt = wire.expiresAt else { return nil }
            return .empty(expiresAt: expiresAt)
        case "signedOut":
            return .signedOut
        default:
            return nil
        }
    }

    /// Applies expiry. Values at or past `expiresAt` become `.needsUpdate`.
    static func resolve(data: Data?, nowMilliseconds: Int64) -> Self {
        guard let data, let decoded = decode(data: data) else { return .needsUpdate }
        return decoded.resolved(nowMilliseconds: nowMilliseconds)
    }

    func resolved(nowMilliseconds: Int64) -> Self {
        switch self {
        case let .sleep(_, _, expiresAt), let .empty(expiresAt):
            return nowMilliseconds >= expiresAt ? .needsUpdate : self
        case .signedOut, .needsUpdate, .locked:
            return self
        }
    }

    /// Epoch milliseconds when a dated or empty snapshot should refresh, if still valid.
    var expirationDate: Date? {
        switch self {
        case let .sleep(_, _, expiresAt), let .empty(expiresAt):
            return Date(timeIntervalSince1970: TimeInterval(expiresAt) / 1000)
        case .signedOut, .needsUpdate, .locked:
            return nil
        }
    }

    static func isValidCalendarDate(_ date: String) -> Bool {
        let parts = date.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0].count == 4,
              parts[1].count == 2,
              parts[2].count == 2,
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              let day = Int(parts[2])
        else {
            return false
        }
        var components = DateComponents()
        components.calendar = Calendar(identifier: .gregorian)
        components.year = year
        components.month = month
        components.day = day
        return components.isValidDate
    }

    private struct WireSnapshot: Decodable {
        let version: Int
        let kind: String
        let date: String?
        let durationMinutes: Int?
        let expiresAt: Int64?
    }
}
