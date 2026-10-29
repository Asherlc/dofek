import HealthKit
import XCTest
@testable import HealthKitLib

final class HealthKitRunningStepTransportTests: XCTestCase {
    private let origin = Date(timeIntervalSince1970: 1_793_181_600)

    private func parent(_ start: TimeInterval, _ end: TimeInterval) -> HKQuantitySample {
        HKQuantitySample(type: .quantityType(forIdentifier: .stepCount)!,
            quantity: HKQuantity(unit: .count(), doubleValue: 7.5),
            start: origin.addingTimeInterval(start), end: origin.addingTimeInterval(end))
    }

    func testDiscoversOnlyActualSparseParentIntervals() async throws {
        let parents = [parent(0, 1.25), parent(864000, 864001.5)]
        let runs = parents.map { HKWorkout(activityType: .running, start: $0.startDate, end: $0.endDate) }
        let result = try await HealthKitRunningStepTransport.discoverWorkouts(parents: parents) { intervals in
            XCTAssertEqual(intervals, parents.map { DateInterval(start: $0.startDate, end: $0.endDate) })
            return runs
        }
        XCTAssertEqual(result.map(\.uuid), runs.map(\.uuid))
    }

    func testMergesOverlappingTouchingAndDuplicateParentIntervals() async throws {
        let parents = [parent(8, 12), parent(0, 4), parent(3, 8), parent(3, 8), parent(1, 2), parent(30, 31.125)]
        var queries: [[DateInterval]] = []
        _ = try await HealthKitRunningStepTransport.discoverWorkouts(parents: parents) { intervals in
            queries.append(intervals)
            return []
        }
        XCTAssertEqual(queries, [[
            DateInterval(start: origin, duration: 12),
            DateInterval(start: origin.addingTimeInterval(30), duration: 1.125)
        ]])
    }

    func testDiscoveryRetainsEveryParentInAFullPage() async throws {
        let parents = (0..<500).map { parent(Double($0 * 3), Double($0 * 3) + 1.125) }
        var queries: [[DateInterval]] = []
        _ = try await HealthKitRunningStepTransport.discoverWorkouts(parents: parents) { intervals in
            queries.append(intervals)
            return []
        }
        XCTAssertEqual(queries, [parents.map { DateInterval(start: $0.startDate, end: $0.endDate) }])
    }

    func testEmptyParentDiscoveryDoesNotQuery() async throws {
        let result = try await HealthKitRunningStepTransport.discoverWorkouts(parents: []) { _ in
            XCTFail("Empty parents must not query workouts")
            return []
        }
        XCTAssertTrue(result.isEmpty)
    }

    func testDiscoveryDeduplicatesWorkoutUUIDs() async throws {
        let first = HKWorkout(activityType: .running, start: origin, end: origin.addingTimeInterval(10))
        let second = HKWorkout(activityType: .running, start: origin, end: origin.addingTimeInterval(10))
        let result = try await HealthKitRunningStepTransport.discoverWorkouts(parents: [parent(0, 10)]) { _ in
            [first, first, second, first]
        }
        XCTAssertEqual(result.map(\.uuid), [first.uuid, second.uuid])
    }

    func testSparseSelectionKeepsEveryAssociationWithoutReadingUnselectedParents() async throws {
        let parents = [parent(0, 1.25), parent(864000, 864001.5)]
        let first = HKWorkout(activityType: .running, start: origin, end: origin.addingTimeInterval(2))
        let second = HKWorkout(activityType: .running, start: parents[1].startDate, end: parents[1].endDate)
        let adjacent = HKWorkout(activityType: .running, start: origin.addingTimeInterval(-1), end: origin.addingTimeInterval(3))
        let unrelated = parent(5, 6)
        var seriesReads = 0
        let result = try await HealthKitRunningStepTransport.snapshot(workouts: [first, second], shouldInclude: { _ in true },
            discoverWorkouts: { selected in
                try await HealthKitRunningStepTransport.discoverWorkouts(parents: selected) { intervals in
                    XCTAssertEqual(intervals.count, 2)
                    return [first, adjacent, second, adjacent]
                }
            }, readParents: { run in
                if run.uuid == first.uuid { return [parents[0]] }
                if run.uuid == second.uuid { return [parents[1]] }
                return [parents[0], unrelated]
            }, readSeries: { selected in
                seriesReads += 1
                XCTAssertEqual(Set(selected.map(\.uuid)), Set(parents.map(\.uuid)))
                return selected.map { HealthKitQuantitySeriesEntry(parent: $0, quantity: $0.quantity,
                    dateInterval: DateInterval(start: $0.startDate, end: $0.endDate)) }
            })
        XCTAssertEqual(seriesReads, 1)
        XCTAssertEqual(result.workouts.count, 3)
        XCTAssertEqual(result.samples.count, 2)
        for sample in result.samples {
            let selected = try XCTUnwrap(parents.first { $0.uuid.uuidString == sample["uuid"] as? String })
            XCTAssertEqual(sample["value"] as? Double, 7.5)
            XCTAssertEqual(sample["sourceBundle"] as? String, selected.sourceRevision.source.bundleIdentifier)
            XCTAssertEqual(HealthKitQueries.parseDate(try XCTUnwrap(sample["startDate"] as? String)), selected.startDate)
            XCTAssertEqual(HealthKitQueries.parseDate(try XCTUnwrap(sample["endDate"] as? String)), selected.endDate)
            let expected = selected.uuid == parents[0].uuid ? [first.uuid.uuidString, adjacent.uuid.uuidString] : [second.uuid.uuidString]
            XCTAssertEqual(Set(sample["workoutUuids"] as? [String] ?? []), Set(expected))
        }
    }

