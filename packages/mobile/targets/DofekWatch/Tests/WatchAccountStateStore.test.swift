#if canImport(XCTest)
@testable import DofekWatchTransferCore
import Foundation
import XCTest

final class WatchAccountStateStoreTests: XCTestCase {
    func testPurgeDisablesSyncAndRetainsMonotonicDeviceCutoff() {
        let suite = "WatchAccountStateStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WatchAccountStateStore(defaults: defaults)

        store.purge(at: Date(timeIntervalSince1970: 2_000))
        store.purge(at: Date(timeIntervalSince1970: 1_000))

        XCTAssertFalse(store.isSyncEnabled)
        XCTAssertEqual(store.deviceErasureCutoff, Date(timeIntervalSince1970: 2_000))
        store.enableSync()
        XCTAssertTrue(store.isSyncEnabled)
        XCTAssertEqual(store.deviceErasureCutoff, Date(timeIntervalSince1970: 2_000))
    }
}
#endif
