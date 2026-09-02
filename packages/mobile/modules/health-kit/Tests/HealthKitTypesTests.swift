import HealthKit
import XCTest

@testable import HealthKitLib

final class HealthKitTypesTests: XCTestCase {

    func testClinicalRecordIdentifiersMapEverySupportedType() {
        let expectedTypes = [
            "HKClinicalTypeIdentifierAllergyRecord": "allergy",
            "HKClinicalTypeIdentifierConditionRecord": "condition",
            "HKClinicalTypeIdentifierCoverageRecord": "coverage",
            "HKClinicalTypeIdentifierImmunizationRecord": "immunization",
            "HKClinicalTypeIdentifierLabResultRecord": "labResult",
            "HKClinicalTypeIdentifierMedicationRecord": "medication",
            "HKClinicalTypeIdentifierProcedureRecord": "procedure",
            "HKClinicalTypeIdentifierVitalSignRecord": "vitalSign",
            "HKClinicalTypeIdentifierClinicalNoteRecord": "clinicalNote",
        ]

        XCTAssertEqual(Set(clinicalRecordTypeIdentifiers), Set(expectedTypes.keys))
        for (identifier, expectedType) in expectedTypes {
            XCTAssertEqual(clinicalRecordType(for: identifier), expectedType)
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
        // 49 quantity types + 5 category types + 1 workout type + 1 workout route = 56
        var expectedCount = 56
        #if os(iOS)
        expectedCount += 7 // allergy, condition, immunization, lab, medication, procedure, vital
        if #available(iOS 16.4, *) { expectedCount += 1 } // clinicalNote
        if #available(iOS 15.0, *) { expectedCount += 1 } // coverage
        #endif
        XCTAssertEqual(readTypes.count, expectedCount)
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

    func testBackgroundDeliveryTypesExcludeAllClinicalRecords() {
        let backgroundIdentifiers = Set(backgroundDeliveryTypes.map(\.identifier))

        for identifier in clinicalRecordTypeIdentifiers {
            XCTAssertFalse(
                backgroundIdentifiers.contains(identifier),
                "Clinical type \(identifier) must remain explicit-sync only"
            )
        }
    }

    func testBackgroundDeliveryTypesTotalCount() {
        // 18 quantity types + sleep + menstrual flow + workout + workout route.
        XCTAssertEqual(backgroundDeliveryTypes.count, 22)
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
