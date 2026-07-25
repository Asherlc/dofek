import XCTest
@testable import HealthKitLib

final class MainThreadEventEmitterTests: XCTestCase {
    func testEmitsInlineWhenAlreadyOnMainThread() {
        var emittedPayload: [String: Any]?

        MainThreadEventEmitter.emit(["typeIdentifier": "HKQuantityTypeIdentifierStepCount"]) { payload in
            XCTAssertTrue(Thread.isMainThread)
            emittedPayload = payload
        }

        XCTAssertEqual(emittedPayload?["typeIdentifier"] as? String, "HKQuantityTypeIdentifierStepCount")
    }

    func testDispatchesBackgroundEmissionsToMainThread() {
        let expectation = expectation(description: "event emitted on main thread")

        DispatchQueue.global(qos: .userInitiated).async {
            MainThreadEventEmitter.emit(["typeIdentifier": "HKQuantityTypeIdentifierHeartRate"]) { payload in
                XCTAssertTrue(Thread.isMainThread)
                XCTAssertEqual(payload["typeIdentifier"] as? String, "HKQuantityTypeIdentifierHeartRate")
                expectation.fulfill()
            }
        }

        waitForExpectations(timeout: 1)
    }
}
