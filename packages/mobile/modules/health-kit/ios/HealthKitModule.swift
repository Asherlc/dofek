// swiftlint:disable file_length
import ExpoModulesCore
import HealthKit

// swiftlint:disable:next type_body_length
public class HealthKitModule: Module {
    private let healthStore = HKHealthStore()
    private var observerQueries: [HKObserverQuery] = []

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    public func definition() -> ModuleDefinition {
        Name("HealthKit")

        Events("onHealthKitSampleUpdate")

        Function("isAvailable") {
            return HKHealthStore.isHealthDataAvailable()
        }

        /// Returns true if the user has ever completed the HealthKit authorization flow.
        /// Uses a UserDefaults flag set by requestPermissions, with a one-time migration
        /// that checks write-type authorization status for users who authorized before
        /// this flag was introduced.
        Function("hasEverAuthorized") {
            let key = "healthkit_has_ever_authorized"
            if UserDefaults.standard.bool(forKey: key) {
                return true
            }
            // Migration: check if any write type was previously authorized.
            // Apple exposes authorization status for write types (not read types).
            // If a write type is .sharingAuthorized or .sharingDenied, the user
            // has been through the authorization flow before.
            for writeType in writeTypes {
                let status = self.healthStore.authorizationStatus(for: writeType)
                if status == .sharingAuthorized || status == .sharingDenied {
                    UserDefaults.standard.set(true, forKey: key)
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
                        promise.resolve("unnecessary")
                    case .shouldRequest:
                        promise.resolve("shouldRequest")
                    default:
                        promise.resolve("unknown")
                    }
                } catch {
                    promise.reject("HEALTHKIT_STATUS_ERROR", error.localizedDescription)
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
                    UserDefaults.standard.set(true, forKey: "healthkit_has_ever_authorized")
                    promise.resolve(true)
                } catch {
                    promise.reject("HEALTHKIT_AUTH_ERROR", error.localizedDescription)
                }
            }
        }

