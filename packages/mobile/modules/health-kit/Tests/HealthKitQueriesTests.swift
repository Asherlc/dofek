import HealthKit
import XCTest

@testable import HealthKitLib

private final class WorkoutSource: HKSource, @unchecked Sendable {
    override var name: String { "Fitness" }
    override var bundleIdentifier: String { "com.apple.fitness" }
}

private final class WatchWorkout: HKWorkout, @unchecked Sendable {
    override var sourceRevision: HKSourceRevision {
        // SwiftPM has no app bundle, so HKSource.default() cannot supply a test source.
        // Decode an HKSource test double and override its public identity properties.
        let archiver = NSKeyedArchiver(requiringSecureCoding: true)
        archiver.finishEncoding()
        let decoder = try! NSKeyedUnarchiver(forReadingFrom: archiver.encodedData)
        let source = WorkoutSource(coder: decoder)!
        return HKSourceRevision(source: source, version: "1.0", productType: "Watch7,12",
                         operatingSystemVersion: OperatingSystemVersion(majorVersion: 26, minorVersion: 0, patchVersion: 0))
    }
}

final class HealthKitQueriesTests: XCTestCase {

    func testWorkoutTransportRetainsSourceProductTypeSeparatelyFromGenericDeviceModel() {
        let workout = WatchWorkout(activityType: .running, start: Date(), end: Date(), duration: 0,
                                   totalEnergyBurned: nil, totalDistance: nil,
                                   device: HKDevice(name: "My Watch", manufacturer: "Apple", model: "Watch",
                                                    hardwareVersion: nil, firmwareVersion: nil, softwareVersion: nil,
                                                    localIdentifier: nil, udiDeviceIdentifier: nil), metadata: nil)
        let result = HealthKitQueries.transportWorkout(workout)
        XCTAssertEqual(result["sourceProductType"] as? String, "Watch7,12")
        XCTAssertEqual((result["device"] as? [String: String])?["model"], "Watch")
    }

    func testWorkoutTransportPreservesReportedDeviceAndSource() throws {
        let device = HKDevice(
            name: "My Watch", manufacturer: "Apple", model: "Watch7,12",
            hardwareVersion: "2", firmwareVersion: "3", softwareVersion: "11.0",
            localIdentifier: "local-device", udiDeviceIdentifier: "udi-device"
        )
        let workout = HKWorkout(
            activityType: .running,
            start: Date(timeIntervalSince1970: 1_700_000_000),
            end: Date(timeIntervalSince1970: 1_700_000_060),
            duration: 60, totalEnergyBurned: nil, totalDistance: HKQuantity(unit: .meter(), doubleValue: 200),
            device: device, metadata: [
                "recordedBy": "runner", "recordingVersion": 3,
                "recordingDate": Date(timeIntervalSince1970: 1_700_000_000),
            ]
        )
        let result = HealthKitQueries.transportWorkout(workout)
        let hardware = try XCTUnwrap(result["device"] as? [String: String])
        XCTAssertEqual(hardware, [
            "name": "My Watch", "manufacturer": "Apple", "model": "Watch7,12",
            "hardwareVersion": "2", "firmwareVersion": "3", "softwareVersion": "11.0",
            "localIdentifier": "local-device", "udiDeviceIdentifier": "udi-device",
        ])
        XCTAssertEqual(result["sourceName"] as? String, workout.sourceRevision.source.name)
        XCTAssertEqual(result["sourceBundle"] as? String, workout.sourceRevision.source.bundleIdentifier)
        XCTAssertEqual(result["totalDistance"] as? Double, 200)
        let metadata = try XCTUnwrap(result["metadata"] as? [String: Any])
        XCTAssertEqual(metadata["recordedBy"] as? String, "runner")
        XCTAssertEqual(metadata["recordingVersion"] as? Double, 3)
        XCTAssertEqual(metadata["recordingDate"] as? String, HealthKitQueries.formatDate(workout.startDate))
    }

