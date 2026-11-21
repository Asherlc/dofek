import Foundation
import HealthKit

/// Store-independent snapshot of one reported workout-effort quantity sample.
/// The relationship query converts its `HKSample` values into these fields so the
/// selection rules stay testable without a live HealthKit store.
struct WorkoutEffortSampleSnapshot: Equatable, Sendable {
    let uuid: UUID
    let workoutUUID: UUID
    /// Non-nil when the sample belongs to a workout sub-activity rather than the whole workout.
    let activityUUID: UUID?
    let quantityTypeIdentifier: String
    let unitIdentifier: String
    let value: Double
    let startDate: Date
    let endDate: Date
    let sourceName: String
    let sourceBundle: String
}

/// Selects the single Apple-reported effort score for a whole workout.
///
/// Apple defines a 1–10 `workoutEffortScore` and a separate `estimatedWorkoutEffortScore`
/// ([Apple effort rating](https://www.apple.com/newsroom/2024/09/watchos-11-is-available-today/)).
/// The relationship query returns all candidates so the selector can exclude estimates
/// and sub-activity ratings. Multiple qualified whole-workout samples remain ambiguous.
enum HealthKitWorkoutEffortSelection {
    static let reportedTypeIdentifier = "HKQuantityTypeIdentifierWorkoutEffortScore"
    static let appleEffortScoreUnitIdentifier = "appleEffortScore"

    @available(iOS 18.0, macOS 15.0, *)
    static func relationshipQuery(predicate: NSPredicate) -> HKWorkoutEffortRelationshipQueryDescriptor {
        HKWorkoutEffortRelationshipQueryDescriptor(predicate: predicate, anchor: nil, option: .default)
    }

    static func select(
        for workoutUUID: UUID,
        from candidates: [WorkoutEffortSampleSnapshot]
    ) -> WorkoutEffortSampleSnapshot? {
        let qualified = candidates
            .filter { $0.workoutUUID == workoutUUID }
            .filter { $0.activityUUID == nil }
            .filter { $0.quantityTypeIdentifier == reportedTypeIdentifier }
            .filter { $0.unitIdentifier == appleEffortScoreUnitIdentifier }
            .filter { $0.value.isFinite && (1.0...10.0).contains($0.value) }
        guard qualified.count == 1 else {
            return nil
        }
        return qualified[0]
    }
}

extension HealthKitWorkoutTransport {
    /// Bridges the sample bounds and source of the effort sample; the Apple unit and type are
    /// implicit in this transport field and documented on the TypeScript bridge type.
    static func encodeEffort(_ sample: WorkoutEffortSampleSnapshot) -> [String: Any] {
        [
            "uuid": sample.uuid.uuidString,
            "value": sample.value,
            "startDate": HealthKitQueries.formatDate(sample.startDate),
            "endDate": HealthKitQueries.formatDate(sample.endDate),
            "sourceName": sample.sourceName,
            "sourceBundle": sample.sourceBundle,
        ]
    }

    /// Encodes a workout with its optional whole-workout effort score. A missing or unreadable
    /// rating leaves the workout import unchanged and the `workoutEffort` key absent.
    static func encode(_ workout: HKWorkout, effort: WorkoutEffortSampleSnapshot?) -> [String: Any] {
        var dict = encode(workout)
        if let effort {
            dict["workoutEffort"] = encodeEffort(effort)
        }
        return dict
    }
}
