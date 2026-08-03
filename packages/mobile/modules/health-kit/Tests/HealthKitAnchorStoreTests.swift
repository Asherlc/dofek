import Foundation
import HealthKit
import XCTest

@testable import HealthKitLib

final class HealthKitAnchorStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "HealthKitAnchorStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    func testCommittedQueryAnchorIsUsedByTheNextQuery() async throws {
        let firstAnchor = HKQueryAnchor(fromValue: 7)
        let coordinator = HealthKitAnchoredQueryCoordinator(
            anchorStore: HealthKitAnchorStore(userDefaults: defaults)
        )
        var receivedAnchors: [HKQueryAnchor?] = []

        let firstResult = try await coordinator.run(typeIdentifier: "heart-rate") { anchor in
            receivedAnchors.append(anchor)
            return ("first", firstAnchor)
        }
        let uncommittedResult = try await coordinator.run(typeIdentifier: "heart-rate") { anchor in
            receivedAnchors.append(anchor)
            return ("uncommitted", nil)
        }
        try coordinator.complete(
            typeIdentifier: "heart-rate",
            queryId: try XCTUnwrap(firstResult.queryId),
            succeeded: true
        )
        let secondResult = try await coordinator.run(typeIdentifier: "heart-rate") { anchor in
            receivedAnchors.append(anchor)
            return ("second", nil)
        }

        XCTAssertEqual(firstResult.result, "first")
        XCTAssertEqual(uncommittedResult.result, "uncommitted")
        XCTAssertEqual(secondResult.result, "second")
        XCTAssertNil(receivedAnchors[0])
        XCTAssertNil(receivedAnchors[1])
        try assertEquivalent(receivedAnchors[2], firstAnchor)
    }

    func testPersistedAnchorSurvivesCoordinatorRecreation() async throws {
        let returnedAnchor = HKQueryAnchor(fromValue: 11)
        let firstCoordinator = HealthKitAnchoredQueryCoordinator(
            anchorStore: HealthKitAnchorStore(userDefaults: defaults)
        )
        let firstResult = try await firstCoordinator.run(typeIdentifier: "step-count") { _ in
            return ((), returnedAnchor)
        }
        try firstCoordinator.complete(
            typeIdentifier: "step-count",
            queryId: try XCTUnwrap(firstResult.queryId),
            succeeded: true
        )

        let recreatedDefaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        let recreatedCoordinator = HealthKitAnchoredQueryCoordinator(
            anchorStore: HealthKitAnchorStore(userDefaults: recreatedDefaults)
        )
        var restoredAnchor: HKQueryAnchor?
        _ = try await recreatedCoordinator.run(typeIdentifier: "step-count") { anchor in
            restoredAnchor = anchor
            return ((), nil)
        }

        try assertEquivalent(restoredAnchor, returnedAnchor)
    }

    func testFailedCompletionDoesNotPersistAnchor() async throws {
        let returnedAnchor = HKQueryAnchor(fromValue: 13)
        let coordinator = HealthKitAnchoredQueryCoordinator(
            anchorStore: HealthKitAnchorStore(userDefaults: defaults)
        )
        let result = try await coordinator.run(typeIdentifier: "respiratory-rate") { _ in
            return ((), returnedAnchor)
        }

        try coordinator.complete(
            typeIdentifier: "respiratory-rate",
            queryId: try XCTUnwrap(result.queryId),
            succeeded: false
        )

        XCTAssertNil(
            defaults.object(
                forKey: HealthKitAnchorStore.key(for: "respiratory-rate")
            )
        )
    }

    func testInvalidatingPendingQueriesPreventsCompletionFromSavingAnAnchor() async throws {
        let coordinator = HealthKitAnchoredQueryCoordinator(
            anchorStore: HealthKitAnchorStore(userDefaults: defaults)
        )
        let result = try await coordinator.run(typeIdentifier: "heart-rate") { _ in
            ((), HKQueryAnchor(fromValue: 19))
        }

        coordinator.invalidatePendingQueries()

        XCTAssertThrowsError(
            try coordinator.complete(
                typeIdentifier: "heart-rate",
                queryId: try XCTUnwrap(result.queryId),
                succeeded: true
            )
        )
        XCTAssertNil(defaults.object(forKey: HealthKitAnchorStore.key(for: "heart-rate")))
    }

    func testCompleteWithUnknownQueryIdThrows() {
        let coordinator = HealthKitAnchoredQueryCoordinator(
            anchorStore: HealthKitAnchorStore(userDefaults: defaults)
        )

        XCTAssertThrowsError(
            try coordinator.complete(
                typeIdentifier: "heart-rate",
                queryId: "not-a-real-id",
                succeeded: true
            )
        ) { error in
            guard case HealthKitAnchoredQueryCoordinatorError.unknownQuery = error else {
                XCTFail("Unexpected error: \(error)")
                return
            }
        }
    }

    func testCompleteWithMismatchedTypeDoesNotDiscardPendingAnchor() async throws {
        let returnedAnchor = HKQueryAnchor(fromValue: 17)
        let coordinator = HealthKitAnchoredQueryCoordinator(
            anchorStore: HealthKitAnchorStore(userDefaults: defaults)
        )
        let result = try await coordinator.run(typeIdentifier: "heart-rate") { _ in
            return ((), returnedAnchor)
        }
        let queryId = try XCTUnwrap(result.queryId)

        XCTAssertThrowsError(
            try coordinator.complete(
                typeIdentifier: "step-count",
                queryId: queryId,
                succeeded: true
            )
        ) { error in
            guard case HealthKitAnchoredQueryCoordinatorError.mismatchedType = error else {
                XCTFail("Unexpected error: \(error)")
                return
            }
        }

        try coordinator.complete(
            typeIdentifier: "heart-rate",
            queryId: queryId,
            succeeded: true
        )
    }

    func testFailedQueryDoesNotPersistAnAnchor() async {
        let coordinator = HealthKitAnchoredQueryCoordinator(
            anchorStore: HealthKitAnchorStore(userDefaults: defaults)
        )

        do {
            let _: HealthKitPendingAnchoredQuery<Void> = try await coordinator.run(
                typeIdentifier: "body-mass"
            ) { _ -> (result: Void, newAnchor: HKQueryAnchor?) in
                throw TestError.queryFailed
            }
            XCTFail("Expected the query failure to propagate")
        } catch {
            XCTAssertEqual(error as? TestError, .queryFailed)
        }

        XCTAssertNil(defaults.object(forKey: HealthKitAnchorStore.key(for: "body-mass")))
    }

    func testLegacyIntegerIsRemovedAndReported() {
        let key = HealthKitAnchorStore.key(for: "distance")
        defaults.set(42, forKey: key)
        let store = HealthKitAnchorStore(userDefaults: defaults)

        XCTAssertThrowsError(try store.load(typeIdentifier: "distance")) { error in
            guard case HealthKitAnchorStoreError.unsupportedStoredValue = error else {
                XCTFail("Unexpected error: \(error)")
                return
            }
        }
        XCTAssertNil(defaults.object(forKey: key))
    }

    func testCorruptArchiveIsRemovedAndReported() {
        let key = HealthKitAnchorStore.key(for: "oxygen-saturation")
        defaults.set(Data([0x00, 0x01, 0x02]), forKey: key)
        let store = HealthKitAnchorStore(userDefaults: defaults)

        XCTAssertThrowsError(try store.load(typeIdentifier: "oxygen-saturation")) { error in
            guard case HealthKitAnchorStoreError.decodeFailed = error else {
                XCTFail("Unexpected error: \(error)")
                return
            }
        }
        XCTAssertNil(defaults.object(forKey: key))
    }

    private func assertEquivalent(
        _ actual: HKQueryAnchor?,
        _ expected: HKQueryAnchor,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let actual = try XCTUnwrap(actual, file: file, line: line)
        let actualData = try NSKeyedArchiver.archivedData(
            withRootObject: actual,
            requiringSecureCoding: true
        )
        let expectedData = try NSKeyedArchiver.archivedData(
            withRootObject: expected,
            requiringSecureCoding: true
        )
        XCTAssertEqual(actualData, expectedData, file: file, line: line)
    }
}

private enum TestError: Error, Equatable {
    case queryFailed
}