    func testWorkoutWithPartialDeviceKeepsUnknownFieldsAbsent() throws {
        let device = HKDevice(name: nil, manufacturer: nil, model: "Watch", hardwareVersion: nil,
                              firmwareVersion: nil, softwareVersion: nil, localIdentifier: nil,
                              udiDeviceIdentifier: nil)
        let workout = HKWorkout(activityType: .walking, start: Date(), end: Date(), duration: 0,
                                totalEnergyBurned: nil, totalDistance: nil, device: device, metadata: nil)
        XCTAssertEqual(HealthKitQueries.transportWorkout(workout)["device"] as? [String: String], ["model": "Watch"])
    }

    func testClinicalRecordMapsFHIRPayloadAndDownloadDate() throws {
        let fixture = ClinicalRecordMappingInput(
            clinicalRecordUUID: UUID(uuidString: "659EE585-B399-4C21-841F-97FE49FDC465")!,
            clinicalTypeIdentifier: "HKClinicalTypeIdentifierConditionRecord",
            clinicalDisplayName: "Migraine",
            clinicalSourceName: "Example Health System",
            clinicalFHIRVersion: "4.0.1",
            clinicalFHIRData: Data(
                #"{"resourceType":"Condition","id":"condition-1","code":{"text":"Migraine"}}"#
                    .utf8
            ),
            clinicalDownloadDate: Date(timeIntervalSince1970: 1_777_137_330)
        )

        let result = try HealthKitQueries.mapClinicalRecord(fixture)

        XCTAssertEqual(result["uuid"] as? String, "659EE585-B399-4C21-841F-97FE49FDC465")
        XCTAssertEqual(result["clinicalType"] as? String, "condition")
        XCTAssertEqual(result["displayName"] as? String, "Migraine")
        XCTAssertEqual(result["sourceName"] as? String, "Example Health System")
        XCTAssertEqual(result["fhirVersion"] as? String, "4.0.1")
        XCTAssertEqual(result["downloadedAt"] as? String, "2026-04-25T17:15:30Z")

        let fhir = try XCTUnwrap(result["fhir"] as? [String: Any])
        XCTAssertEqual(fhir["resourceType"] as? String, "Condition")
        XCTAssertEqual(fhir["id"] as? String, "condition-1")
        XCTAssertEqual((fhir["code"] as? [String: Any])?["text"] as? String, "Migraine")
    }

    func testClinicalRecordRejectsMissingFHIRPayload() {
        let fixture = ClinicalRecordMappingInput(
            clinicalRecordUUID: UUID(),
            clinicalTypeIdentifier: "HKClinicalTypeIdentifierConditionRecord",
            clinicalDisplayName: "Migraine",
            clinicalSourceName: "Example Health System",
            clinicalFHIRVersion: nil,
            clinicalFHIRData: nil,
            clinicalDownloadDate: Date()
        )

        XCTAssertThrowsError(try HealthKitQueries.mapClinicalRecord(fixture)) { error in
            XCTAssertEqual(
                error.localizedDescription,
                "The clinical record does not contain a FHIR payload and version."
            )
        }
    }

    func testClinicalRecordRejectsFHIRPayloadThatIsNotAJSONObject() {
        let fixture = ClinicalRecordMappingInput(
            clinicalRecordUUID: UUID(),
            clinicalTypeIdentifier: "HKClinicalTypeIdentifierConditionRecord",
            clinicalDisplayName: "Migraine",
            clinicalSourceName: "Example Health System",
            clinicalFHIRVersion: "4.0.1",
            clinicalFHIRData: Data("[]".utf8),
            clinicalDownloadDate: Date()
        )

        XCTAssertThrowsError(try HealthKitQueries.mapClinicalRecord(fixture)) { error in
            XCTAssertEqual(
                error.localizedDescription,
                "The clinical record FHIR payload is not a JSON object."
            )
        }
    }

