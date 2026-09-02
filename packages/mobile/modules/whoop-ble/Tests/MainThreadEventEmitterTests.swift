import XCTest
@testable import WhoopBLE

final class MainThreadEventEmitterTests: XCTestCase {
    func testEmitsInlineWhenAlreadyOnMainThread() {
        var emittedPayload: [String: Any]?

        MainThreadEventEmitter.emit(["state": "connected"]) { payload in
            XCTAssertTrue(Thread.isMainThread)
            emittedPayload = payload
        }

        XCTAssertEqual(emittedPayload?["state"] as? String, "connected")
    }

    func testDispatchesBackgroundEmissionsToMainThread() {
        let expectation = expectation(description: "event emitted on main thread")

        DispatchQueue.global(qos: .userInitiated).async {
            MainThreadEventEmitter.emit(["state": "disconnected"]) { payload in
                XCTAssertTrue(Thread.isMainThread)
                XCTAssertEqual(payload["state"] as? String, "disconnected")
                expectation.fulfill()
            }
        }

        waitForExpectations(timeout: 1)
    }

    func testOmitsNilPayloadValuesBeforeEmission() {
        var emittedPayload: [String: Any]?

        MainThreadEventEmitter.emit(["state": "disconnected", "error": nil]) { payload in
            emittedPayload = payload
        }

        XCTAssertEqual(emittedPayload?["state"] as? String, "disconnected")
        XCTAssertNil(emittedPayload?["error"])
    }
}
