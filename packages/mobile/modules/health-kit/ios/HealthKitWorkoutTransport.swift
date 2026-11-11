import Foundation
import HealthKit

/// Encodes workouts and their raw recording facts for the JavaScript bridge.
enum HealthKitWorkoutTransport {
    static func encode(_ workout: HKWorkout) -> [String: Any] {
        var dict: [String: Any] = [
            "uuid": workout.uuid.uuidString,
            "workoutType": String(describing: workout.workoutActivityType.rawValue),
            "startDate": HealthKitQueries.formatDate(workout.startDate),
            "endDate": HealthKitQueries.formatDate(workout.endDate),
            "duration": workout.duration,
            "sourceName": workout.sourceRevision.source.name,
            "sourceBundle": workout.sourceRevision.source.bundleIdentifier,
        ]
        if let productType = workout.sourceRevision.productType {
            dict["sourceProductType"] = productType
        }
        if let distance = workout.totalDistance {
            dict["totalDistance"] = distance.doubleValue(for: .meter())
        }
        dict["metadata"] = transportMetadata(workout.metadata)

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
                activityDict["metadata"] = transportMetadata(activity.metadata)
                return activityDict
            }
        }
        dict["device"] = workout.device.map(Self.transportDevice)
        return dict
    }

    private static func transportMetadata(_ metadata: [String: Any]?) -> [String: Any]? {
        guard let metadata else { return nil }
        var result: [String: Any] = [:]
        for (key, value) in metadata {
            // Only bridge JSON-safe types: String, NSNumber (Int/Double/Bool), Date→ISO string.
            if let stringValue = value as? String {
                result[key] = stringValue
            } else if let numberValue = value as? NSNumber {
                result[key] = numberValue.doubleValue
            } else if let dateValue = value as? Date {
                result[key] = HealthKitQueries.formatDate(dateValue)
            }
        }
        return result.isEmpty ? nil : result
    }

    private static func transportDevice(_ device: HKDevice) -> [String: String] {
        let fields: [String: String?] = [
            "name": device.name, "model": device.model, "manufacturer": device.manufacturer,
            "hardwareVersion": device.hardwareVersion, "firmwareVersion": device.firmwareVersion,
            "softwareVersion": device.softwareVersion, "localIdentifier": device.localIdentifier,
            "udiDeviceIdentifier": device.udiDeviceIdentifier,
        ]
        return fields.compactMapValues { $0 }
    }
}
