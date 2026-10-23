import Foundation
import XCTest
@testable import WhoopBLE

final class WhoopBleConnectionEventTests: XCTestCase {
    func testConnectedPublishesNativeConnectionState() {
        let delivery = expectation(
            forNotification: Notification.Name("WhoopBle.connectionStateChanged"),
            object: nil
        ) { notification in
            notification.userInfo?["state"] as? String == "connected"
        }

        WhoopBleConnectionEvent.connected.post()

        wait(for: [delivery], timeout: 1)
    }

    func testDisconnectedPublishesNativeConnectionState() {
        let delivery = expectation(
            forNotification: Notification.Name("WhoopBle.connectionStateChanged"),
            object: nil
        ) { notification in
            notification.userInfo?["state"] as? String == "disconnected"
        }

        WhoopBleConnectionEvent.disconnected.post()

        wait(for: [delivery], timeout: 1)
    }

    func testIntentionalDisconnectPublishesDistinctNativeConnectionState() {
        let delivery = expectation(
            forNotification: Notification.Name("WhoopBle.connectionStateChanged"),
            object: nil
        ) { notification in
            notification.userInfo?["state"] as? String == "intentionallyDisconnected"
        }

        WhoopBleConnectionEvent.intentionallyDisconnected.post()

        wait(for: [delivery], timeout: 1)
    }
}