    func testDiscoveryFailurePreservesCommittedAnchorAndDoesNotRegisterPendingResult() async throws {
        let suiteName = "RunningDiscovery.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = HealthKitAnchorStore(userDefaults: defaults)
        let type = HKQuantityTypeIdentifier.stepCount.rawValue
        let coordinator = HealthKitAnchoredQueryCoordinator(anchorStore: store)
        let committed = HKQueryAnchor(fromValue: 3)
        try store.save(committed, typeIdentifier: type)
        do {
            _ = try await coordinator.run(typeIdentifier: type) { _ in
                let runs = try await HealthKitRunningStepTransport.discoverWorkouts(parents: [self.parent(0, 1)]) { _ in
                    throw StepTestError.read
                }
                return (runs, HKQueryAnchor(fromValue: 7))
            }
            XCTFail("Expected discovery failure")
        } catch { XCTAssertTrue(error is StepTestError) }
        XCTAssertEqual(try store.load(typeIdentifier: type), committed)
        _ = try await coordinator.run(typeIdentifier: type) { anchor in
            XCTAssertEqual(anchor, committed)
            return ([], nil as HKQueryAnchor?)
        }
    }

    func testPageContinuationCountsBothAddedParentsAndDeletionsAtTheLimit() {
        let snapshot = HealthKitRunningStepSnapshot(workouts: [], samples: [])
        for (added, deleted, expected) in [(0, 0, false), (499, 0, false), (499, 1, true), (0, 500, true), (500, 1, true)] {
            let page = HealthKitRunningStepDeltaPayload(snapshot: snapshot, deletedUUIDs: [],
                addedParentCount: added, deletedParentCount: deleted)
            XCTAssertEqual(page.hasMore, expected)
        }
        XCTAssertEqual(HealthKitRunningStepTransport.anchoredPageSize, 500)
    }

    func testReadsOnlyAssociatedRunningParentsAndMergesWorkoutAssociations() async throws {
        let start = Date(timeIntervalSince1970: 1_793_181_600.125)
        let runA = HKWorkout(activityType: .running, start: start, end: start.addingTimeInterval(60))
        let runB = HKWorkout(activityType: .running, start: start, end: start.addingTimeInterval(60))
        let walk = HKWorkout(activityType: .walking, start: start, end: start.addingTimeInterval(60))
        let parent = HKQuantitySample(type: .quantityType(forIdentifier: .stepCount)!,
            quantity: HKQuantity(unit: .count(), doubleValue: 999), start: start, end: start.addingTimeInterval(60))
        var seriesReads = 0
        let result = try await HealthKitRunningStepTransport.snapshot(
            workouts: [runA, runB, walk], shouldInclude: { _ in true },
            discoverWorkouts: { _ in [] },
            readParents: { workout in
                XCTAssertNotEqual(workout.uuid, walk.uuid)
                return [parent]
            }, readSeries: { parents in
                seriesReads += 1
                XCTAssertEqual(parents.map(\.uuid), [parent.uuid])
                return [HealthKitQuantitySeriesEntry(parent: parent,
                    quantity: HKQuantity(unit: .count(), doubleValue: 3),
                    dateInterval: DateInterval(start: start, duration: 1.25))]
            })
        XCTAssertEqual(seriesReads, 1)
        XCTAssertEqual(result.workouts.count, 2)
        let sample = try XCTUnwrap(result.samples.first)
        XCTAssertEqual(result.samples.count, 1)
        XCTAssertEqual(sample["uuid"] as? String, parent.uuid.uuidString)
        XCTAssertEqual(sample["value"] as? Double, 3)
        XCTAssertEqual(sample["unit"] as? String, "count")
        XCTAssertEqual(sample["sourceBundle"] as? String, parent.sourceRevision.source.bundleIdentifier)
        XCTAssertEqual(Set(sample["workoutUuids"] as? [String] ?? []), Set([runA.uuid.uuidString, runB.uuid.uuidString]))
        XCTAssertEqual(HealthKitQueries.parseDate(try XCTUnwrap(sample["startDate"] as? String)), start)
        XCTAssertEqual(HealthKitQueries.parseDate(try XCTUnwrap(sample["endDate"] as? String)), start.addingTimeInterval(1.25))
    }

