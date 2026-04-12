import HealthKit

/// Common query patterns used by the HealthKit module
enum HealthKitQueries {
    /// Build a date predicate for sample queries
    static func datePredicate(start: Date, end: Date) -> NSPredicate {
        return HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
    }

    /// Parse an ISO 8601 date string (with or without fractional seconds)
    static func parseDate(_ dateString: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: dateString) {
            return date
        }
        // Retry without fractional seconds for dates like "2024-03-01T10:30:00Z"
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: dateString)
    }

    /// Format a date to ISO 8601 string with local timezone offset.
    /// Using the local timezone ensures that `isoString.prefix(10)` on the
    /// server produces the correct calendar date for the user. Without this,
    /// evening readings get assigned to the next UTC day and can cause the
    /// wrong HRV value to be selected as the "overnight" reading.
    static func formatDate(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = .current
        return formatter.string(from: date)
    }

    // swiftlint:disable cyclomatic_complexity function_body_length
    /// Return the preferred unit for a given quantity type
    static func preferredUnit(for quantityType: HKQuantityType) -> HKUnit {
        switch quantityType.identifier {
        case HKQuantityTypeIdentifier.heartRate.rawValue,
             HKQuantityTypeIdentifier.restingHeartRate.rawValue:
            return HKUnit.count().unitDivided(by: .minute())
        case HKQuantityTypeIdentifier.bodyMass.rawValue,
             HKQuantityTypeIdentifier.leanBodyMass.rawValue:
            return .gramUnit(with: .kilo)
        case HKQuantityTypeIdentifier.bodyFatPercentage.rawValue,
             HKQuantityTypeIdentifier.oxygenSaturation.rawValue,
             HKQuantityTypeIdentifier.walkingDoubleSupportPercentage.rawValue,
             HKQuantityTypeIdentifier.walkingAsymmetryPercentage.rawValue:
            return .percent()
        case HKQuantityTypeIdentifier.height.rawValue:
            return .meterUnit(with: .centi)
        case HKQuantityTypeIdentifier.heartRateVariabilitySDNN.rawValue:
            return .secondUnit(with: .milli)
        case HKQuantityTypeIdentifier.distanceWalkingRunning.rawValue,
             HKQuantityTypeIdentifier.distanceCycling.rawValue:
            return .meter()
        case HKQuantityTypeIdentifier.activeEnergyBurned.rawValue,
             HKQuantityTypeIdentifier.basalEnergyBurned.rawValue,
             HKQuantityTypeIdentifier.dietaryEnergyConsumed.rawValue:
            return .kilocalorie()
        case HKQuantityTypeIdentifier.stepCount.rawValue,
             HKQuantityTypeIdentifier.flightsClimbed.rawValue:
            return .count()
        case HKQuantityTypeIdentifier.appleExerciseTime.rawValue,
             HKQuantityTypeIdentifier.appleStandTime.rawValue:
            return .minute()
        case HKQuantityTypeIdentifier.respiratoryRate.rawValue:
            return HKUnit.count().unitDivided(by: .minute())
        case HKQuantityTypeIdentifier.vo2Max.rawValue:
            return HKUnit(from: "mL/kg*min")
        case HKQuantityTypeIdentifier.walkingSpeed.rawValue:
            return HKUnit.meter().unitDivided(by: .second())
        case HKQuantityTypeIdentifier.walkingStepLength.rawValue:
            return .meterUnit(with: .centi)
        case HKQuantityTypeIdentifier.bodyTemperature.rawValue,
             HKQuantityTypeIdentifier.appleSleepingWristTemperature.rawValue:
            return .degreeCelsius()
        case HKQuantityTypeIdentifier.bloodGlucose.rawValue:
            return HKUnit(from: "mmol/L")
        case HKQuantityTypeIdentifier.environmentalAudioExposure.rawValue,
             HKQuantityTypeIdentifier.headphoneAudioExposure.rawValue:
            return .decibelAWeightedSoundPressureLevel()
        case HKQuantityTypeIdentifier.dietaryProtein.rawValue,
             HKQuantityTypeIdentifier.dietaryCarbohydrates.rawValue,
             HKQuantityTypeIdentifier.dietaryFatTotal.rawValue,
             HKQuantityTypeIdentifier.dietaryFiber.rawValue,
             HKQuantityTypeIdentifier.dietarySugar.rawValue,
             HKQuantityTypeIdentifier.dietaryFatSaturated.rawValue:
            return .gram()
        case HKQuantityTypeIdentifier.dietarySodium.rawValue,
             HKQuantityTypeIdentifier.dietaryCholesterol.rawValue,
             HKQuantityTypeIdentifier.dietaryPotassium.rawValue,
             HKQuantityTypeIdentifier.dietaryCalcium.rawValue,
             HKQuantityTypeIdentifier.dietaryIron.rawValue,
             HKQuantityTypeIdentifier.dietaryMagnesium.rawValue,
             HKQuantityTypeIdentifier.dietaryZinc.rawValue,
             HKQuantityTypeIdentifier.dietaryVitaminC.rawValue:
            return .gramUnit(with: .milli)
        case HKQuantityTypeIdentifier.dietaryVitaminA.rawValue,
             HKQuantityTypeIdentifier.dietaryVitaminD.rawValue:
            return .gramUnit(with: .micro)
        case HKQuantityTypeIdentifier.bloodPressureSystolic.rawValue,
             HKQuantityTypeIdentifier.bloodPressureDiastolic.rawValue:
            return .millimeterOfMercury()
        case HKQuantityTypeIdentifier.electrodermalActivity.rawValue:
            return .siemen()
        case HKQuantityTypeIdentifier.pushCount.rawValue:
            return .count()
        case HKQuantityTypeIdentifier.distanceWheelchair.rawValue:
            return .meter()
        case HKQuantityTypeIdentifier.uvExposure.rawValue:
            return .count()
        default:
            return .count()
        }
    }
    // swiftlint:enable cyclomatic_complexity function_body_length
}
