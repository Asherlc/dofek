struct WhoopReservationWriteSummary {
    private(set) var measuredReservationCount = 0
    private(set) var walPagesWritten = 0
    private(set) var walPagesSpilled = 0
    private(set) var maxWalPagesWritten = 0
    private(set) var measurementFailureCount = 0

    mutating func record(_ measurement: WhoopSQLiteWriteMeasurement?) {
        guard let measurement else {
            measurementFailureCount = Self.saturatingAdd(measurementFailureCount, 1)
            return
        }
        measuredReservationCount = Self.saturatingAdd(measuredReservationCount, 1)
        walPagesWritten = Self.saturatingAdd(walPagesWritten, measurement.walPagesWritten)
        walPagesSpilled = Self.saturatingAdd(walPagesSpilled, measurement.walPagesSpilled)
        maxWalPagesWritten = max(maxWalPagesWritten, measurement.walPagesWritten)
    }

    var asDictionary: [String: Int] {
        [
            "measuredReservationCount": measuredReservationCount,
            "walPagesWritten": walPagesWritten,
            "walPagesSpilled": walPagesSpilled,
            "maxWalPagesWritten": maxWalPagesWritten,
            "measurementFailureCount": measurementFailureCount,
        ]
    }

    private static func saturatingAdd(_ lhs: Int, _ rhs: Int) -> Int {
        let (sum, overflow) = lhs.addingReportingOverflow(rhs)
        return overflow ? Int.max : sum
    }
}