    func testRangeSelectionRetainsAssociationsOutsideTheInitialWorkoutRangeWithoutExpandingRawScope() async throws {
        let start = Date(timeIntervalSince1970: 1_793_181_600)
        let firstRun = HKWorkout(activityType: .running, start: start, end: start.addingTimeInterval(60))
        let adjacent = HKWorkout(activityType: .running, start: start.addingTimeInterval(60), end: start.addingTimeInterval(120))
        let type = HKQuantityType.quantityType(forIdentifier: .stepCount)!
        let parent = HKQuantitySample(type: type, quantity: HKQuantity(unit: .count(), doubleValue: 10),
            start: start, end: start.addingTimeInterval(120))
        let unrelated = HKQuantitySample(type: type, quantity: HKQuantity(unit: .count(), doubleValue: 99),
            start: start, end: start.addingTimeInterval(120))
        let snapshot = try await HealthKitRunningStepTransport.snapshot(workouts: [firstRun], shouldInclude: { _ in true },
            discoverWorkouts: { parents in
                XCTAssertEqual(parents.map(\.uuid), [parent.uuid])
                return [firstRun, adjacent]
            }, readParents: { run in run.uuid == firstRun.uuid ? [parent] : [parent, unrelated] },
            readSeries: { parents in
                XCTAssertEqual(parents.map(\.uuid), [parent.uuid])
                return [HealthKitQuantitySeriesEntry(parent: parent,
                    quantity: HKQuantity(unit: .count(), doubleValue: 2),
                    dateInterval: DateInterval(start: start, duration: 1))]
            })
        XCTAssertEqual(snapshot.samples.count, 1)
        XCTAssertEqual(Set(snapshot.samples[0]["workoutUuids"] as? [String] ?? []),
                       Set([firstRun.uuid.uuidString, adjacent.uuid.uuidString]))
        XCTAssertEqual(snapshot.workouts.count, 2)
    }

    func testCutoffFiltersWorkoutsAndParentsBeforeSeriesRead() async throws {
        let start = Date(timeIntervalSince1970: 1_793_181_600)
        let run = HKWorkout(activityType: .running, start: start, end: start.addingTimeInterval(60))
        let old = HKQuantitySample(type: .quantityType(forIdentifier: .stepCount)!,
            quantity: HKQuantity(unit: .count(), doubleValue: 10), start: start, end: start.addingTimeInterval(1))
        let result = try await HealthKitRunningStepTransport.snapshot(workouts: [run],
            shouldInclude: { $0 > start }, discoverWorkouts: { _ in [] }, readParents: { _ in XCTFail("Erased workout"); return [old] },
            readSeries: { _ in XCTFail("No associated parents"); return [] })
        XCTAssertTrue(result.samples.isEmpty)
        XCTAssertTrue(result.workouts.isEmpty)
        let parentFiltered = try await HealthKitRunningStepTransport.snapshot(workouts: [run],
            shouldInclude: { $0 >= start }, discoverWorkouts: { _ in [] }, readParents: { _ in
                [HKQuantitySample(type: old.quantityType, quantity: old.quantity,
                                  start: start.addingTimeInterval(-1), end: start)]
            },
            readSeries: { _ in XCTFail("No parents"); return [] })
        XCTAssertTrue(parentFiltered.samples.isEmpty)
    }

    func testSeriesFailurePreventsSnapshotCompletion() async throws {
        let run = HKWorkout(activityType: .running, start: Date(), end: Date().addingTimeInterval(10))
        let parent = HKQuantitySample(type: .quantityType(forIdentifier: .stepCount)!,
            quantity: HKQuantity(unit: .count(), doubleValue: 3), start: run.startDate, end: run.endDate)
        let suiteName = "RunningSteps.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = HealthKitAnchorStore(userDefaults: defaults)
        let coordinator = HealthKitAnchoredQueryCoordinator(anchorStore: store)
        let typeIdentifier = HKQuantityTypeIdentifier.stepCount.rawValue
        do {
            _ = try await coordinator.run(typeIdentifier: typeIdentifier) { _ in
                let snapshot = try await HealthKitRunningStepTransport.snapshot(workouts: [run],
                    shouldInclude: { _ in true }, discoverWorkouts: { _ in [] },
                    readParents: { _ in [parent] }, readSeries: { _ in throw StepTestError.read })
                return (snapshot, HKQueryAnchor(fromValue: 7))
            }
            XCTFail("Expected read failure")
        } catch { XCTAssertTrue(error is StepTestError) }
        XCTAssertNil(try store.load(typeIdentifier: typeIdentifier))
        _ = try await coordinator.run(typeIdentifier: typeIdentifier) { anchor in
            XCTAssertNil(anchor)
            return ([], nil as HKQueryAnchor?)
        }
    }
}
private enum StepTestError: Error { case read }
