import XCTest
@testable import WhoopBleLib

final class WhoopBleConnectionManagerTests: XCTestCase {
    func testSyncOnBleQueueRunsInlineWhenAlreadyOnBleQueue() {
        let manager = WhoopBleConnectionManager()
        let expectation = expectation(description: "ble queue work finished")

        manager.bleQueue.async {
            let value = manager.syncOnBleQueue {
                "executed"
            }

            XCTAssertEqual(value, "executed")
            expectation.fulfill()
        }

        waitForExpectations(timeout: 1)
    }
}
