import Foundation
import XCTest

@testable import WatchMotionLib

final class WatchMotionAccountStateStoreTests: XCTestCase {
    func testPurgeDisablesSyncAndRetainsMonotonicCutoffForLaterAccount() {
        let suiteName = "WatchMotionAccountStateStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = WatchMotionAccountStateStore(userDefaults: defaults)

        XCTAssertTrue(store.isSyncEnabled)
        store.purge(at: Date(timeIntervalSince1970: 2_000))
        store.purge(at: Date(timeIntervalSince1970: 1_000))

        XCTAssertFalse(store.isSyncEnabled)
        XCTAssertEqual(store.deviceErasureCutoff, Date(timeIntervalSince1970: 2_000))
        XCTAssertFalse(store.shouldInclude(timestamp: Date(timeIntervalSince1970: 2_000)))
        XCTAssertTrue(store.shouldInclude(timestamp: Date(timeIntervalSince1970: 2_001)))

        store.enableSync()
        XCTAssertTrue(store.isSyncEnabled)
        XCTAssertEqual(store.deviceErasureCutoff, Date(timeIntervalSince1970: 2_000))
    }
}
