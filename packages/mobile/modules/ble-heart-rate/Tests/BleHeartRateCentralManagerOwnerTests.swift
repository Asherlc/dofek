import Foundation
import XCTest
@testable import BleHeartRateLib

final class BleHeartRateCentralManagerOwnerTests: XCTestCase {
    func testConcurrentFirstAccessCreatesOneManagerOnOwnerQueue() {
        let queue = DispatchQueue(label: "BleHeartRateCentralManagerOwnerTests.owner")
        let queueKey = DispatchSpecificKey<String>()
        queue.setSpecific(key: queueKey, value: "owner")
        let owner = BleHeartRateCentralManagerOwner<NSObject>(queue: queue)
        let resultLock = NSLock()
        var creationCount = 0
        var createdOnOwnerQueue = false
        var returnedIdentifiers: [ObjectIdentifier] = []

        DispatchQueue.concurrentPerform(iterations: 32) { _ in
            let manager = owner.getOrCreate {
                resultLock.lock()
                creationCount += 1
                createdOnOwnerQueue = DispatchQueue.getSpecific(key: queueKey) == "owner"
                resultLock.unlock()
                return NSObject()
            }
            resultLock.lock()
            returnedIdentifiers.append(ObjectIdentifier(manager))
            resultLock.unlock()
        }

        XCTAssertEqual(creationCount, 1)
        XCTAssertTrue(createdOnOwnerQueue)
        XCTAssertEqual(Set(returnedIdentifiers).count, 1)
    }
}
