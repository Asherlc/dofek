import HealthKit

/// Common query patterns used by the HealthKit module
enum HealthKitQueries {
    /// Build a date predicate for sample queries
    static func datePredicate(start: Date, end: Date) -> NSPredicate {
        return HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
    }

    /// Parse an ISO 8601 date string (with or without fractional seconds)
    static func parseDate(_ dateString: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: dateString) {
            return date
        }
        // Retry without fractional seconds for dates like "2024-03-01T10:30:00Z"
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: dateString)
    }

    /// Format a date to ISO 8601 string
    static func formatDate(_ date: Date) -> String {
        return ISO8601DateFormatter().string(from: date)
    }
}
