import HealthKit
import XCTest

@testable import HealthKitLib

final class HealthKitTypesTests: XCTestCase {

    func testRunningQuantitiesAreAuthorizedAndObserved() {
        let identifiers: [HKQuantityTypeIdentifier] = [
            .runningSpeed, .runningPower, .runningStrideLength,
            .runningGroundContactTime, .runningVerticalOscillation,
        ]
        for identifier in identifiers {
            let type = HKQuantityType.quantityType(forIdentifier: identifier)!
            XCTAssertTrue(readTypes.contains(type), identifier.rawValue)
            XCTAssertTrue(backgroundDeliveryTypes.contains(type), identifier.rawValue)
        }
    }

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
            .flightsClimbed,
            .appleExerciseTime,
            .appleStandTime,
            .vo2Max,
            .walkingSpeed,
            .walkingStepLength,
            .walkingDoubleSupportPercentage,
            .walkingAsymmetryPercentage,
            .appleWalkingSteadiness,
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

    func testReadTypesContainsMenstrualFlow() {
        let menstrualFlowType = HKCategoryType.categoryType(forIdentifier: .menstrualFlow)!
        XCTAssertTrue(readTypes.contains(menstrualFlowType))
    }

    func testReadTypesContainsWorkoutType() {
        XCTAssertTrue(readTypes.contains(HKWorkoutType.workoutType()))
    }

    func testReadTypesContainsWorkoutRoute() {
        XCTAssertTrue(readTypes.contains(HKSeriesType.workoutRoute()))
    }

    func testReadTypesTotalCount() {
        // 54 quantity types + 5 category types + 1 workout type + 1 workout route = 61
        XCTAssertEqual(readTypes.count, 61)
    }

    // MARK: - backgroundDeliveryTypes

    func testBackgroundDeliveryTypesContainsSyncedTypes() {
        XCTAssertTrue(backgroundDeliveryTypes.contains(HKQuantityType.quantityType(forIdentifier: .stepCount)!))
        XCTAssertTrue(backgroundDeliveryTypes.contains(HKQuantityType.quantityType(forIdentifier: .heartRate)!))
        XCTAssertTrue(backgroundDeliveryTypes.contains(HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!))
        XCTAssertTrue(backgroundDeliveryTypes.contains(HKCategoryType.categoryType(forIdentifier: .menstrualFlow)!))
        XCTAssertTrue(backgroundDeliveryTypes.contains(HKWorkoutType.workoutType()))
        XCTAssertTrue(backgroundDeliveryTypes.contains(HKSeriesType.workoutRoute()))
    }

    func testBackgroundDeliveryTypesExcludeSamplesTheSyncPipelineDoesNotConsume() {
        XCTAssertFalse(
            backgroundDeliveryTypes.contains(
                HKQuantityType.quantityType(forIdentifier: .dietaryProtein)!
            )
        )
        XCTAssertFalse(
            backgroundDeliveryTypes.contains(
                HKCategoryType.categoryType(forIdentifier: .mindfulSession)!
            )
        )
    }

    func testBackgroundDeliveryTypesTotalCount() {
        // 23 quantity types + sleep + menstrual flow + workout + workout route.
        XCTAssertEqual(backgroundDeliveryTypes.count, 27)
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
            .vo2Max,
        ]

        for identifier in readOnlyIdentifiers {
            let type = HKQuantityType.quantityType(forIdentifier: identifier)!
            XCTAssertFalse(writeTypes.contains(type), "writeTypes should not contain \(identifier.rawValue)")
        }

        XCTAssertFalse(
            writeTypes.contains(HKCategoryType.categoryType(forIdentifier: .menstrualFlow)!)
        )
    }
}
