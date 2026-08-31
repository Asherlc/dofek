// swiftlint:disable file_length
import ExpoModulesCore
import HealthKit
import RNSentry

private final class HealthKitModuleException: ExpoModulesCore.Exception {
    private let exceptionCode: String
    private let exceptionReason: String

    override var code: String {
        return exceptionCode
    }

    override var reason: String {
        return exceptionReason
    }

    override var debugDescription: String {
        return "\(exceptionCode): \(exceptionReason)"
    }

    init(code: String, reason: String, cause: Error? = nil) {
        self.exceptionCode = code
        self.exceptionReason = reason
        super.init()
        self.cause = cause
    }
}

private struct HealthKitAnchoredObjects {
    let added: [HKSample]
    let deleted: [HKDeletedObject]
}

// swiftlint:disable:next type_body_length
public class HealthKitModule: Module {
    private let healthStore = HKHealthStore()
    private let anchoredQueryCoordinator = HealthKitAnchoredQueryCoordinator(
        anchorStore: HealthKitAnchorStore(userDefaults: .standard)
    )
    private let accountStateStore = HealthKitAccountStateStore(userDefaults: .standard)
    private let hasEverAuthorizedKey = "healthkit_has_ever_authorized"
    private var observerSyncInProgress = false
    private let observerStateLock = NSLock()
    private let observerUpdateCoordinatorLock = NSLock()
    private var observerUpdateCoordinator: HealthKitObserverUpdateCoordinator?

    private func makeObserverUpdateCoordinator() -> HealthKitObserverUpdateCoordinator {
        HealthKitObserverUpdateCoordinator(
            timeout: 25,
            reportExpiration: { [weak self] expiration in
                self?.handleObserverUpdateExpiration(expiration)
            }
        )
    }

    private func observerUpdateCoordinatorInstance() -> HealthKitObserverUpdateCoordinator {
        observerUpdateCoordinatorLock.lock()
        defer { observerUpdateCoordinatorLock.unlock() }
        if let existing = observerUpdateCoordinator {
            return existing
        }
        let created = makeObserverUpdateCoordinator()
        observerUpdateCoordinator = created
        return created
    }

    private func ensureObserverUpdateCoordinatorInitialized() {
        observerUpdateCoordinatorInstance()
    }
    private var observerQueries: [HKObserverQuery] = []

    private func effectiveStartDate(_ requestedStartDate: Date) -> Date {
        guard let cutoff = accountStateStore.deviceErasureCutoff else {
            return requestedStartDate
        }
        return max(requestedStartDate, cutoff)
    }

    private func effectiveDailyStartDate(_ requestedStartDate: Date) -> Date {
        guard let cutoff = accountStateStore.deviceErasureCutoff,
              let dayAfterCutoff = Calendar.current.date(
                  byAdding: .day,
                  value: 1,
                  to: Calendar.current.startOfDay(for: cutoff)
              ) else {
            return requestedStartDate
        }
        return max(requestedStartDate, dayAfterCutoff)
    }

    private func markObserverSyncInProgress() {
        observerStateLock.lock()
        observerSyncInProgress = true
        observerStateLock.unlock()
    }

    /// Bridge entry point for JS `setObserverSyncInProgress`. `true` always sets the flag;
    /// `false` clears it only when no observer updates are still pending natively.
    private func setObserverSyncInProgressFromBridge(inProgress: Bool) {
        observerStateLock.lock()
        defer { observerStateLock.unlock() }
        if inProgress {
            observerSyncInProgress = true
        } else if !observerUpdateCoordinatorInstance().hasPendingUpdates {
            observerSyncInProgress = false
        }
    }

    private func handleObserverUpdateExpiration(_ expiration: HealthKitObserverUpdateExpiration) {
        observerStateLock.lock()
        let syncInProgress = observerSyncInProgress
        let hasPendingUpdates = observerUpdateCoordinatorInstance().hasPendingUpdates
        if !hasPendingUpdates {
            observerSyncInProgress = false
        }
        observerStateLock.unlock()

        let breadcrumb = Breadcrumb(level: .info, category: "healthkit.observer")
        breadcrumb.message = syncInProgress
            ? "Observer update expired while JavaScript sync was still running"
            : "Observer update expired before JavaScript sync completed"
        breadcrumb.data = [
            "updateId": expiration.updateId,
            "typeIdentifier": expiration.typeIdentifier,
            "ageMilliseconds": expiration.ageMilliseconds,
            "observerSyncInProgress": syncInProgress,
            "hasPendingUpdates": hasPendingUpdates,
        ]
        SentrySDK.addBreadcrumb(breadcrumb)
    }

    @discardableResult
    private func stopBackgroundObservers() -> Int {
        for query in observerQueries {
            healthStore.stop(query)
        }
        observerQueries.removeAll()
        return observerUpdateCoordinatorInstance().completeAll()
    }

    private func rejectPromise(_ promise: Promise, code: String, reason: String) {
        promise.reject(HealthKitModuleException(code: code, reason: reason))
    }

