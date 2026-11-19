import XCTest
@testable import WhoopBLE

extension WhoopBleSampleStoreTests {
    func testManagedHistoryPreferenceIsScopedToStrapAndUploadBinding() throws {
        let url = try directory()
        let strap = UUID()
        let otherStrap = UUID()
        do {
            let store = try WhoopBleSampleStore(directory: url)
            XCTAssertThrowsError(try store.setManagedHistoryEnabled(true, for: strap))
            try store.configure(owner)
            XCTAssertFalse(try store.isManagedHistoryEnabled(for: strap))
            try store.setManagedHistoryEnabled(true, for: strap)
        }

        let reopened = try WhoopBleSampleStore(directory: url)
        try reopened.configure(owner)
        XCTAssertTrue(try reopened.isManagedHistoryEnabled(for: strap))
        XCTAssertFalse(try reopened.isManagedHistoryEnabled(for: otherStrap))
        try reopened.setManagedHistoryEnabled(false, for: strap)
        XCTAssertFalse(try reopened.isManagedHistoryEnabled(for: strap))

        try reopened.setManagedHistoryEnabled(true, for: strap)
        try reopened.configure(WhoopUploadBinding(userId: "replacement", serverURL: owner.serverURL))
        XCTAssertFalse(try reopened.isManagedHistoryEnabled(for: strap))
        try reopened.setManagedHistoryEnabled(true, for: otherStrap)
        try reopened.purge()
        try reopened.configure(owner)
        XCTAssertFalse(try reopened.isManagedHistoryEnabled(for: otherStrap))
    }
}