    func testClinicalRecordRejectsUnsupportedHealthKitType() {
        let fixture = ClinicalRecordMappingInput(
            clinicalRecordUUID: UUID(),
            clinicalTypeIdentifier: "HKClinicalTypeIdentifierUnknownRecord",
            clinicalDisplayName: "Unknown",
            clinicalSourceName: "Example Health System",
            clinicalFHIRVersion: "4.0.1",
            clinicalFHIRData: Data(#"{"resourceType":"Unknown"}"#.utf8),
            clinicalDownloadDate: Date()
        )

        XCTAssertThrowsError(try HealthKitQueries.mapClinicalRecord(fixture)) { error in
            XCTAssertEqual(
                error.localizedDescription,
                "The clinical record has an unsupported HealthKit type."
            )
        }
    }

    func testSampleTypeResolvesMenstrualFlowCategory() {
        let sampleType = HealthKitQueries.sampleType(
            for: HKCategoryTypeIdentifier.menstrualFlow.rawValue
        )

        XCTAssertEqual(sampleType?.identifier, HKCategoryTypeIdentifier.menstrualFlow.rawValue)
    }

    func testTransportSamplePreservesMenstrualCycleStartMetadata() {
        let type = HKCategoryType.categoryType(forIdentifier: .menstrualFlow)!
        let start = Date(timeIntervalSince1970: 1_786_140_000)
        let end = start.addingTimeInterval(300)
        let sample = HKCategorySample(
            type: type,
            value: HKCategoryValueMenstrualFlow.medium.rawValue,
            start: start,
            end: end,
            metadata: [HKMetadataKeyMenstrualCycleStart: true]
        )

        let result = HealthKitQueries.transportSample(
            sample,
            typeIdentifier: HKCategoryTypeIdentifier.menstrualFlow.rawValue
        )

        XCTAssertEqual(result?["type"] as? String, HKCategoryTypeIdentifier.menstrualFlow.rawValue)
        XCTAssertEqual(result?["unit"] as? String, "category")
        XCTAssertEqual(result?["value"] as? Int, HKCategoryValueMenstrualFlow.medium.rawValue)
        let metadata = result?["metadata"] as? [String: Bool]
        XCTAssertEqual(metadata?[HKMetadataKeyMenstrualCycleStart], true)
    }

    // MARK: - parseDate

    func testParseDateWithFractionalSeconds() {
        let date = HealthKitQueries.parseDate("2024-03-01T10:30:00.123Z")
        XCTAssertNotNil(date)

        let calendar = Calendar(identifier: .gregorian)
        let components = calendar.dateComponents(in: TimeZone(identifier: "UTC")!, from: date!)
        XCTAssertEqual(components.year, 2024)
        XCTAssertEqual(components.month, 3)
        XCTAssertEqual(components.day, 1)
        XCTAssertEqual(components.hour, 10)
        XCTAssertEqual(components.minute, 30)
    }

    func testParseDateWithoutFractionalSeconds() {
        let date = HealthKitQueries.parseDate("2024-03-01T10:30:00Z")
        XCTAssertNotNil(date)

        let calendar = Calendar(identifier: .gregorian)
        let components = calendar.dateComponents(in: TimeZone(identifier: "UTC")!, from: date!)
        XCTAssertEqual(components.year, 2024)
        XCTAssertEqual(components.month, 3)
        XCTAssertEqual(components.day, 1)
        XCTAssertEqual(components.hour, 10)
        XCTAssertEqual(components.minute, 30)
        XCTAssertEqual(components.second, 0)
    }

    func testParseDateWithTimezoneOffset() {
        let date = HealthKitQueries.parseDate("2024-06-15T14:00:00+05:30")
        XCTAssertNotNil(date)

        // 14:00 +05:30 = 08:30 UTC
        let calendar = Calendar(identifier: .gregorian)
        let components = calendar.dateComponents(in: TimeZone(identifier: "UTC")!, from: date!)
        XCTAssertEqual(components.hour, 8)
        XCTAssertEqual(components.minute, 30)
    }

    func testParseDateInvalid() {
        XCTAssertNil(HealthKitQueries.parseDate("not-a-date"))
    }

    func testParseDateEmpty() {
        XCTAssertNil(HealthKitQueries.parseDate(""))
    }

    func testParseDatePartialString() {
        XCTAssertNil(HealthKitQueries.parseDate("2024-03-01"))
    }

    // MARK: - formatDate

    func testFormatDateProducesISO8601WithLocalTimezone() {
        // 2024-01-15T12:00:00Z in UTC
        let date = Date(timeIntervalSince1970: 1705320000)
        let formatted = HealthKitQueries.formatDate(date)

        // The formatted string should contain the local date representation.
        // The date portion (first 10 chars) should be the local calendar date,
        // and the string should include a timezone offset (not necessarily "Z").
        XCTAssertTrue(formatted.count >= 19, "Should be a full ISO 8601 timestamp")

        // Verify round-trip: parsing the formatted string should yield the same instant
        guard let parsed = HealthKitQueries.parseDate(formatted) else {
            XCTFail("Failed to parse formatted date")
            return
        }
        XCTAssertEqual(parsed.timeIntervalSince1970, date.timeIntervalSince1970, accuracy: 1)
    }

    func testFormatDateLocalDateMatchesCalendar() {
        // Verify the first 10 characters of formatDate output match the local calendar date.
        // This is critical because the server uses isoString.slice(0, 10) to extract the date.
        let date = Date(timeIntervalSince1970: 1705320000) // 2024-01-15T12:00:00Z
        let formatted = HealthKitQueries.formatDate(date)
        let datePrefix = String(formatted.prefix(10))

        let calendar = Calendar.current
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        let expected = String(format: "%04d-%02d-%02d", components.year!, components.month!, components.day!)

        XCTAssertEqual(datePrefix, expected)
    }

    func testFormatDateParseRoundTrip() {
        let original = "2024-06-15T08:30:00Z"
        guard let date = HealthKitQueries.parseDate(original) else {
            XCTFail("Failed to parse date")
            return
        }
        let formatted = HealthKitQueries.formatDate(date)
        // Parse both and verify they represent the same instant
        guard let reparsed = HealthKitQueries.parseDate(formatted) else {
            XCTFail("Failed to re-parse formatted date")
            return
        }
        XCTAssertEqual(reparsed.timeIntervalSince1970, date.timeIntervalSince1970, accuracy: 1)
    }

    func testFormatDateParseRoundTripStripsSubseconds() {
        // Formatting drops fractional seconds, so the round-trip normalizes
        let withFractional = "2024-06-15T08:30:00.500Z"
        guard let date = HealthKitQueries.parseDate(withFractional) else {
            XCTFail("Failed to parse date")
            return
        }
        let formatted = HealthKitQueries.formatDate(date)
        // Verify the formatted string represents the same time
        guard let reparsed = HealthKitQueries.parseDate(formatted) else {
            XCTFail("Failed to re-parse formatted date")
            return
        }
        // Allow 1 second tolerance since subseconds are dropped
        XCTAssertEqual(reparsed.timeIntervalSince1970, date.timeIntervalSince1970, accuracy: 1)
    }

    // MARK: - datePredicate

    func testDatePredicateReturnsNonNilPredicate() {
        let start = Date(timeIntervalSince1970: 0)
        let end = Date(timeIntervalSince1970: 86400)
        let predicate = HealthKitQueries.datePredicate(start: start, end: end)

        XCTAssertNotNil(predicate)
    }

    func testDatePredicateWithSameStartAndEnd() {
        let date = Date()
        let predicate = HealthKitQueries.datePredicate(start: date, end: date)
        XCTAssertNotNil(predicate)
    }

    // MARK: - preferredUnit

    func testPreferredUnitHeartRate() {
        let type = HKQuantityType.quantityType(forIdentifier: .heartRate)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, HKUnit.count().unitDivided(by: .minute()))
    }

