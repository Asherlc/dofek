import HealthKit

/// All HealthKit types we want to read
let readTypes: Set<HKObjectType> = {
    var types = Set<HKObjectType>()
    // Quantity types
    let quantityTypes: [HKQuantityTypeIdentifier] = [
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
        // Blood pressure
        .bloodPressureSystolic,
        .bloodPressureDiastolic,
        // Dietary micronutrients
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
        // Accessibility
        .pushCount,
        .distanceWheelchair,
        // Environment
        .uvExposure,
        // Electrodermal
        .electrodermalActivity,
    ]
    for id in quantityTypes {
        if let type = HKQuantityType.quantityType(forIdentifier: id) {
            types.insert(type)
        }
    }
    // Category types
    let categoryTypes: [HKCategoryTypeIdentifier] = [
        .sleepAnalysis,
        .menstrualFlow,
        .mindfulSession,
        .handwashingEvent,
        .toothbrushingEvent,
    ]
    for id in categoryTypes {
        if let type = HKCategoryType.categoryType(forIdentifier: id) {
            types.insert(type)
        }
    }
    // Workout type
    types.insert(HKWorkoutType.workoutType())
    // Workout route (GPS data associated with workouts)
    types.insert(HKSeriesType.workoutRoute())

    // Clinical Records (FHIR data) — iOS only; not available on macOS
    #if os(iOS)
    let clinicalTypes: [HKClinicalTypeIdentifier] = [
        .allergyRecord,
        .clinicalNoteRecord,
        .conditionRecord,
        .coverageRecord,
        .immunizationRecord,
        .labResultRecord,
        .medicationRecord,
        .procedureRecord,
        .vitalSignRecord,
    ]
    for id in clinicalTypes {
        if let type = HKClinicalType.clinicalType(forIdentifier: id) {
            types.insert(type)
        }
    }
    #endif

    return types
}()

/// Types we want to write (dietary data back to HealthKit)
let writeTypes: Set<HKSampleType> = {
    var types = Set<HKSampleType>()
    let dietaryTypes: [HKQuantityTypeIdentifier] = [
        .dietaryEnergyConsumed,
        .dietaryProtein,
        .dietaryCarbohydrates,
        .dietaryFatTotal,
    ]
    for id in dietaryTypes {
        if let type = HKQuantityType.quantityType(forIdentifier: id) {
            types.insert(type)
        }
    }
    return types
}()
