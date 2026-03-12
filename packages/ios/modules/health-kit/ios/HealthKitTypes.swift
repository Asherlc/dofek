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
        .bloodGlucose,
        .environmentalAudioExposure,
        .headphoneAudioExposure,
    ]
    for id in quantityTypes {
        if let type = HKQuantityType.quantityType(forIdentifier: id) {
            types.insert(type)
        }
    }
    // Category types
    if let sleepType = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis) {
        types.insert(sleepType)
    }
    // Workout type
    types.insert(HKWorkoutType.workoutType())
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