    private func rejectHealthKitError(
        _ promise: Promise,
        operation: String,
        fallbackCode: String,
        error: Error
    ) {
        let details = HealthKitErrorDetails(
            operation: operation,
            fallbackCode: fallbackCode,
            error: error
        )
        promise.reject(
            HealthKitModuleException(code: details.code, reason: details.reason, cause: error)
        )
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    public func definition() -> ModuleDefinition {
        Name("HealthKit")

        Events("onHealthKitSampleUpdate")

        OnDestroy {
            _ = self.stopBackgroundObservers()
        }

        OnCreate {
            self.ensureObserverUpdateCoordinatorInitialized()
        }

        Function("isAvailable") {
            return HKHealthStore.isHealthDataAvailable()
        }

        /// Returns true if the user has ever completed the HealthKit authorization flow.
        /// Uses a UserDefaults flag set by requestPermissions or by getRequestStatus when
        /// HealthKit reports that the current authorization request is unnecessary, with a
        /// one-time migration that checks write-type authorization status for users who
        /// authorized before this flag was introduced.
        Function("hasEverAuthorized") {
            if UserDefaults.standard.bool(
                forKey: HealthKitAccountStateStore.hasEverAuthorizedKey
            ) {
                return true
            }
            // Migration: check if any write type was previously authorized.
            // Apple exposes authorization status for write types (not read types).
            // If a write type is .sharingAuthorized or .sharingDenied, the user
            // has been through the authorization flow before.
            for writeType in writeTypes {
                let status = self.healthStore.authorizationStatus(for: writeType)
                if status == .sharingAuthorized || status == .sharingDenied {
                    UserDefaults.standard.set(
                        true,
                        forKey: HealthKitAccountStateStore.hasEverAuthorizedKey
                    )
                    return true
                }
            }
            return false
        }

        AsyncFunction("getRequestStatus") { (promise: Promise) in
            guard HKHealthStore.isHealthDataAvailable() else {
                promise.resolve("unavailable")
                return
            }
            Task {
                do {
                    let status = try await self.healthStore.statusForAuthorizationRequest(toShare: writeTypes, read: readTypes)
                    switch status {
                    case .unnecessary:
                        UserDefaults.standard.set(
                            true,
                            forKey: HealthKitAccountStateStore.hasEverAuthorizedKey
                        )
                        promise.resolve("unnecessary")
                    case .shouldRequest:
                        promise.resolve("shouldRequest")
                    default:
                        promise.resolve("unknown")
                    }
                } catch {
                    self.rejectHealthKitError(
                        promise,
                        operation: "getRequestStatus",
                        fallbackCode: "HEALTHKIT_STATUS_ERROR",
                        error: error
                    )
                }
            }
        }

        AsyncFunction("requestPermissions") { (promise: Promise) in
            guard HKHealthStore.isHealthDataAvailable() else {
                promise.resolve(false)
                return
            }
            Task {
                do {
                    try await self.healthStore.requestAuthorization(toShare: writeTypes, read: readTypes)
                    UserDefaults.standard.set(
                        true,
                        forKey: HealthKitAccountStateStore.hasEverAuthorizedKey
                    )
                    promise.resolve(true)
                } catch {
                    if isUserCanceledHealthKitAuthorization(error) {
                        promise.resolve(false)
                        return
                    }
                    self.rejectHealthKitError(
                        promise,
                        operation: "requestPermissions",
                        fallbackCode: "HEALTHKIT_AUTH_ERROR",
                        error: error
                    )
                }
            }
        }

        // swiftlint:disable:next line_length
        AsyncFunction("queryQuantitySamples") { (typeIdentifier: String, startDateStr: String, endDateStr: String, limit: Int, promise: Promise) in
            guard let sampleType = HKQuantityType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: typeIdentifier)) else {
                self.rejectPromise(
                    promise,
                    code: "INVALID_TYPE",
                    reason: "Unknown quantity type: \(typeIdentifier)"
                )
                return
            }
            guard let startDate = HealthKitQueries.parseDate(startDateStr),
                  let endDate = HealthKitQueries.parseDate(endDateStr) else {
                self.rejectPromise(
                    promise,
                    code: "INVALID_DATE",
                    reason: "Invalid ISO 8601 date format"
                )
                return
            }
            let queryStartDate = self.effectiveStartDate(startDate)
            guard queryStartDate < endDate else {
                promise.resolve([[String: Any]]())
                return
            }

            let predicate = HealthKitQueries.datePredicate(
                start: queryStartDate,
                end: endDate
            )
            let sortDescriptor = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
            let queryLimit = limit > 0 ? limit : HKObjectQueryNoLimit

            let query = HKSampleQuery(
                sampleType: sampleType, predicate: predicate,
                limit: queryLimit, sortDescriptors: [sortDescriptor]
            ) { _, results, error in
                if let error = error {
                    if HealthKitErrorDetails.isAuthorizationNotDetermined(error) {
                        promise.resolve([[String: Any]]())
                        return
                    }
                    self.rejectHealthKitError(
                        promise,
                        operation: "queryQuantitySamples(\(typeIdentifier))",
                        fallbackCode: "QUERY_ERROR",
                        error: error
                    )
                    return
                }
                let samples = (results as? [HKQuantitySample])?
                    .filter {
                        self.accountStateStore.shouldInclude(sampleDate: $0.startDate)
                    }
                    .map { sample -> [String: Any] in
                    let unit = HealthKitQueries.preferredUnit(for: sampleType)
                    return [
                        "type": typeIdentifier,
                        "value": sample.quantity.doubleValue(for: unit),
                        "unit": unit.unitString,
                        "startDate": HealthKitQueries.formatDate(sample.startDate),
                        "endDate": HealthKitQueries.formatDate(sample.endDate),
                        "sourceName": sample.sourceRevision.source.name,
                        "sourceBundle": sample.sourceRevision.source.bundleIdentifier,
                        "uuid": sample.uuid.uuidString,
                    ]
                } ?? []
                promise.resolve(samples)
            }
            self.healthStore.execute(query)
        }

