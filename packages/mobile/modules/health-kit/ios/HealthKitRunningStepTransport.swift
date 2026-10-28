import HealthKit

struct HealthKitRunningStepSnapshot {
    let workouts: [[String: Any]]
    let samples: [[String: Any]]
}

struct HealthKitRunningStepDeltaPayload {
    let snapshot: HealthKitRunningStepSnapshot
    let deletedUUIDs: [String]
    let hasMore: Bool

    init(snapshot: HealthKitRunningStepSnapshot, deletedUUIDs: [String], addedParentCount: Int, deletedParentCount: Int) {
        self.snapshot = snapshot
        self.deletedUUIDs = deletedUUIDs
        self.hasMore = addedParentCount + deletedParentCount >= HealthKitRunningStepTransport.anchoredPageSize
    }
}

/// Step observations are eligible only through an explicit running workout association.
enum HealthKitRunningStepTransport {
    static let anchoredPageSize = 500

    static func snapshot(
        workouts: [HKWorkout],
        shouldInclude: (Date) -> Bool,
        discoverWorkouts: ([HKQuantitySample]) async throws -> [HKWorkout],
        readParents: (HKWorkout) async throws -> [HKQuantitySample],
        readSeries: ([HKQuantitySample]) async throws -> [HealthKitQuantitySeriesEntry]
    ) async throws -> HealthKitRunningStepSnapshot {
        var runs = workouts.filter { $0.workoutActivityType == .running && shouldInclude($0.startDate) }
        var parentsById: [UUID: HKQuantitySample] = [:]
        var associations: [UUID: Set<String>] = [:]
        for run in runs {
            for parent in try await readParents(run) where shouldInclude(parent.startDate) {
                parentsById[parent.uuid] = parent
                associations[parent.uuid, default: []].insert(run.uuid.uuidString)
            }
        }
        guard !parentsById.isEmpty else {
            return HealthKitRunningStepSnapshot(workouts: runs.map(HealthKitWorkoutTransport.encode), samples: [])
        }
        // A range selects raw parents, but every association of those parents must survive.
        let selectedParentIds = Set(parentsById.keys)
        var knownRunIds = Set(runs.map(\.uuid))
        for run in try await discoverWorkouts(Array(parentsById.values))
            where run.workoutActivityType == .running && shouldInclude(run.startDate) {
            guard knownRunIds.insert(run.uuid).inserted else { continue }
            runs.append(run)
            for parent in try await readParents(run) where selectedParentIds.contains(parent.uuid) {
                associations[parent.uuid, default: []].insert(run.uuid.uuidString)
            }
        }
        let entries = try await readSeries(parentsById.values.sorted { $0.uuid.uuidString < $1.uuid.uuidString })
        let samples: [[String: Any]] = entries.compactMap { entry in
            guard let workoutUuids = associations[entry.parent.uuid] else { return nil }
            return [
                "type": HKQuantityTypeIdentifier.stepCount.rawValue,
                "value": entry.quantity.doubleValue(for: .count()),
                "unit": "count",
                "startDate": formatDate(entry.dateInterval.start),
                "endDate": formatDate(entry.dateInterval.end),
                "sourceName": entry.parent.sourceRevision.source.name,
                "sourceBundle": entry.parent.sourceRevision.source.bundleIdentifier,
                "uuid": entry.parent.uuid.uuidString,
                "workoutUuids": workoutUuids.sorted(),
            ]
        }
        return HealthKitRunningStepSnapshot(workouts: runs.map(HealthKitWorkoutTransport.encode), samples: samples)
    }

    private static func formatDate(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = .current
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    static func querySamples(type: HKSampleType, predicate: NSPredicate?, store: HKHealthStore) async throws -> [HKSample] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate,
                                      limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: samples ?? [])
                }
            }
            store.execute(query)
        }
    }

    static func read(workouts: [HKWorkout], parentIds: Set<UUID>? = nil,
                     shouldInclude: (Date) -> Bool, store: HKHealthStore) async throws -> HealthKitRunningStepSnapshot {
        try await snapshot(workouts: workouts, shouldInclude: shouldInclude, discoverWorkouts: { parents in
            guard let start = parents.map(\.startDate).min(), let end = parents.map(\.endDate).max() else { return [] }
            let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
                HKQuery.predicateForWorkouts(with: .running),
                HKQuery.predicateForSamples(withStart: start, end: end, options: []),
            ])
            return try await querySamples(type: HKWorkoutType.workoutType(), predicate: predicate, store: store)
                .compactMap { $0 as? HKWorkout }
        }, readParents: { workout in
            var predicates = [HKQuery.predicateForObjects(from: workout)]
            if let parentIds { predicates.append(HKQuery.predicateForObjects(with: parentIds)) }
            return try await querySamples(type: HKQuantityType.quantityType(forIdentifier: .stepCount)!,
                                          predicate: NSCompoundPredicate(andPredicateWithSubpredicates: predicates),
                                          store: store).compactMap { $0 as? HKQuantitySample }
        }, readSeries: { parents in
            try await HealthKitQuantitySeriesTransport.read(parents, store: store)
        })
    }
}
