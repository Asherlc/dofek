import HealthKit
import XCTest

@testable import HealthKitLib

final class HealthKitTypesTests: XCTestCase {

    // MARK: - readTypes

    func testReadTypesContainsQuantityTypes() {
        let quantityTypeIdentifiers: [HKQuantityTypeIdentifier] = [
            .heartRate,
            .restingHeartRate,
            .heartRateVariabilitySDNN,
            .oxygenSaturation,
            .respiratoryRate,
            .bodyMass,
            .bodyFatPercentage,
            .leanBodyMass,
            .bodyMassIndex,
            .height,
            .stepCount,
            .distanceWalkingRunning,
            .distanceCycling,
            .activeEnergyBurned,
            .basalEnergyBurned,
            .flightsClimbed,
            .appleExerciseTime,
            .appleStandTime,
            .vo2Max,
            .walkingSpeed,
            .walkingStepLength,
            .walkingDoubleSupportPercentage,
            .walkingAsymmetryPercentage,
            .dietaryEnergyConsumed,
            .dietaryProtein,
            .dietaryCarbohydrates,
            .dietaryFatTotal,
            .bodyTemperature,
            .appleSleepingWristTemperature,
            .bloodGlucose,
            .environmentalAudioExposure,
            .headphoneAudioExposure,
            .bloodPressureSystolic,
            .bloodPressureDiastolic,
            .dietaryFiber,
            .dietarySodium,
            .dietarySugar,
            .dietaryCholesterol,
            .dietaryFatSaturated,
            .dietaryPotassium,
            .dietaryVitaminA,
            .dietaryVitaminC,
            .dietaryVitaminD,
            .dietaryCalcium,
            .dietaryIron,
            .dietaryMagnesium,
            .dietaryZinc,
            .pushCount,
            .distanceWheelchair,
            .uvExposure,
            .electrodermalActivity,
        ]

        for identifier in quantityTypeIdentifiers {
            let type = HKQuantityType.quantityType(forIdentifier: identifier)!
            XCTAssertTrue(readTypes.contains(type), "readTypes should contain \(identifier.rawValue)")
        }
    }

    func testReadTypesContainsSleepAnalysis() {
        let sleepType = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!
        XCTAssertTrue(readTypes.contains(sleepType))
    }

    func testReadTypesContainsWorkoutType() {
        XCTAssertTrue(readTypes.contains(HKWorkoutType.workoutType()))
    }

    func testReadTypesContainsWorkoutRoute() {
        XCTAssertTrue(readTypes.contains(HKSeriesType.workoutRoute()))
    }

    func testReadTypesTotalCount() {
        // 51 quantity types + 5 category types + 1 workout type + 1 workout route = 58
        XCTAssertEqual(readTypes.count, 58)
    }

    // MARK: - writeTypes

    func testWriteTypesContainsDietaryTypes() {
        let dietaryIdentifiers: [HKQuantityTypeIdentifier] = [
            .dietaryEnergyConsumed,
            .dietaryProtein,
            .dietaryCarbohydrates,
            .dietaryFatTotal,
        ]

        for identifier in dietaryIdentifiers {
            let type = HKQuantityType.quantityType(forIdentifier: identifier)!
            XCTAssertTrue(writeTypes.contains(type), "writeTypes should contain \(identifier.rawValue)")
        }
    }

    func testWriteTypesTotalCount() {
        XCTAssertEqual(writeTypes.count, 4)
    }

    func testWriteTypesDoesNotContainReadOnlyTypes() {
        let readOnlyIdentifiers: [HKQuantityTypeIdentifier] = [
            .heartRate,
            .restingHeartRate,
            .bodyMass,
            .stepCount,
            .activeEnergyBurned,
            .vo2Max,
        ]

        for identifier in readOnlyIdentifiers {
            let type = HKQuantityType.quantityType(forIdentifier: identifier)!
            XCTAssertFalse(writeTypes.contains(type), "writeTypes should not contain \(identifier.rawValue)")
        }
    }
}
