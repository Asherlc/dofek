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

    func testReadTypesContainsClinicalTypes() {
        #if os(iOS)
        let clinicalIdentifiers: [HKClinicalTypeIdentifier] = [
            .allergyRecord,
            .conditionRecord,
            .immunizationRecord,
            .labResultRecord,
            .medicationRecord,
            .procedureRecord,
            .vitalSignRecord,
        ]

        for identifier in clinicalIdentifiers {
            let type = HKClinicalType.clinicalType(forIdentifier: identifier)!
            XCTAssertTrue(readTypes.contains(type), "readTypes should contain \(identifier.rawValue)")
        }

        if #available(iOS 16.4, *) {
            XCTAssertTrue(readTypes.contains(HKClinicalType.clinicalType(forIdentifier: .clinicalNoteRecord)!))
        }
        if #available(iOS 15.0, *) {
            XCTAssertTrue(readTypes.contains(HKClinicalType.clinicalType(forIdentifier: .coverageRecord)!))
        }
        #endif
    }

    func testReadTypesTotalCount() {
        // 51 quantity types + 5 category types + 1 workout type + 1 workout route = 58
        var expectedCount = 58
        #if os(iOS)
        expectedCount += 7 // allergy, condition, immunization, lab, medication, procedure, vital
        if #available(iOS 16.4, *) { expectedCount += 1 } // clinicalNote
        if #available(iOS 15.0, *) { expectedCount += 1 } // coverage
        #endif
        XCTAssertEqual(readTypes.count, expectedCount)
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

    func testDietaryWriteQuantityTypeAllowsOnlyWritableDietaryIdentifiers() {
        XCTAssertNotNil(dietaryWriteQuantityType(for: HKQuantityTypeIdentifier.dietaryEnergyConsumed.rawValue))
        XCTAssertNotNil(dietaryWriteQuantityType(for: HKQuantityTypeIdentifier.dietaryProtein.rawValue))
        XCTAssertNotNil(dietaryWriteQuantityType(for: HKQuantityTypeIdentifier.dietaryCarbohydrates.rawValue))
        XCTAssertNotNil(dietaryWriteQuantityType(for: HKQuantityTypeIdentifier.dietaryFatTotal.rawValue))

        XCTAssertNil(dietaryWriteQuantityType(for: HKQuantityTypeIdentifier.stepCount.rawValue))
        XCTAssertNil(dietaryWriteQuantityType(for: HKQuantityTypeIdentifier.heartRate.rawValue))
        XCTAssertNil(dietaryWriteQuantityType(for: "not-a-healthkit-type"))
    }
}
