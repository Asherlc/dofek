import HealthKit
import XCTest

@testable import HealthKitLib

final class HealthKitQuantitySeriesTransportTests: XCTestCase {
    func testRunningSeriesPreservesIndividualValuesParentIdentityAndFractionalIntervals() async throws {
        let type = HKQuantityType.quantityType(forIdentifier: .runningSpeed)!
        let start = Date(timeIntervalSince1970: 1_793_181_600)
        let parent = HKQuantitySample(
            type: type, quantity: HKQuantity(unit: .meter().unitDivided(by: .second()), doubleValue: 4),
            start: start, end: start.addingTimeInterval(2)
        )
        let result = try await HealthKitQuantitySeriesTransport.transportSamples(
            [parent], typeIdentifier: type.identifier
        ) { parents in
            XCTAssertEqual(parents.map(\.uuid), [parent.uuid])
            return [0.125, 0.875].enumerated().map { index, offset in
                HealthKitQuantitySeriesEntry(
                    parent: parent,
                    quantity: HKQuantity(unit: .meter().unitDivided(by: .second()), doubleValue: Double(index + 3)),
                    dateInterval: DateInterval(start: start.addingTimeInterval(offset), duration: 0.125)
                )
            }
        }

        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result.compactMap { $0["value"] as? Double }, [3, 4])
        for entry in result {
            XCTAssertEqual(entry["uuid"] as? String, parent.uuid.uuidString)
            XCTAssertEqual(entry["sourceName"] as? String, parent.sourceRevision.source.name)
            XCTAssertEqual(entry["sourceBundle"] as? String, parent.sourceRevision.source.bundleIdentifier)
            XCTAssertEqual(entry["unit"] as? String, "m/s")
            XCTAssertEqual(entry["type"] as? String, type.identifier)
        }
        for (index, offset) in [0.125, 0.875].enumerated() {
            let actualStart = try XCTUnwrap(result[index]["startDate"] as? String)
            let actualEnd = try XCTUnwrap(result[index]["endDate"] as? String)
            XCTAssertEqual(HealthKitQueries.parseDate(actualStart), start.addingTimeInterval(offset))
            XCTAssertEqual(HealthKitQueries.parseDate(actualEnd), start.addingTimeInterval(offset + 0.125))
        }
        XCTAssertNotEqual(result[0]["startDate"] as? String, result[1]["startDate"] as? String)
    }

    func testOrdinaryRunningQuantitiesUseSeriesReaderInOneBatchWithCanonicalUnits() async throws {
        let cases: [(HKQuantityTypeIdentifier, HKUnit, Double, Double)] = [
            (.runningSpeed, HKUnit(from: "km/hr"), 10.8, 3),
            (.runningPower, .watt(), 240, 240),
            (.runningStrideLength, .meterUnit(with: .centi), 120, 1.2),
            (.runningGroundContactTime, .second(), 0.25, 250),
            (.runningVerticalOscillation, .meterUnit(with: .centi), 8.5, 85),
        ]
        let start = Date(timeIntervalSince1970: 1_793_181_600.125)
        for (identifier, inputUnit, value, expectedValue) in cases {
            let type = HKQuantityType.quantityType(forIdentifier: identifier)!
            let parents = [0.0, 0.75].map { offset in
                HKQuantitySample(type: type, quantity: HKQuantity(unit: inputUnit, doubleValue: value),
                                 start: start.addingTimeInterval(offset), end: start.addingTimeInterval(offset + 0.125))
            }
            var calls = 0
            let result = try await HealthKitQuantitySeriesTransport.transportSamples(parents, typeIdentifier: type.identifier) { batch in
                calls += 1
                XCTAssertEqual(batch.map(\.uuid), parents.map(\.uuid))
                return batch.map { HealthKitQuantitySeriesEntry(parent: $0, quantity: $0.quantity,
                    dateInterval: DateInterval(start: $0.startDate, end: $0.endDate)) }
            }
            XCTAssertEqual(calls, 1)
            XCTAssertEqual(result.count, 2)
            for (index, point) in result.enumerated() {
                XCTAssertEqual(try XCTUnwrap(point["value"] as? Double), expectedValue, accuracy: 0.000001)
                XCTAssertEqual(point["uuid"] as? String, parents[index].uuid.uuidString)
                XCTAssertEqual(HealthKitQueries.parseDate(try XCTUnwrap(point["startDate"] as? String)), parents[index].startDate)
            }
        }
    }

    func testEmptyRunningSamplesDoNotReadSeries() async throws {
        let result = try await HealthKitQuantitySeriesTransport.transportSamples(
            [], typeIdentifier: HKQuantityTypeIdentifier.runningSpeed.rawValue
        ) { _ in
            XCTFail("Empty input must not query HealthKit")
            return []
        }
        XCTAssertTrue(result.isEmpty)
    }

    func testOtherSamplesKeepExistingTransportWithoutReadingSeries() async throws {
        let start = Date(timeIntervalSince1970: 1_793_181_600)
        let quantity = HKQuantitySample(type: HKQuantityType.quantityType(forIdentifier: .heartRate)!,
            quantity: HKQuantity(unit: .count().unitDivided(by: .minute()), doubleValue: 72), start: start, end: start)
        let category = HKCategorySample(type: HKCategoryType.categoryType(forIdentifier: .menstrualFlow)!,
            value: HKCategoryValueMenstrualFlow.medium.rawValue, start: start, end: start,
            metadata: [HKMetadataKeyMenstrualCycleStart: true])
        for sample: HKSample in [quantity, category] {
            let result = try await HealthKitQuantitySeriesTransport.transportSamples(
                [sample], typeIdentifier: sample.sampleType.identifier
            ) { _ in
                XCTFail("Existing sample types must not query running series")
                return []
            }
            let expected = try XCTUnwrap(HealthKitQueries.transportSample(sample, typeIdentifier: sample.sampleType.identifier))
            XCTAssertEqual(try XCTUnwrap(result.first) as NSDictionary, expected as NSDictionary)
        }
    }

    func testRunningSeriesFailurePropagatesWithoutPartialResults() async throws {
        let type = HKQuantityType.quantityType(forIdentifier: .runningPower)!
        let sample = HKQuantitySample(type: type, quantity: HKQuantity(unit: .watt(), doubleValue: 240), start: Date(), end: Date())
        do {
            _ = try await HealthKitQuantitySeriesTransport.transportSamples([sample], typeIdentifier: type.identifier) { _ in
                throw RunningSeriesTestError.readFailed
            }
            XCTFail("Expected extraction error")
        } catch {
            XCTAssertEqual(error as? RunningSeriesTestError, .readFailed)
        }
    }
}

private enum RunningSeriesTestError: Error {
    case readFailed
}
