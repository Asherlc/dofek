import XCTest
@testable import BleHeartRateLib

final class BleHeartRatePeripheralSessionTests: XCTestCase {
    func testReadySessionIsUnaffectedWhenAnotherSessionDisconnects() {
        let sessions = [
            "strap-a": BleHeartRatePeripheralSession(id: "strap-a", state: .ready),
            "strap-b": BleHeartRatePeripheralSession(id: "strap-b", state: .connecting),
        ]

        sessions["strap-b"]?.markDisconnected()

        XCTAssertEqual(sessions["strap-a"]?.state, .ready)
        XCTAssertEqual(sessions["strap-b"]?.state, .idle)
    }

    func testTimeoutOnlyFailsItsOwnConnectingSession() {
        let ready = BleHeartRatePeripheralSession(id: "strap-a", state: .ready)
        let connecting = BleHeartRatePeripheralSession(id: "strap-b", state: .connecting)

        connecting.markTimedOut()

        XCTAssertEqual(ready.state, .ready)
        XCTAssertEqual(connecting.state, .idle)
    }
}
