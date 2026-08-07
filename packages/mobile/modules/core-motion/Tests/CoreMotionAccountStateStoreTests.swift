import Foundation
import XCTest

@testable import CoreMotionLib

final class CoreMotionAccountStateStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "CoreMotionAccountStateStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    func testPurgeRemovesAccountStateAndPersistsDeviceErasureCutoff() {
        defaults.set(
            "2026-07-26T12:00:00.000Z",
            forKey: CoreMotionAccountStateStore.lastSyncKey
        )
        defaults.set(true, forKey: CoreMotionAccountStateStore.recordingActiveKey)
        defaults.set("keep", forKey: "unrelated_setting")
        let cutoff = Date(timeIntervalSince1970: 1_785_067_200)

        CoreMotionAccountStateStore(userDefaults: defaults).purge(at: cutoff)

        XCTAssertNil(defaults.object(forKey: CoreMotionAccountStateStore.lastSyncKey))
        XCTAssertNil(defaults.object(forKey: CoreMotionAccountStateStore.recordingActiveKey))
        XCTAssertEqual(
            CoreMotionAccountStateStore(userDefaults: defaults).deviceErasureCutoff,
            cutoff
        )
        XCTAssertEqual(defaults.string(forKey: "unrelated_setting"), "keep")
    }

    func testPurgeNeverMovesDeviceErasureCutoffBackward() {
        let store = CoreMotionAccountStateStore(userDefaults: defaults)
        let laterCutoff = Date(timeIntervalSince1970: 2_000)
        store.purge(at: laterCutoff)

        store.purge(at: Date(timeIntervalSince1970: 1_000))

        XCTAssertEqual(store.deviceErasureCutoff, laterCutoff)
    }

    func testLaterAccountStartsAtCutoffAndOnlyIncludesNewSamples() {
        let store = CoreMotionAccountStateStore(userDefaults: defaults)
        let cutoff = Date(timeIntervalSince1970: 2_000)
        store.purge(at: cutoff)

        XCTAssertEqual(
            store.effectiveSyncStart(Date(timeIntervalSince1970: 1_000)),
            cutoff
        )
        XCTAssertFalse(store.shouldInclude(sampleDate: Date(timeIntervalSince1970: 1_999)))
        XCTAssertFalse(store.shouldInclude(sampleDate: cutoff))
        XCTAssertTrue(store.shouldInclude(sampleDate: Date(timeIntervalSince1970: 2_001)))
    }
}
