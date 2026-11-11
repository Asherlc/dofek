import HealthKit

struct HealthKitQuantitySeriesEntry {
    let parent: HKQuantitySample
    let quantity: HKQuantity
    let dateInterval: DateInterval
}

private enum HealthKitQuantitySeriesError: LocalizedError {
    case missingParent

    var errorDescription: String? {
        "HealthKit returned a running quantity without its parent sample. Retry Apple Health sync."
    }
}

enum HealthKitQuantitySeriesTransport {
    /// Running quantities retain every original observation, including condensed samples.
    static func transportSamples(
        _ samples: [HKSample],
        typeIdentifier: String,
        readRunningSeries: ([HKQuantitySample]) async throws -> [HealthKitQuantitySeriesEntry]
    ) async throws -> [[String: Any]] {
        let runningIdentifiers: Set<String> = [
            HKQuantityTypeIdentifier.runningSpeed.rawValue,
            HKQuantityTypeIdentifier.runningPower.rawValue,
            HKQuantityTypeIdentifier.runningStrideLength.rawValue,
            HKQuantityTypeIdentifier.runningGroundContactTime.rawValue,
            HKQuantityTypeIdentifier.runningVerticalOscillation.rawValue,
        ]
        guard runningIdentifiers.contains(typeIdentifier) else {
            return samples.compactMap { HealthKitQueries.transportSample($0, typeIdentifier: typeIdentifier) }
        }
        let parents = samples.compactMap { $0 as? HKQuantitySample }
        guard !parents.isEmpty else { return [] }
        let entries = try await readRunningSeries(parents)
        return entries.map { entry in
            let unit = HealthKitQueries.preferredUnit(for: entry.parent.quantityType)
            return [
                "type": typeIdentifier,
                "value": entry.quantity.doubleValue(for: unit),
                "unit": unit.unitString,
                "startDate": formatSampleDate(entry.dateInterval.start),
                "endDate": formatSampleDate(entry.dateInterval.end),
                "sourceName": entry.parent.sourceRevision.source.name,
                "sourceBundle": entry.parent.sourceRevision.source.bundleIdentifier,
                "uuid": entry.parent.uuid.uuidString,
            ]
        }
    }

    private static func formatSampleDate(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = .current
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    static func read(
        _ samples: [HKQuantitySample],
        store: HKHealthStore
    ) async throws -> [HealthKitQuantitySeriesEntry] {
        guard let type = samples.first?.quantityType else { return [] }
        let predicate = HKSamplePredicate.quantitySample(
            type: type,
            predicate: HKQuery.predicateForObjects(with: Set(samples.map(\.uuid)))
        )
        let descriptor = HKQuantitySeriesSampleQueryDescriptor(
            predicate: predicate,
            options: [.includeSample]
        )
        var entries: [HealthKitQuantitySeriesEntry] = []
        for try await entry in descriptor.results(for: store) {
            guard let parent = entry.sample else {
                throw HealthKitQuantitySeriesError.missingParent
            }
            entries.append(HealthKitQuantitySeriesEntry(
                parent: parent,
                quantity: entry.quantity,
                dateInterval: entry.dateInterval
            ))
        }
        return entries
    }
}