    func testPreferredUnitRestingHeartRate() {
        let type = HKQuantityType.quantityType(forIdentifier: .restingHeartRate)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, HKUnit.count().unitDivided(by: .minute()))
    }

    func testPreferredUnitBodyMass() {
        let type = HKQuantityType.quantityType(forIdentifier: .bodyMass)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .gramUnit(with: .kilo))
    }

    func testPreferredUnitLeanBodyMass() {
        let type = HKQuantityType.quantityType(forIdentifier: .leanBodyMass)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .gramUnit(with: .kilo))
    }

    func testPreferredUnitBodyFatPercentage() {
        let type = HKQuantityType.quantityType(forIdentifier: .bodyFatPercentage)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .percent())
    }

    func testPreferredUnitOxygenSaturation() {
        let type = HKQuantityType.quantityType(forIdentifier: .oxygenSaturation)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .percent())
    }

    func testPreferredUnitHeight() {
        let type = HKQuantityType.quantityType(forIdentifier: .height)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .meterUnit(with: .centi))
    }

    func testPreferredUnitHeartRateVariability() {
        let type = HKQuantityType.quantityType(forIdentifier: .heartRateVariabilitySDNN)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .secondUnit(with: .milli))
    }

    func testPreferredUnitDistanceWalkingRunning() {
        let type = HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .meter())
    }

    func testPreferredUnitDietaryEnergyConsumed() {
        let type = HKQuantityType.quantityType(forIdentifier: .dietaryEnergyConsumed)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .kilocalorie())
    }

    func testPreferredUnitStepCount() {
        let type = HKQuantityType.quantityType(forIdentifier: .stepCount)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .count())
    }

    func testPreferredUnitFlightsClimbed() {
        let type = HKQuantityType.quantityType(forIdentifier: .flightsClimbed)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .count())
    }

    func testPreferredUnitExerciseTime() {
        let type = HKQuantityType.quantityType(forIdentifier: .appleExerciseTime)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .minute())
    }

    func testPreferredUnitStandTime() {
        let type = HKQuantityType.quantityType(forIdentifier: .appleStandTime)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .minute())
    }

    func testPreferredUnitRespiratoryRate() {
        let type = HKQuantityType.quantityType(forIdentifier: .respiratoryRate)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, HKUnit.count().unitDivided(by: .minute()))
    }

    func testPreferredUnitVO2Max() {
        let type = HKQuantityType.quantityType(forIdentifier: .vo2Max)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, HKUnit(from: "mL/kg*min"))
    }

    func testPreferredUnitWalkingSpeed() {
        let type = HKQuantityType.quantityType(forIdentifier: .walkingSpeed)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, HKUnit.meter().unitDivided(by: .second()))
    }

    func testPreferredUnitWalkingStepLength() {
        let type = HKQuantityType.quantityType(forIdentifier: .walkingStepLength)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .meterUnit(with: .centi))
    }

    func testPreferredUnitBodyTemperature() {
        let type = HKQuantityType.quantityType(forIdentifier: .bodyTemperature)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .degreeCelsius())
    }

    func testPreferredUnitSleepingWristTemperature() {
        let type = HKQuantityType.quantityType(forIdentifier: .appleSleepingWristTemperature)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .degreeCelsius())
    }

    func testPreferredUnitBloodGlucose() {
        let type = HKQuantityType.quantityType(forIdentifier: .bloodGlucose)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, HKUnit(from: "mmol/L"))
    }

    func testPreferredUnitEnvironmentalAudioExposure() {
        let type = HKQuantityType.quantityType(forIdentifier: .environmentalAudioExposure)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .decibelAWeightedSoundPressureLevel())
    }

    func testPreferredUnitHeadphoneAudioExposure() {
        let type = HKQuantityType.quantityType(forIdentifier: .headphoneAudioExposure)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .decibelAWeightedSoundPressureLevel())
    }

    func testPreferredUnitDietaryProtein() {
        let type = HKQuantityType.quantityType(forIdentifier: .dietaryProtein)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .gram())
    }

    func testPreferredUnitDietaryCarbohydrates() {
        let type = HKQuantityType.quantityType(forIdentifier: .dietaryCarbohydrates)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .gram())
    }

    func testPreferredUnitDietaryFatTotal() {
        let type = HKQuantityType.quantityType(forIdentifier: .dietaryFatTotal)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .gram())
    }

    func testPreferredUnitWalkingDoubleSupportPercentage() {
        let type = HKQuantityType.quantityType(forIdentifier: .walkingDoubleSupportPercentage)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .percent())
    }

    func testPreferredUnitWalkingAsymmetryPercentage() {
        let type = HKQuantityType.quantityType(forIdentifier: .walkingAsymmetryPercentage)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .percent())
    }

    func testPreferredUnitAppleWalkingSteadiness() {
        let type = HKQuantityType.quantityType(forIdentifier: .appleWalkingSteadiness)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .percent())
    }

    func testPreferredUnitDefaultsToCount() {
        // Body mass index is not explicitly mapped, should fall through to default
        let type = HKQuantityType.quantityType(forIdentifier: .bodyMassIndex)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .count())
    }
}
