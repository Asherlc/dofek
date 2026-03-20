import ExpoModulesCore
import HealthKit

public class HealthKitModule: Module {
    private let healthStore = HKHealthStore()

    public func definition() -> ModuleDefinition {
        Name("HealthKit")

        Function("isAvailable") {
            return HKHealthStore.isHealthDataAvailable()
        }

        AsyncFunction("requestPermissions") { (promise: Promise) in
            guard HKHealthStore.isHealthDataAvailable() else {
                promise.resolve(false)
                return
            }
            self.healthStore.requestAuthorization(toShare: writeTypes, read: readTypes) { success, error in
                if let error = error {
                    promise.reject("HEALTHKIT_AUTH_ERROR", error.localizedDescription)
                } else {
                    promise.resolve(success)
                }
            }
        }

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

            let query = HKSampleQuery(sampleType: sampleType, predicate: predicate, limit: queryLimit, sortDescriptors: [sortDescriptor]) { _, results, error in
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

            let query = HKSampleQuery(sampleType: HKWorkoutType.workoutType(), predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sortDescriptor]) { _, results, error in
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

            let query = HKSampleQuery(sampleType: sleepType, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sortDescriptor]) { _, results, error in
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

            self.healthStore.save(sample) { success, error in
                if let error = error {
                    promise.reject("WRITE_ERROR", error.localizedDescription)
                } else {
                    promise.resolve(success)
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

            let query = HKAnchoredObjectQuery(type: sampleType, predicate: nil, anchor: anchor, limit: HKObjectQueryNoLimit) { _, added, deleted, newAnchor, error in
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

                let unit = self.preferredUnit(for: quantityType)
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

        AsyncFunction("enableBackgroundDelivery") { (typeIdentifier: String, promise: Promise) in
            guard let sampleType = HKQuantityType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: typeIdentifier)) else {
                promise.reject("INVALID_TYPE", "Unknown quantity type: \(typeIdentifier)")
                return
            }

            self.healthStore.enableBackgroundDelivery(for: sampleType, frequency: .hourly) { success, error in
                if let error = error {
                    promise.reject("BG_DELIVERY_ERROR", error.localizedDescription)
                } else {
                    promise.resolve(success)
                }
            }
        }
    }

}
