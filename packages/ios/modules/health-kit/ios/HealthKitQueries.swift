import HealthKit

/// Common query patterns used by the HealthKit module
enum HealthKitQueries {
    /// Build a date predicate for sample queries
    static func datePredicate(start: Date, end: Date) -> NSPredicate {
        return HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
    }

    /// Parse an ISO 8601 date string
    static func parseDate(_ dateString: String) -> Date? {
        return ISO8601DateFormatter().date(from: dateString)
    }

    /// Format a date to ISO 8601 string
    static func formatDate(_ date: Date) -> String {
        return ISO8601DateFormatter().string(from: date)
    }
}
