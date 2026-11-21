import Foundation
import HealthKit
import XCTest

@testable import HealthKitLib

/// Native selection and bridge coverage for Apple's reported workout effort score.
/// The fixtures are store-independent snapshots so the selection rules are testable
/// without a live HealthKit relationship query.
final class HealthKitWorkoutEffortTests: XCTestCase {
    private let workoutUUID = UUID()
    private let otherWorkoutUUID = UUID()

    private func sample(
        value: Double = 7,
        workoutUUID: UUID? = nil,
        activityUUID: UUID? = nil,
        type: String = HealthKitWorkoutEffortSelection.reportedTypeIdentifier,
        unit: String = HealthKitWorkoutEffortSelection.appleEffortScoreUnitIdentifier,
        start: Date = Date(timeIntervalSince1970: 1_700_000_000),
        end: Date = Date(timeIntervalSince1970: 1_700_000_600),
        sourceName: String = "Apple Watch",
        sourceBundle: String = "com.apple.health"
    ) -> WorkoutEffortSampleSnapshot {
        WorkoutEffortSampleSnapshot(
            uuid: UUID(),
            workoutUUID: workoutUUID ?? self.workoutUUID,
            activityUUID: activityUUID,
            quantityTypeIdentifier: type,
            unitIdentifier: unit,
            value: value,
            startDate: start,
            endDate: end,
            sourceName: sourceName,
            sourceBundle: sourceBundle
        )
    }

    func testSelectsReportedWholeWorkoutSevenAndBridgesIdentityAndSource() throws {
        let effort = sample(value: 7, sourceName: "Fitness", sourceBundle: "com.apple.fitness")

        let selected = try XCTUnwrap(
            HealthKitWorkoutEffortSelection.select(for: workoutUUID, from: [effort])
        )
        XCTAssertEqual(selected, effort)

        let encoded = HealthKitWorkoutTransport.encodeEffort(selected)
        XCTAssertEqual(encoded["uuid"] as? String, effort.uuid.uuidString)
        XCTAssertEqual(encoded["value"] as? Double, 7)
        XCTAssertEqual(encoded["startDate"] as? String, HealthKitQueries.formatDate(effort.startDate))
        XCTAssertEqual(encoded["endDate"] as? String, HealthKitQueries.formatDate(effort.endDate))
        XCTAssertEqual(encoded["sourceName"] as? String, "Fitness")
        XCTAssertEqual(encoded["sourceBundle"] as? String, "com.apple.fitness")
    }

    func testWorkoutBridgeCarriesWorkoutEffortWhenPresent() throws {
        let workout = HKWorkout(
            activityType: .cycling,
            start: Date(timeIntervalSince1970: 1_700_000_000),
            end: Date(timeIntervalSince1970: 1_700_000_600),
            duration: 600,
            totalEnergyBurned: nil,
            totalDistance: nil,
            device: nil,
            metadata: nil
        )
        let effort = sample(value: 7)

        let encoded = HealthKitWorkoutTransport.encode(workout, effort: effort)
        let carried = try XCTUnwrap(encoded["workoutEffort"] as? [String: Any])
        XCTAssertEqual(carried["value"] as? Double, 7)
        XCTAssertEqual(carried["uuid"] as? String, effort.uuid.uuidString)
    }

    func testWorkoutBridgeOmitsWorkoutEffortWhenAbsent() {
        let workout = HKWorkout(
            activityType: .cycling,
            start: Date(),
            end: Date(),
            duration: 0,
            totalEnergyBurned: nil,
            totalDistance: nil,
            device: nil,
            metadata: nil
        )

        XCTAssertNil(HealthKitWorkoutTransport.encode(workout, effort: nil)["workoutEffort"])
    }

    func testExcludesSeparatelyEstimatedEffort() {
        let estimated = sample(type: "HKQuantityTypeIdentifierEstimatedWorkoutEffortScore")

        XCTAssertNil(HealthKitWorkoutEffortSelection.select(for: workoutUUID, from: [estimated]))
    }

    func testExcludesSubActivityOnlyEffort() {
        let subActivity = sample(activityUUID: UUID())

        XCTAssertNil(HealthKitWorkoutEffortSelection.select(for: workoutUUID, from: [subActivity]))
    }

    func testExcludesWrongUnitAndOutOfRangeValues() {
        let wrongUnit = sample(unit: "count")
        let tooLow = sample(value: 0.5)
        let tooHigh = sample(value: 10.5)
        let notFinite = sample(value: Double.nan)

        XCTAssertNil(HealthKitWorkoutEffortSelection.select(for: workoutUUID, from: [wrongUnit]))
        XCTAssertNil(HealthKitWorkoutEffortSelection.select(for: workoutUUID, from: [tooLow]))
        XCTAssertNil(HealthKitWorkoutEffortSelection.select(for: workoutUUID, from: [tooHigh]))
        XCTAssertNil(HealthKitWorkoutEffortSelection.select(for: workoutUUID, from: [notFinite]))
    }

    func testExcludesEffortBelongingToAnotherWorkout() {
        let other = sample(workoutUUID: otherWorkoutUUID)

        XCTAssertNil(HealthKitWorkoutEffortSelection.select(for: workoutUUID, from: [other]))
    }

    func testRelationshipQueryReturnsAllCandidatesForReportedEffortSelection() throws {
        guard #available(iOS 18.0, macOS 15.0, *) else {
            throw XCTSkip("Workout effort relationships require iOS 18 or macOS 15")
        }
        let query = HealthKitWorkoutEffortSelection.relationshipQuery(predicate: NSPredicate(value: true))
        XCTAssertEqual(query.option, .default)
    }

    func testMultipleWholeWorkoutCandidatesAreAmbiguousWithoutInventedRank() {
        let earlier = sample(
            value: 6,
            start: Date(timeIntervalSince1970: 1_700_000_000),
            end: Date(timeIntervalSince1970: 1_700_000_600)
        )
        let later = sample(
            value: 8,
            start: Date(timeIntervalSince1970: 1_700_010_000),
            end: Date(timeIntervalSince1970: 1_700_010_600)
        )

        XCTAssertNil(
            HealthKitWorkoutEffortSelection.select(for: workoutUUID, from: [earlier, later])
        )
        XCTAssertNil(
            HealthKitWorkoutEffortSelection.select(for: workoutUUID, from: [later, earlier])
        )
    }
}
