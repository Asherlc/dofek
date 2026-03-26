import HealthKit
import XCTest

@testable import HealthKitLib

final class HealthKitQueriesTests: XCTestCase {

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

    func testPreferredUnitDistanceCycling() {
        let type = HKQuantityType.quantityType(forIdentifier: .distanceCycling)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .meter())
    }

    func testPreferredUnitActiveEnergyBurned() {
        let type = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .kilocalorie())
    }

    func testPreferredUnitBasalEnergyBurned() {
        let type = HKQuantityType.quantityType(forIdentifier: .basalEnergyBurned)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .kilocalorie())
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

    func testPreferredUnitDefaultsToCount() {
        // Body mass index is not explicitly mapped, should fall through to default
        let type = HKQuantityType.quantityType(forIdentifier: .bodyMassIndex)!
        let unit = HealthKitQueries.preferredUnit(for: type)
        XCTAssertEqual(unit, .count())
    }
}
