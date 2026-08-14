import Foundation
import XCTest

@testable import HealthKitLib

final class HealthKitAccountStateStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "HealthKitAccountStateStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    func testPurgeRemovesAccountStateAndPersistsDeviceErasureCutoff() {
        defaults.set(true, forKey: HealthKitAccountStateStore.hasEverAuthorizedKey)
        defaults.set(true, forKey: HealthKitAccountStateStore.backgroundDeliveryEnabledKey)
        defaults.set(Data([0x01]), forKey: HealthKitAnchorStore.key(for: "heart-rate"))
        defaults.set(Data([0x02]), forKey: HealthKitAnchorStore.key(for: "step-count"))
        defaults.set("keep", forKey: "unrelated_setting")
        let cutoff = Date(timeIntervalSince1970: 1_785_067_200)

        HealthKitAccountStateStore(userDefaults: defaults).purge(at: cutoff)

        XCTAssertNil(defaults.object(forKey: HealthKitAccountStateStore.hasEverAuthorizedKey))
        XCTAssertNil(
            defaults.object(forKey: HealthKitAccountStateStore.backgroundDeliveryEnabledKey)
        )
        XCTAssertNil(defaults.object(forKey: HealthKitAnchorStore.key(for: "heart-rate")))
        XCTAssertNil(defaults.object(forKey: HealthKitAnchorStore.key(for: "step-count")))
        XCTAssertEqual(
            HealthKitAccountStateStore(userDefaults: defaults).deviceErasureCutoff,
            cutoff
        )
        XCTAssertEqual(defaults.string(forKey: "unrelated_setting"), "keep")
    }

    func testPurgeNeverMovesDeviceErasureCutoffBackward() {
        let store = HealthKitAccountStateStore(userDefaults: defaults)
        let laterCutoff = Date(timeIntervalSince1970: 2_000)
        store.purge(at: laterCutoff)

        store.purge(at: Date(timeIntervalSince1970: 1_000))

        XCTAssertEqual(store.deviceErasureCutoff, laterCutoff)
    }

    func testLaterAccountCanOnlyIncludeSamplesStrictlyAfterCutoff() {
        let store = HealthKitAccountStateStore(userDefaults: defaults)
        let cutoff = Date(timeIntervalSince1970: 2_000)
        store.purge(at: cutoff)

        XCTAssertFalse(store.shouldInclude(sampleDate: Date(timeIntervalSince1970: 1_999)))
        XCTAssertFalse(store.shouldInclude(sampleDate: cutoff))
        XCTAssertTrue(store.shouldInclude(sampleDate: Date(timeIntervalSince1970: 2_001)))
    }
}
