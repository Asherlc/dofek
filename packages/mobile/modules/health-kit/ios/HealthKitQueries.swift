import HealthKit

struct ClinicalRecordMappingInput {
    let clinicalRecordUUID: UUID
    let clinicalTypeIdentifier: String
    let clinicalDisplayName: String
    let clinicalSourceName: String
    let clinicalFHIRVersion: String?
    let clinicalFHIRData: Data?
    let clinicalDownloadDate: Date
}

private enum ClinicalRecordMappingError: LocalizedError {
    case invalidFHIRPayload
    case missingFHIRPayload
    case unsupportedClinicalType

    var errorDescription: String? {
        switch self {
        case .invalidFHIRPayload:
            return "The clinical record FHIR payload is not a JSON object."
        case .missingFHIRPayload:
            return "The clinical record does not contain a FHIR payload and version."
        case .unsupportedClinicalType:
            return "The clinical record has an unsupported HealthKit type."
        }
    }
}

/// Common query patterns used by the HealthKit module
enum HealthKitQueries {
    static func mapClinicalRecord(
        _ sample: ClinicalRecordMappingInput
    ) throws -> [String: Any] {
        guard let clinicalType = clinicalRecordType(for: sample.clinicalTypeIdentifier) else {
            throw ClinicalRecordMappingError.unsupportedClinicalType
        }
        guard let fhirVersion = sample.clinicalFHIRVersion,
              let fhirData = sample.clinicalFHIRData else {
            throw ClinicalRecordMappingError.missingFHIRPayload
        }
        guard let fhir = try? JSONSerialization.jsonObject(with: fhirData),
              let fhirObject = fhir as? [String: Any] else {
            throw ClinicalRecordMappingError.invalidFHIRPayload
        }

        return [
            "uuid": sample.clinicalRecordUUID.uuidString,
            "clinicalType": clinicalType,
            "displayName": sample.clinicalDisplayName,
            "sourceName": sample.clinicalSourceName,
            "fhirVersion": fhirVersion,
            "fhir": fhirObject,
            "downloadedAt": formatInstant(sample.clinicalDownloadDate),
        ]
    }

    /// Bridge a workout and its optional recording-device facts.
    static func transportWorkout(_ workout: HKWorkout) -> [String: Any] {
        var dict: [String: Any] = [
            "uuid": workout.uuid.uuidString,
            "workoutType": String(describing: workout.workoutActivityType.rawValue),
            "startDate": Self.formatDate(workout.startDate),
            "endDate": Self.formatDate(workout.endDate),
            "duration": workout.duration,
            "sourceName": workout.sourceRevision.source.name,
            "sourceBundle": workout.sourceRevision.source.bundleIdentifier,
        ]
        if let distance = workout.totalDistance {
            dict["totalDistance"] = distance.doubleValue(for: .meter())
        }

        // Include workout-level metadata (arbitrary key-value pairs set by the recording app)
        if let metadata = workout.metadata, !metadata.isEmpty {
            var metadataDict: [String: Any] = [:]
            for (key, value) in metadata {
                // Only bridge JSON-safe types: String, NSNumber (Int/Double/Bool), Date→ISO string
                if let stringValue = value as? String {
                    metadataDict[key] = stringValue
                } else if let numberValue = value as? NSNumber {
                    metadataDict[key] = numberValue.doubleValue
                } else if let dateValue = value as? Date {
                    metadataDict[key] = Self.formatDate(dateValue)
                }
            }
            if !metadataDict.isEmpty {
                dict["metadata"] = metadataDict
            }
        }

        // Include sub-activities (iOS 16+): each HKWorkoutActivity within the workout
        let activities = workout.workoutActivities
        if !activities.isEmpty {
            dict["workoutActivities"] = activities.map { activity -> [String: Any] in
                var activityDict: [String: Any] = [
                    "uuid": activity.uuid.uuidString,
                    "activityType": activity.workoutConfiguration.activityType.rawValue,
                    "startDate": Self.formatDate(activity.startDate),
                ]
                if let endDate = activity.endDate {
                    activityDict["endDate"] = Self.formatDate(endDate)
                }
                if let activityMetadata = activity.metadata, !activityMetadata.isEmpty {
                    var activityMetaDict: [String: Any] = [:]
                    for (key, value) in activityMetadata {
                        if let stringValue = value as? String {
                            activityMetaDict[key] = stringValue
                        } else if let numberValue = value as? NSNumber {
                            activityMetaDict[key] = numberValue.doubleValue
                        } else if let dateValue = value as? Date {
                            activityMetaDict[key] = Self.formatDate(dateValue)
                        }
                    }
                    if !activityMetaDict.isEmpty {
                        activityDict["metadata"] = activityMetaDict
                    }
                }
                return activityDict
            }
        }
        dict["device"] = workout.device.map(Self.transportDevice)
        return dict
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

    /// Resolve raw HealthKit identifiers used by generic sample queries.
    static func sampleType(for identifier: String) -> HKSampleType? {
        if let quantityType = HKQuantityType.quantityType(
            forIdentifier: HKQuantityTypeIdentifier(rawValue: identifier)
        ) {
            return quantityType
        }
        return HKCategoryType.categoryType(
            forIdentifier: HKCategoryTypeIdentifier(rawValue: identifier)
        )
    }

    /// Convert quantity and category samples into the shared JS transport shape.
    static func transportSample(
        _ sample: HKSample,
        typeIdentifier: String
    ) -> [String: Any]? {
        var result: [String: Any] = [
            "type": typeIdentifier,
            "startDate": formatDate(sample.startDate),
            "endDate": formatDate(sample.endDate),
            "sourceName": sample.sourceRevision.source.name,
            "sourceBundle": sample.sourceRevision.source.bundleIdentifier,
            "uuid": sample.uuid.uuidString,
        ]

        if let quantitySample = sample as? HKQuantitySample,
           let quantityType = sample.sampleType as? HKQuantityType {
            let unit = preferredUnit(for: quantityType)
            result["value"] = quantitySample.quantity.doubleValue(for: unit)
            result["unit"] = unit.unitString
            return result
        }

        if let categorySample = sample as? HKCategorySample {
            result["value"] = categorySample.value
            result["unit"] = "category"
            let cycleStart = (categorySample.metadata?[HKMetadataKeyMenstrualCycleStart] as? NSNumber)?
                .boolValue ?? false
            result["metadata"] = [HKMetadataKeyMenstrualCycleStart: cycleStart]
            return result
        }

        return nil
    }

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

    /// Format a date as a server-compatible absolute instant.
    static func formatInstant(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime]
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
             HKQuantityTypeIdentifier.walkingAsymmetryPercentage.rawValue,
             HKQuantityTypeIdentifier.appleWalkingSteadiness.rawValue:
            return .percent()
        case HKQuantityTypeIdentifier.height.rawValue:
            return .meterUnit(with: .centi)
        case HKQuantityTypeIdentifier.heartRateVariabilitySDNN.rawValue:
            return .secondUnit(with: .milli)
        case HKQuantityTypeIdentifier.distanceWalkingRunning.rawValue:
            return .meter()
        case HKQuantityTypeIdentifier.dietaryEnergyConsumed.rawValue:
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