        // swiftlint:disable:next line_length
        AsyncFunction("queryQuantitySamples") { (typeIdentifier: String, startDateStr: String, endDateStr: String, limit: Int, promise: Promise) in
            guard let sampleType = HKQuantityType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: typeIdentifier)) else {
                promise.reject("INVALID_TYPE", "Unknown quantity type: \(typeIdentifier)")
                return
            }
            guard let startDate = HealthKitQueries.parseDate(startDateStr),
                  let endDate = HealthKitQueries.parseDate(endDateStr) else {
                promise.reject("INVALID_DATE", "Invalid ISO 8601 date format")
                return
            }

            let predicate = HealthKitQueries.datePredicate(start: startDate, end: endDate)
            let sortDescriptor = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
            let queryLimit = limit > 0 ? limit : HKObjectQueryNoLimit

            let query = HKSampleQuery(
                sampleType: sampleType, predicate: predicate,
                limit: queryLimit, sortDescriptors: [sortDescriptor]
            ) { _, results, error in
                if let error = error {
                    promise.reject("QUERY_ERROR", error.localizedDescription)
                    return
                }
                let samples = (results as? [HKQuantitySample])?.map { sample -> [String: Any] in
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
                promise.reject("INVALID_DATE", "Invalid ISO 8601 date format")
                return
            }

            let predicate = HealthKitQueries.datePredicate(start: startDate, end: endDate)
            let sortDescriptor = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)

            let query = HKSampleQuery(
                sampleType: HKWorkoutType.workoutType(), predicate: predicate,
                limit: HKObjectQueryNoLimit, sortDescriptors: [sortDescriptor]
            ) { _, results, error in
                if let error = error {
                    promise.reject("QUERY_ERROR", error.localizedDescription)
                    return
                }
                let workouts = (results as? [HKWorkout])?.map { workout -> [String: Any] in
                    var dict: [String: Any] = [
                        "uuid": workout.uuid.uuidString,
                        "workoutType": String(describing: workout.workoutActivityType.rawValue),
                        "startDate": HealthKitQueries.formatDate(workout.startDate),
                        "endDate": HealthKitQueries.formatDate(workout.endDate),
                        "duration": workout.duration,
                        "sourceName": workout.sourceRevision.source.name,
                        "sourceBundle": workout.sourceRevision.source.bundleIdentifier,
                    ]
                    if let energy = workout.totalEnergyBurned {
                        dict["totalEnergyBurned"] = energy.doubleValue(for: .kilocalorie())
                    }
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
                promise.reject("INVALID_TYPE", "Sleep analysis type not available")
                return
            }
            guard let startDate = HealthKitQueries.parseDate(startDateStr),
                  let endDate = HealthKitQueries.parseDate(endDateStr) else {
                promise.reject("INVALID_DATE", "Invalid ISO 8601 date format")
                return
            }

            let predicate = HealthKitQueries.datePredicate(start: startDate, end: endDate)
            let sortDescriptor = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)

            let query = HKSampleQuery(
                sampleType: sleepType, predicate: predicate,
                limit: HKObjectQueryNoLimit, sortDescriptors: [sortDescriptor]
            ) { _, results, error in
                if let error = error {
                    promise.reject("QUERY_ERROR", error.localizedDescription)
                    return
                }
                let samples = (results as? [HKCategorySample])?.map { sample -> [String: Any] in
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
                promise.reject("INVALID_TYPE", "Unknown category type: \(typeIdentifier)")
                return
            }
            guard let startDate = HealthKitQueries.parseDate(startDateStr),
                  let endDate = HealthKitQueries.parseDate(endDateStr) else {
                promise.reject("INVALID_DATE", "Invalid ISO 8601 date format")
                return
            }

            let predicate = HealthKitQueries.datePredicate(start: startDate, end: endDate)
            let sortDescriptor = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)

            let query = HKSampleQuery(
                sampleType: categoryType, predicate: predicate,
                limit: HKObjectQueryNoLimit, sortDescriptors: [sortDescriptor]
            ) { _, results, error in
                if let error = error {
                    promise.reject("QUERY_ERROR", error.localizedDescription)
                    return
                }
                let samples = (results as? [HKCategorySample])?.map { sample -> [String: Any] in
                    return [
                        "uuid": sample.uuid.uuidString,
                        "type": typeIdentifier,
                        "value": sample.value,
                        "startDate": HealthKitQueries.formatDate(sample.startDate),
                        "endDate": HealthKitQueries.formatDate(sample.endDate),
                        "sourceName": sample.sourceRevision.source.name,
                        "sourceBundle": sample.sourceRevision.source.bundleIdentifier,
                    ]
                } ?? []
                promise.resolve(samples)
            }
            self.healthStore.execute(query)
        }

        AsyncFunction("writeDietaryEnergy") { (calories: Double, dateStr: String, promise: Promise) in
            guard let type = HKQuantityType.quantityType(forIdentifier: .dietaryEnergyConsumed) else {
                promise.reject("INVALID_TYPE", "Dietary energy type not available")
                return
            }
            guard let date = HealthKitQueries.parseDate(dateStr) else {
                promise.reject("INVALID_DATE", "Invalid ISO 8601 date format")
                return
            }

            let quantity = HKQuantity(unit: .kilocalorie(), doubleValue: calories)
            let sample = HKQuantitySample(type: type, quantity: quantity, start: date, end: date)

            Task {
                do {
                    try await self.healthStore.save(sample)
                    promise.resolve(true)
                } catch {
                    promise.reject("WRITE_ERROR", error.localizedDescription)
                }
            }
        }

        AsyncFunction("getAnchor") { (typeIdentifier: String, promise: Promise) in
            // Anchors are stored in UserDefaults for persistence across app launches
            let key = "healthkit_anchor_\(typeIdentifier)"
            let anchor = UserDefaults.standard.integer(forKey: key)
            promise.resolve(anchor)
        }

        AsyncFunction("queryAnchoredSamples") { (typeIdentifier: String, anchorValue: Int, promise: Promise) in
            guard let sampleType = HKQuantityType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: typeIdentifier)) else {
                promise.reject("INVALID_TYPE", "Unknown quantity type: \(typeIdentifier)")
                return
            }

            // Reconstruct anchor from stored integer (simplified - real impl would use HKQueryAnchor)
            let anchor: HKQueryAnchor? = anchorValue > 0 ? HKQueryAnchor(fromValue: anchorValue) : nil

            let query = HKAnchoredObjectQuery(
                type: sampleType, predicate: nil, anchor: anchor,
                limit: HKObjectQueryNoLimit
            ) { _, added, deleted, newAnchor, error in
                if let error = error {
                    promise.reject("QUERY_ERROR", error.localizedDescription)
                    return
                }

                let samples = (added as? [HKQuantitySample])?.map { sample -> [String: Any] in
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

                let deletedUUIDs = deleted?.map { $0.uuid.uuidString } ?? []

                // Store new anchor for next incremental query
                if let newAnchor = newAnchor {
                    let key = "healthkit_anchor_\(typeIdentifier)"
                    // HKQueryAnchor doesn't expose its value directly, so we encode it
                    if let encoded = try? NSKeyedArchiver.archivedData(withRootObject: newAnchor, requiringSecureCoding: true) {
                        UserDefaults.standard.set(encoded, forKey: key)
                    }
                }

                promise.resolve([
                    "samples": samples,
                    "deletedUUIDs": deletedUUIDs,
                    "newAnchor": 0, // Opaque - use getAnchor() to retrieve
                ] as [String: Any])
            }
            self.healthStore.execute(query)
        }

        AsyncFunction("queryDailyStatistics") { (typeIdentifier: String, startDateStr: String, endDateStr: String, promise: Promise) in
            guard let quantityType = HKQuantityType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: typeIdentifier)) else {
                promise.reject("INVALID_TYPE", "Unknown quantity type: \(typeIdentifier)")
                return
            }
            guard let startDate = HealthKitQueries.parseDate(startDateStr),
                  let endDate = HealthKitQueries.parseDate(endDateStr) else {
                promise.reject("INVALID_DATE", "Invalid ISO 8601 date format")
                return
            }

            let calendar = Calendar.current
            let interval = DateComponents(day: 1)
            let anchorDate = calendar.startOfDay(for: startDate)

            let query = HKStatisticsCollectionQuery(
                quantityType: quantityType,
                quantitySamplePredicate: HealthKitQueries.datePredicate(start: startDate, end: endDate),
                options: .cumulativeSum,
                anchorDate: anchorDate,
                intervalComponents: interval
            )

            query.initialResultsHandler = { _, results, error in
                if let error = error {
                    promise.reject("QUERY_ERROR", error.localizedDescription)
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
                results.enumerateStatistics(from: startDate, to: endDate) { statistics, _ in
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
            return UserDefaults.standard.bool(forKey: "healthkit_background_delivery_enabled")
        }

        AsyncFunction("enableBackgroundDelivery") { (typeIdentifier: String, promise: Promise) in
            guard let sampleType = HKQuantityType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: typeIdentifier)) else {
                promise.reject("INVALID_TYPE", "Unknown quantity type: \(typeIdentifier)")
                return
            }

            Task {
                do {
                    try await self.healthStore.enableBackgroundDelivery(for: sampleType, frequency: .hourly)
                    UserDefaults.standard.set(true, forKey: "healthkit_background_delivery_enabled")
                    promise.resolve(true)
                } catch {
                    promise.reject("BG_DELIVERY_ERROR", error.localizedDescription)
                }
            }
        }

        AsyncFunction("setupBackgroundObservers") { (promise: Promise) in
            guard HKHealthStore.isHealthDataAvailable() else {
                promise.resolve(false)
                return
            }

            // Remove any existing observer queries
            for query in self.observerQueries {
                self.healthStore.stop(query)
            }
            self.observerQueries.removeAll()

            // Set up an observer for each read type
            for objectType in readTypes {
                guard let sampleType = objectType as? HKSampleType else { continue }

                let query = HKObserverQuery(sampleType: sampleType, predicate: nil) { [weak self] _, completionHandler, error in
                    if error == nil {
                        self?.sendEvent("onHealthKitSampleUpdate", [
                            "typeIdentifier": sampleType.identifier,
                        ])
                    }
                    completionHandler()
                }
                self.observerQueries.append(query)
                self.healthStore.execute(query)
            }

            promise.resolve(true)
        }

        // ============================================================
        // Workout Route (GPS) queries
        // ============================================================

        AsyncFunction("queryWorkoutRoutes") { (workoutUuid: String, promise: Promise) in
            guard let uuid = UUID(uuidString: workoutUuid) else {
                promise.reject("INVALID_UUID", "Invalid workout UUID: \(workoutUuid)")
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
                    promise.reject("QUERY_ERROR", error.localizedDescription)
                    return
                }
                guard let workout = results?.first as? HKWorkout else {
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
                        promise.reject("ROUTE_QUERY_ERROR", routeError.localizedDescription)
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
                        promise.reject("MEDICATION_AUTH_ERROR", error.localizedDescription)
                    }
                }
            } else {
                promise.reject("UNSUPPORTED", "Medications API requires iOS 26+")
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
                        promise.reject("MEDICATION_QUERY_ERROR", error.localizedDescription)
                    }
                }
            } else {
                promise.resolve([])
            }
        }

        AsyncFunction("queryMedicationDoseEvents") { (startDateStr: String, endDateStr: String, promise: Promise) in
            guard let startDate = HealthKitQueries.parseDate(startDateStr),
                  let endDate = HealthKitQueries.parseDate(endDateStr) else {
                promise.reject("INVALID_DATE", "Invalid ISO 8601 date format")
                return
            }
            if #available(iOS 26.0, *) {
                let doseEventType = HKObjectType.medicationDoseEventType()
                let predicate = HealthKitQueries.datePredicate(start: startDate, end: endDate)
                let sortDescriptor = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)

                let query = HKSampleQuery(
                    sampleType: doseEventType, predicate: predicate,
                    limit: HKObjectQueryNoLimit, sortDescriptors: [sortDescriptor]
                ) { _, results, error in
                    if let error = error {
                        promise.reject("QUERY_ERROR", error.localizedDescription)
                        return
                    }
                    let samples = (results as? [HKMedicationDoseEvent])?.map { event -> [String: Any] in
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