        AsyncFunction("queryWorkouts") { (startDateStr: String, endDateStr: String, promise: Promise) in
            guard let startDate = HealthKitQueries.parseDate(startDateStr),
                  let endDate = HealthKitQueries.parseDate(endDateStr) else {
                self.rejectPromise(
                    promise,
                    code: "INVALID_DATE",
                    reason: "Invalid ISO 8601 date format"
                )
                return
            }
            let queryStartDate = self.effectiveStartDate(startDate)
            guard queryStartDate < endDate else {
                promise.resolve([[String: Any]]())
                return
            }

            let predicate = HealthKitQueries.datePredicate(
                start: queryStartDate,
                end: endDate
            )
            let sortDescriptor = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)

            let query = HKSampleQuery(
                sampleType: HKWorkoutType.workoutType(), predicate: predicate,
                limit: HKObjectQueryNoLimit, sortDescriptors: [sortDescriptor]
            ) { _, results, error in
                if let error = error {
                    if HealthKitErrorDetails.isAuthorizationNotDetermined(error) {
                        promise.resolve([[String: Any]]())
                        return
                    }
                    self.rejectHealthKitError(
                        promise,
                        operation: "queryWorkouts",
                        fallbackCode: "QUERY_ERROR",
                        error: error
                    )
                    return
                }
                let workouts = (results as? [HKWorkout])?
                    .filter {
                        self.accountStateStore.shouldInclude(sampleDate: $0.startDate)
                    }
                    .map { workout -> [String: Any] in
                    var dict: [String: Any] = [
                        "uuid": workout.uuid.uuidString,
                        "workoutType": String(describing: workout.workoutActivityType.rawValue),
                        "startDate": HealthKitQueries.formatDate(workout.startDate),
                        "endDate": HealthKitQueries.formatDate(workout.endDate),
                        "duration": workout.duration,
                        "sourceName": workout.sourceRevision.source.name,
                        "sourceBundle": workout.sourceRevision.source.bundleIdentifier,
                    ]
                    if let distance = workout.totalDistance {
                        dict["totalDistance"] = distance.doubleValue(for: .meter())
                    }

                    // Include workout-level metadata (arbitrary key-value pairs set by the recording app)
                    if let metadata = workout.metadata, !metadata.isEmpty {
                        var metadataDict: [String: Any] = [:]
                        for (key, value) in metadata {
                            // Only bridge JSON-safe types: String, NSNumber (Int/Double/Bool), Date→ISO string
                            if let stringValue = value as? String {
                                metadataDict[key] = stringValue
                            } else if let numberValue = value as? NSNumber {
                                metadataDict[key] = numberValue.doubleValue
                            } else if let dateValue = value as? Date {
                                metadataDict[key] = HealthKitQueries.formatDate(dateValue)
                            }
                        }
                        if !metadataDict.isEmpty {
                            dict["metadata"] = metadataDict
                        }
                    }

                    // Include sub-activities (iOS 16+): each HKWorkoutActivity within the workout
                    let activities = workout.workoutActivities
                    if !activities.isEmpty {
                        dict["workoutActivities"] = activities.map { activity -> [String: Any] in
                            var activityDict: [String: Any] = [
                                "uuid": activity.uuid.uuidString,
                                "activityType": activity.workoutConfiguration.activityType.rawValue,
                                "startDate": HealthKitQueries.formatDate(activity.startDate),
                            ]
                            if let endDate = activity.endDate {
                                activityDict["endDate"] = HealthKitQueries.formatDate(endDate)
                            }
                            if let activityMetadata = activity.metadata, !activityMetadata.isEmpty {
                                var activityMetaDict: [String: Any] = [:]
                                for (key, value) in activityMetadata {
                                    if let stringValue = value as? String {
                                        activityMetaDict[key] = stringValue
                                    } else if let numberValue = value as? NSNumber {
                                        activityMetaDict[key] = numberValue.doubleValue
                                    } else if let dateValue = value as? Date {
                                        activityMetaDict[key] = HealthKitQueries.formatDate(dateValue)
                                    }
                                }
                                if !activityMetaDict.isEmpty {
                                    activityDict["metadata"] = activityMetaDict
                                }
                            }
                            return activityDict
                        }
                    }

                    return dict
                } ?? []
                promise.resolve(workouts)
            }
            self.healthStore.execute(query)
        }

        AsyncFunction("querySleepSamples") { (startDateStr: String, endDateStr: String, promise: Promise) in
            guard let sleepType = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis) else {
                self.rejectPromise(
                    promise,
                    code: "INVALID_TYPE",
                    reason: "Sleep analysis type not available"
                )
                return
            }
            guard let startDate = HealthKitQueries.parseDate(startDateStr),
                  let endDate = HealthKitQueries.parseDate(endDateStr) else {
                self.rejectPromise(
                    promise,
                    code: "INVALID_DATE",
                    reason: "Invalid ISO 8601 date format"
                )
                return
            }
            let queryStartDate = self.effectiveStartDate(startDate)
            guard queryStartDate < endDate else {
                promise.resolve([[String: Any]]())
                return
            }

            let predicate = HealthKitQueries.datePredicate(
                start: queryStartDate,
                end: endDate
            )
            let sortDescriptor = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)

            let query = HKSampleQuery(
                sampleType: sleepType, predicate: predicate,
                limit: HKObjectQueryNoLimit, sortDescriptors: [sortDescriptor]
            ) { _, results, error in
                if let error = error {
                    if HealthKitErrorDetails.isAuthorizationNotDetermined(error) {
                        promise.resolve([[String: Any]]())
                        return
                    }
                    self.rejectHealthKitError(
                        promise,
                        operation: "querySleepSamples",
                        fallbackCode: "QUERY_ERROR",
                        error: error
                    )
                    return
                }
                let samples = (results as? [HKCategorySample])?
                    .filter {
                        self.accountStateStore.shouldInclude(sampleDate: $0.startDate)
                    }
                    .map { sample -> [String: Any] in
                    let valueStr: String
                    if #available(iOS 16.0, *) {
                        switch sample.value {
                        case HKCategoryValueSleepAnalysis.inBed.rawValue: valueStr = "inBed"
                        case HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue: valueStr = "asleep"
                        case HKCategoryValueSleepAnalysis.asleepCore.rawValue: valueStr = "asleepCore"
                        case HKCategoryValueSleepAnalysis.asleepDeep.rawValue: valueStr = "asleepDeep"
                        case HKCategoryValueSleepAnalysis.asleepREM.rawValue: valueStr = "asleepREM"
                        case HKCategoryValueSleepAnalysis.awake.rawValue: valueStr = "awake"
                        default: valueStr = "unknown"
                        }
                    } else {
                        switch sample.value {
                        case HKCategoryValueSleepAnalysis.inBed.rawValue: valueStr = "inBed"
                        case HKCategoryValueSleepAnalysis.awake.rawValue: valueStr = "awake"
                        default: valueStr = "asleep"
                        }
                    }
                    return [
                        "uuid": sample.uuid.uuidString,
                        "startDate": HealthKitQueries.formatDate(sample.startDate),
                        "endDate": HealthKitQueries.formatDate(sample.endDate),
                        "value": valueStr,
                        "sourceName": sample.sourceRevision.source.name,
                    ]
                } ?? []
                promise.resolve(samples)
            }
            self.healthStore.execute(query)
        }

        AsyncFunction("queryCategorySamples") { (typeIdentifier: String, startDateStr: String, endDateStr: String, promise: Promise) in
            guard let categoryType = HKCategoryType.categoryType(forIdentifier: HKCategoryTypeIdentifier(rawValue: typeIdentifier)) else {
                self.rejectPromise(
                    promise,
                    code: "INVALID_TYPE",
                    reason: "Unknown category type: \(typeIdentifier)"
                )
                return
            }
            guard let startDate = HealthKitQueries.parseDate(startDateStr),
                  let endDate = HealthKitQueries.parseDate(endDateStr) else {
                self.rejectPromise(
                    promise,
                    code: "INVALID_DATE",
                    reason: "Invalid ISO 8601 date format"
                )
                return
            }
            let queryStartDate = self.effectiveStartDate(startDate)
            guard queryStartDate < endDate else {
                promise.resolve([[String: Any]]())
                return
            }

            let predicate = HealthKitQueries.datePredicate(
                start: queryStartDate,
                end: endDate
            )
            let sortDescriptor = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)

            let query = HKSampleQuery(
                sampleType: categoryType, predicate: predicate,
                limit: HKObjectQueryNoLimit, sortDescriptors: [sortDescriptor]
            ) { _, results, error in
                if let error = error {
                    if HealthKitErrorDetails.isAuthorizationNotDetermined(error) {
                        promise.resolve([[String: Any]]())
                        return
                    }
                    self.rejectHealthKitError(
                        promise,
                        operation: "queryCategorySamples(\(typeIdentifier))",
                        fallbackCode: "QUERY_ERROR",
                        error: error
                    )
                    return
                }
                let samples = (results as? [HKCategorySample])?
                    .filter {
                        self.accountStateStore.shouldInclude(sampleDate: $0.startDate)
                    }
                    .compactMap {
                        HealthKitQueries.transportSample($0, typeIdentifier: typeIdentifier)
                    } ?? []
                promise.resolve(samples)
            }
            self.healthStore.execute(query)
        }

        AsyncFunction("deleteDietarySamples") { (syncIdentifiers: [String], promise: Promise) in
            guard !syncIdentifiers.isEmpty else {
                promise.resolve(0)
                return
            }

            Task {
                do {
                    var deletedTotal = 0
                    for sampleType in writeTypes {
                        let predicate = HKQuery.predicateForObjects(
                            withMetadataKey: HKMetadataKeySyncIdentifier,
                            allowedValues: syncIdentifiers
                        )
                        let deletedCount: Int = try await withCheckedThrowingContinuation { continuation in
                            self.healthStore.deleteObjects(of: sampleType, predicate: predicate) { _, deletedCount, error in
                                if let error = error {
                                    continuation.resume(throwing: error)
                                    return
                                }
                                continuation.resume(returning: deletedCount)
                            }
                        }
                        deletedTotal += deletedCount
                    }
                    promise.resolve(deletedTotal)
                } catch {
                    self.rejectHealthKitError(
                        promise,
                        operation: "deleteDietarySamples",
                        fallbackCode: "DELETE_ERROR",
                        error: error
                    )
                }
            }
        }

        AsyncFunction("queryAnchoredSamples") { (typeIdentifier: String, initialStartDateStr: String, promise: Promise) in
            guard let sampleType = HealthKitQueries.sampleType(for: typeIdentifier) else {
                self.rejectPromise(
                    promise,
                    code: "INVALID_TYPE",
                    reason: "Unknown sample type: \(typeIdentifier)"
                )
                return
            }
            guard let initialStartDate = HealthKitQueries.parseDate(initialStartDateStr) else {
                self.rejectPromise(
                    promise,
                    code: "INVALID_DATE",
                    reason: "Invalid ISO 8601 initial start date"
                )
                return
            }

            Task {
                do {
                    let queryResult: HealthKitPendingAnchoredQuery<HealthKitAnchoredObjects> =
                        try await self.anchoredQueryCoordinator.run(
                        typeIdentifier: typeIdentifier
                    ) { anchor in
                        try await withCheckedThrowingContinuation { continuation in
                            let erasureCutoff = self.accountStateStore.deviceErasureCutoff
                            let predicate: NSPredicate?
                            if anchor == nil {
                                let startDate = max(initialStartDate, erasureCutoff ?? initialStartDate)
                                predicate = HealthKitQueries.datePredicate(
                                    start: startDate,
                                    end: Date()
                                )
                            } else {
                                predicate = erasureCutoff.map {
                                    HKQuery.predicateForSamples(
                                        withStart: $0,
                                        end: nil,
                                        options: .strictStartDate
                                    )
                                }
                            }
                            let query = HKAnchoredObjectQuery(
                                type: sampleType,
                                predicate: predicate,
                                anchor: anchor,
                                limit: HKObjectQueryNoLimit
                            ) { _, added, deleted, newAnchor, error in
                                if let error {
                                    continuation.resume(throwing: error)
                                    return
                                }
                                continuation.resume(
                                    returning: (
                                        HealthKitAnchoredObjects(
                                            added: added ?? [],
                                            deleted: deleted ?? []
                                        ),
                                        newAnchor
                                    )
                                )
                            }
                            self.healthStore.execute(query)
                        }
                    }
                    let objects: HealthKitAnchoredObjects = queryResult.result

                    let samples = objects.added
                        .filter {
                            self.accountStateStore.shouldInclude(sampleDate: $0.startDate)
                        }
                        .compactMap {
                            HealthKitQueries.transportSample($0, typeIdentifier: typeIdentifier)
                        }

                    let deletedUUIDs = objects.deleted.map { $0.uuid.uuidString }

                    promise.resolve([
                        "samples": samples,
                        "deletedUUIDs": deletedUUIDs,
                        "queryId": queryResult.queryId ?? NSNull(),
                    ] as [String: Any])
                } catch let error as HealthKitAnchorStoreError {
                    promise.reject(
                        HealthKitModuleException(
                            code: "ANCHOR_STATE_ERROR",
                            reason: error.localizedDescription,
                            cause: error
                        )
                    )
                } catch {
                    self.rejectHealthKitError(
                        promise,
                        operation: "queryAnchoredSamples(\(typeIdentifier))",
                        fallbackCode: "QUERY_ERROR",
                        error: error
                    )
                }
            }
        }

        AsyncFunction("completeAnchoredQuery") { (typeIdentifier: String, queryId: String, succeeded: Bool, promise: Promise) in
            do {
                try self.anchoredQueryCoordinator.complete(
                    typeIdentifier: typeIdentifier,
                    queryId: queryId,
                    succeeded: succeeded
                )
                promise.resolve(true)
            } catch {
                promise.reject(
                    HealthKitModuleException(
                        code: "ANCHOR_STATE_ERROR",
                        reason: error.localizedDescription,
                        cause: error
                    )
                )
            }
        }

        AsyncFunction("queryDailyStatistics") { (typeIdentifier: String, startDateStr: String, endDateStr: String, promise: Promise) in
            guard let quantityType = HKQuantityType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: typeIdentifier)) else {
                self.rejectPromise(
                    promise,
                    code: "INVALID_TYPE",
                    reason: "Unknown quantity type: \(typeIdentifier)"
                )
                return
            }
            guard let startDate = HealthKitQueries.parseDate(startDateStr),
                  let endDate = HealthKitQueries.parseDate(endDateStr) else {
                self.rejectPromise(
                    promise,
                    code: "INVALID_DATE",
                    reason: "Invalid ISO 8601 date format"
                )
                return
            }

            let calendar = Calendar.current
            let interval = DateComponents(day: 1)
            let queryStartDate = self.effectiveDailyStartDate(startDate)
            guard queryStartDate < endDate else {
                promise.resolve([[String: Any]]())
                return
            }
            let anchorDate = calendar.startOfDay(for: queryStartDate)

            let query = HKStatisticsCollectionQuery(
                quantityType: quantityType,
                quantitySamplePredicate: HealthKitQueries.datePredicate(
                    start: queryStartDate,
                    end: endDate
                ),
                options: .cumulativeSum,
                anchorDate: anchorDate,
                intervalComponents: interval
            )

            query.initialResultsHandler = { _, results, error in
                if let error = error {
                    if HealthKitErrorDetails.isAuthorizationNotDetermined(error) {
                        self.rejectHealthKitError(
                            promise,
                            operation: "queryDailyStatistics(\(typeIdentifier))",
                            fallbackCode: "HEALTHKIT_AUTHORIZATION_NOT_DETERMINED",
                            error: error
                        )
                        return
                    }
                    self.rejectHealthKitError(
                        promise,
                        operation: "queryDailyStatistics(\(typeIdentifier))",
                        fallbackCode: "QUERY_ERROR",
                        error: error
                    )
                    return
                }

                guard let results = results else {
                    promise.resolve([])
                    return
                }

                let unit = HealthKitQueries.preferredUnit(for: quantityType)
                let dateFormatter = DateFormatter()
                dateFormatter.dateFormat = "yyyy-MM-dd"
                dateFormatter.timeZone = .current

                var dailyValues: [[String: Any]] = []
                results.enumerateStatistics(from: queryStartDate, to: endDate) { statistics, _ in
                    if let sum = statistics.sumQuantity() {
                        dailyValues.append([
                            "date": dateFormatter.string(from: statistics.startDate),
                            "value": sum.doubleValue(for: unit),
                        ])
                    }
                }

                promise.resolve(dailyValues)
            }

            self.healthStore.execute(query)
        }

        Function("isBackgroundDeliveryEnabled") {
            return UserDefaults.standard.bool(
                forKey: HealthKitAccountStateStore.backgroundDeliveryEnabledKey
            )
        }

        AsyncFunction("enableBackgroundDelivery") { (typeIdentifier: String, promise: Promise) in
            guard let sampleType = HealthKitQueries.sampleType(for: typeIdentifier) else {
                self.rejectPromise(
                    promise,
                    code: "INVALID_TYPE",
                    reason: "Unknown sample type: \(typeIdentifier)"
                )
                return
            }

            Task {
                do {
                    try await self.healthStore.enableBackgroundDelivery(for: sampleType, frequency: .hourly)
                    UserDefaults.standard.set(
                        true,
                        forKey: HealthKitAccountStateStore.backgroundDeliveryEnabledKey
                    )
                    promise.resolve(true)
                } catch {
                    self.rejectHealthKitError(
                        promise,
                        operation: "enableBackgroundDelivery(\(typeIdentifier))",
                        fallbackCode: "BG_DELIVERY_ERROR",
                        error: error
                    )
                }
            }
        }

        AsyncFunction("setupBackgroundObservers") { (promise: Promise) in
            guard HKHealthStore.isHealthDataAvailable() else {
                promise.resolve(false)
                return
            }

            // Initialize before observer callbacks or JS completion paths can access concurrently.
            self.ensureObserverUpdateCoordinatorInitialized()

            // Re-registration must settle every callback owned by the old queries.
            self.stopBackgroundObservers()

            // Observe only types consumed by the background sync pipeline.
            for sampleType in backgroundDeliveryTypes {
                let query = HKObserverQuery(sampleType: sampleType, predicate: nil) { [weak self] _, completionHandler, error in
                    guard let self else {
                        completionHandler()
                        return
                    }
                    if let error {
                        if !HealthKitErrorDetails.shouldReportObserverError(error) {
                            let breadcrumb = Breadcrumb(
                                level: .info,
                                category: "healthkit.observer"
                            )
                            breadcrumb.message =
                                "Authorization not determined for \(sampleType.identifier)"
                            SentrySDK.addBreadcrumb(breadcrumb)
                            completionHandler()
                            return
                        }
                        SentrySDK.capture(error: error) { scope in
                            scope.setTag(value: "observerQuery", key: "healthkit.operation")
                            scope.setTag(
                                value: sampleType.identifier,
                                key: "healthkit.sample_type"
                            )
                        }
                        completionHandler()
                        return
                    }

                    let updateId = self.observerUpdateCoordinatorInstance().register(
                        typeIdentifier: sampleType.identifier,
                        completion: completionHandler
                    )
                    self.markObserverSyncInProgress()
                    MainThreadEventEmitter.emit(
                        [
                            "typeIdentifier": sampleType.identifier,
                            "updateId": updateId,
                        ],
                        send: { payload in
                            self.sendEvent("onHealthKitSampleUpdate", payload)
                        }
                    )
                }
                self.observerQueries.append(query)
                self.healthStore.execute(query)
            }

            let dispatchGroup = DispatchGroup()
            let errorLock = NSLock()
            var backgroundDeliveryErrors: [String] = []

            for sampleType in backgroundDeliveryTypes {
                dispatchGroup.enter()
                self.healthStore.enableBackgroundDelivery(for: sampleType, frequency: .hourly) { _, error in
                    if let error = error {
                        // Skip types that haven't been authorized yet — they'll be
                        // registered after the user grants permission via requestPermissions().
                        if !HealthKitErrorDetails.isAuthorizationNotDetermined(error) {
                            errorLock.lock()
                            let nativeError = error as NSError
                            backgroundDeliveryErrors.append(
                                "\(sampleType.identifier): \(nativeError.localizedDescription) " +
                                    "(\(nativeError.domain):\(nativeError.code))"
                            )
                            errorLock.unlock()
                        }
                    }
                    dispatchGroup.leave()
                }
            }

            dispatchGroup.notify(queue: .main) {
                if backgroundDeliveryErrors.isEmpty {
                    promise.resolve(true)
                } else {
                    self.rejectPromise(
                        promise,
                        code: "BG_DELIVERY_ERROR",
                        reason: backgroundDeliveryErrors.sorted().joined(separator: "; ")
                    )
                }
            }
        }

        Function("setObserverSyncInProgress") { (inProgress: Bool) in
            self.setObserverSyncInProgressFromBridge(inProgress: inProgress)
        }

        Function("completeObserverUpdates") { (updateIds: [String], succeeded: Bool) -> Int in
            if !succeeded {
                NSLog(
                    "[HealthKit] Completing %d observer updates after a failed sync",
                    updateIds.count
                )
            }
            return self.observerUpdateCoordinatorInstance().complete(updateIds: updateIds)
        }

        Function("teardownBackgroundObservers") { () -> Int in
            return self.stopBackgroundObservers()
        }

        AsyncFunction("purgeAccountState") { (cutoffString: String, promise: Promise) in
            guard let cutoff = HealthKitQueries.parseDate(cutoffString) else {
                self.rejectPromise(
                    promise,
                    code: "INVALID_ERASURE_CUTOFF",
                    reason: "Invalid device erasure cutoff"
                )
                return
            }

            _ = self.stopBackgroundObservers()
            self.accountStateStore.purge(at: cutoff)
            self.anchoredQueryCoordinator.invalidatePendingQueries()
            self.healthStore.disableAllBackgroundDelivery { succeeded, error in
                if let error {
                    SentrySDK.capture(error: error)
                    self.rejectHealthKitError(
                        promise,
                        operation: "purgeAccountState.disableAllBackgroundDelivery",
                        fallbackCode: "BG_DELIVERY_DISABLE_ERROR",
                        error: error
                    )
                    return
                }
                guard succeeded else {
                    let error = NSError(
                        domain: "com.dofek.healthkit-account-erasure",
                        code: 1,
                        userInfo: [
                            NSLocalizedDescriptionKey:
                                "HealthKit did not disable background delivery",
                        ]
                    )
                    SentrySDK.capture(error: error)
                    self.rejectHealthKitError(
                        promise,
                        operation: "purgeAccountState.disableAllBackgroundDelivery",
                        fallbackCode: "BG_DELIVERY_DISABLE_ERROR",
                        error: error
                    )
                    return
                }
                promise.resolve(true)
            }
        }

        // ============================================================
        // Workout Route (GPS) queries
        // ============================================================

        AsyncFunction("queryWorkoutRoutes") { (workoutUuid: String, promise: Promise) in
            guard let uuid = UUID(uuidString: workoutUuid) else {
                self.rejectPromise(
                    promise,
                    code: "INVALID_UUID",
                    reason: "Invalid workout UUID: \(workoutUuid)"
                )
                return
            }

            // Find the workout by UUID
            let workoutPredicate = HKQuery.predicateForObject(with: uuid)
            let workoutQuery = HKSampleQuery(
                sampleType: HKWorkoutType.workoutType(),
                predicate: workoutPredicate,
                limit: 1,
                sortDescriptors: nil
            ) { [weak self] _, results, error in
                guard let self = self else {
                    promise.resolve([])
                    return
                }
                if let error = error {
                    self.rejectHealthKitError(
                        promise,
                        operation: "queryWorkoutRoutes.lookupWorkout(\(workoutUuid))",
                        fallbackCode: "QUERY_ERROR",
                        error: error
                    )
                    return
                }
                guard let workout = results?.first as? HKWorkout else {
                    promise.resolve([])
                    return
                }
                guard self.accountStateStore.shouldInclude(
                    sampleDate: workout.startDate
                ) else {
                    promise.resolve([])
                    return
                }

                // Query routes associated with this workout
                let routePredicate = HKQuery.predicateForObjects(from: workout)
                let routeQuery = HKSampleQuery(
                    sampleType: HKSeriesType.workoutRoute(),
                    predicate: routePredicate,
                    limit: HKObjectQueryNoLimit,
                    sortDescriptors: nil
                ) { _, routeResults, routeError in
                    if let routeError = routeError {
                        self.rejectHealthKitError(
                            promise,
                            operation: "queryWorkoutRoutes.lookupRoutes(\(workoutUuid))",
                            fallbackCode: "ROUTE_QUERY_ERROR",
                            error: routeError
                        )
                        return
                    }
                    guard let routes = routeResults as? [HKWorkoutRoute], !routes.isEmpty else {
                        promise.resolve([])
                        return
                    }

                    // Collect all locations from all routes using a serial queue for thread safety
                    let collectQueue = DispatchQueue(label: "com.dofek.routeCollect")
                    var allLocations: [[String: Any]] = []
                    let group = DispatchGroup()

                    for route in routes {
                        group.enter()
                        var routeLocations: [[String: Any]] = []

                        let locationQuery = HKWorkoutRouteQuery(route: route) { _, locations, done, _ in
                            // Process locations if available (even when there's an error on this batch)
                            if let locations = locations {
                                for location in locations {
                                    guard self.accountStateStore.shouldInclude(
                                        sampleDate: location.timestamp
                                    ) else {
                                        continue
                                    }
                                    var dict: [String: Any] = [
                                        "date": HealthKitQueries.formatDate(location.timestamp),
                                        "lat": location.coordinate.latitude,
                                        "lng": location.coordinate.longitude,
                                    ]
                                    if location.verticalAccuracy >= 0 {
                                        dict["altitude"] = location.altitude
                                    }
                                    if location.speed >= 0 {
                                        dict["speed"] = location.speed
                                    }
                                    if location.horizontalAccuracy >= 0 {
                                        dict["horizontalAccuracy"] = location.horizontalAccuracy
                                    }
                                    routeLocations.append(dict)
                                }
                            }

                            // Always leave the group exactly once when done
                            if done {
                                collectQueue.async {
                                    allLocations.append(contentsOf: routeLocations)
                                    group.leave()
                                }
                            }
                        }
                        self.healthStore.execute(locationQuery)
                    }

                    group.notify(queue: .main) {
                        // Sort by timestamp for deterministic polyline order
                        let sorted = allLocations.sorted {
                            ($0["date"] as? String ?? "") < ($1["date"] as? String ?? "")
                        }
                        promise.resolve(sorted)
                    }
                }
                self.healthStore.execute(routeQuery)
            }
            self.healthStore.execute(workoutQuery)
        }

        // ============================================================
        // iOS 26+ Medications API
        // ============================================================

        AsyncFunction("requestMedicationPermissions") { (promise: Promise) in
            guard HKHealthStore.isHealthDataAvailable() else {
                promise.resolve(false)
                return
            }
            if #available(iOS 26.0, *) {
                Task {
                    do {
                        try await self.healthStore.requestPerObjectReadAuthorization(
                            for: HKObjectType.userAnnotatedMedicationType(),
                            predicate: nil
                        )
                        promise.resolve(true)
                    } catch {
                        self.rejectHealthKitError(
                            promise,
                            operation: "requestMedicationPermissions",
                            fallbackCode: "MEDICATION_AUTH_ERROR",
                            error: error
                        )
                    }
                }
            } else {
                self.rejectPromise(
                    promise,
                    code: "UNSUPPORTED",
                    reason: "Medications API requires iOS 26+"
                )
            }
        }

        AsyncFunction("queryMedications") { (promise: Promise) in
            guard HKHealthStore.isHealthDataAvailable() else {
                promise.resolve([])
                return
            }
            if #available(iOS 26.0, *) {
                Task {
                    do {
                        let descriptor = HKUserAnnotatedMedicationQueryDescriptor()
                        let medications = try await descriptor.result(for: self.healthStore)
                        let results: [[String: Any]] = medications.map { medication in
                            var dict: [String: Any] = [
                                "isArchived": medication.isArchived,
                                "hasSchedule": medication.hasSchedule,
                                "conceptIdentifier": medication.medication.identifier,
                                "displayName": medication.medication.displayText,
                            ]
                            if let nickname = medication.nickname {
                                dict["nickname"] = nickname
                            }
                            return dict
                        }
                        promise.resolve(results)
                    } catch {
                        self.rejectHealthKitError(
                            promise,
                            operation: "queryMedications",
                            fallbackCode: "MEDICATION_QUERY_ERROR",
                            error: error
                        )
                    }
                }
            } else {
                promise.resolve([])
            }
        }

        AsyncFunction("queryMedicationDoseEvents") { (startDateStr: String, endDateStr: String, promise: Promise) in
            guard let startDate = HealthKitQueries.parseDate(startDateStr),
                  let endDate = HealthKitQueries.parseDate(endDateStr) else {
                self.rejectPromise(
                    promise,
                    code: "INVALID_DATE",
                    reason: "Invalid ISO 8601 date format"
                )
                return
            }
            if #available(iOS 26.0, *) {
                let doseEventType = HKObjectType.medicationDoseEventType()
                let queryStartDate = self.effectiveStartDate(startDate)
                guard queryStartDate < endDate else {
                    promise.resolve([])
                    return
                }
                let predicate = HealthKitQueries.datePredicate(
                    start: queryStartDate,
                    end: endDate
                )
                let sortDescriptor = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)

                let query = HKSampleQuery(
                    sampleType: doseEventType, predicate: predicate,
                    limit: HKObjectQueryNoLimit, sortDescriptors: [sortDescriptor]
                ) { _, results, error in
                    if let error = error {
                        self.rejectHealthKitError(
                            promise,
                            operation: "queryMedicationDoseEvents",
                            fallbackCode: "QUERY_ERROR",
                            error: error
                        )
                        return
                    }
                    let samples = (results as? [HKMedicationDoseEvent])?
                        .filter {
                            self.accountStateStore.shouldInclude(
                                sampleDate: $0.startDate
                            )
                        }
                        .map { event -> [String: Any] in
                        var dict: [String: Any] = [
                            "uuid": event.uuid.uuidString,
                            "startDate": HealthKitQueries.formatDate(event.startDate),
                            "endDate": HealthKitQueries.formatDate(event.endDate),
                            "logStatus": event.logStatus.rawValue,
                            "medicationConceptIdentifier": event.medicationConceptIdentifier,
                        ]
                        if let scheduledDate = event.scheduledDate {
                            dict["scheduledDate"] = HealthKitQueries.formatDate(scheduledDate)
                        }
                        return dict
                    } ?? []
                    promise.resolve(samples)
                }
                self.healthStore.execute(query)
            } else {
                promise.resolve([])
            }
        }
    }
}
