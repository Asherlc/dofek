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

    func testSecondQueryUsesAnchorReturnedByFirst() async throws {
        let firstAnchor = HKQueryAnchor(fromValue: 7)
        let coordinator = HealthKitAnchoredQueryCoordinator(
            anchorStore: HealthKitAnchorStore(userDefaults: defaults)
        )
        var receivedAnchors: [HKQueryAnchor?] = []

        let firstResult = try await coordinator.run(typeIdentifier: "heart-rate") { anchor in
            receivedAnchors.append(anchor)
            return ("first", firstAnchor)
        }
        let secondResult = try await coordinator.run(typeIdentifier: "heart-rate") { anchor in
            receivedAnchors.append(anchor)
            return ("second", nil)
        }

        XCTAssertEqual(firstResult, "first")
        XCTAssertEqual(secondResult, "second")
        XCTAssertNil(receivedAnchors[0])
        try assertEquivalent(receivedAnchors[1], firstAnchor)
    }

    func testPersistedAnchorSurvivesCoordinatorRecreation() async throws {
        let returnedAnchor = HKQueryAnchor(fromValue: 11)
        let firstCoordinator = HealthKitAnchoredQueryCoordinator(
            anchorStore: HealthKitAnchorStore(userDefaults: defaults)
        )
        _ = try await firstCoordinator.run(typeIdentifier: "step-count") { _ in
            return ((), returnedAnchor)
        }

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

    func testFailedQueryDoesNotPersistAnAnchor() async {
        let coordinator = HealthKitAnchoredQueryCoordinator(
            anchorStore: HealthKitAnchorStore(userDefaults: defaults)
        )

        do {
            _ = try await coordinator.run(typeIdentifier: "body-mass") { _ in
                throw TestError.queryFailed
            } as Void
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
