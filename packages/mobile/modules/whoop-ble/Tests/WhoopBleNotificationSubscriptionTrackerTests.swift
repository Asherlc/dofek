import Foundation
import XCTest
@testable import WhoopBLE

final class WhoopBleNotificationSubscriptionTrackerTests: XCTestCase {
    func testDataSubscriptionAloneCompletesTheHandshake() {
        let peripheral = NSObject()
        let dataCharacteristic = NSObject()
        var tracker = WhoopBleNotificationSubscriptionTracker(
            peripheral: peripheral,
            dataCharacteristic: dataCharacteristic,
            commandResponseCharacteristic: nil
        )

        let result = tracker.recordNotificationState(
            peripheral: peripheral,
            characteristic: dataCharacteristic,
            isNotifying: true,
            hasError: false
        )

        XCTAssertEqual(result, .ready)
    }

    func testWaitsForPresentCommandResponseSubscription() {
        let peripheral = NSObject()
        let dataCharacteristic = NSObject()
        let commandResponseCharacteristic = NSObject()
        var tracker = WhoopBleNotificationSubscriptionTracker(
            peripheral: peripheral,
            dataCharacteristic: dataCharacteristic,
            commandResponseCharacteristic: commandResponseCharacteristic
        )

        let dataResult = tracker.recordNotificationState(
            peripheral: peripheral,
            characteristic: dataCharacteristic,
            isNotifying: true,
            hasError: false
        )
        let commandResult = tracker.recordNotificationState(
            peripheral: peripheral,
            characteristic: commandResponseCharacteristic,
            isNotifying: true,
            hasError: false
        )

        XCTAssertEqual(dataResult, .waiting)
        XCTAssertEqual(commandResult, .ready)
    }

    func testDataSubscriptionFailureFailsTheHandshake() {
        let peripheral = NSObject()
        let dataCharacteristic = NSObject()
        var tracker = WhoopBleNotificationSubscriptionTracker(
            peripheral: peripheral,
            dataCharacteristic: dataCharacteristic,
            commandResponseCharacteristic: nil
        )

        let result = tracker.recordNotificationState(
            peripheral: peripheral,
            characteristic: dataCharacteristic,
            isNotifying: true,
            hasError: true
        )

        XCTAssertEqual(result, .failed)
    }

    func testPresentCommandResponseSubscriptionFailureFailsTheHandshake() {
        let peripheral = NSObject()
        let dataCharacteristic = NSObject()
        let commandResponseCharacteristic = NSObject()
        var tracker = WhoopBleNotificationSubscriptionTracker(
            peripheral: peripheral,
            dataCharacteristic: dataCharacteristic,
            commandResponseCharacteristic: commandResponseCharacteristic
        )

        XCTAssertEqual(
            tracker.recordNotificationState(
                peripheral: peripheral,
                characteristic: dataCharacteristic,
                isNotifying: true,
                hasError: false
            ),
            .waiting
        )

        let result = tracker.recordNotificationState(
            peripheral: peripheral,
            characteristic: commandResponseCharacteristic,
            isNotifying: false,
            hasError: false
        )

        XCTAssertEqual(result, .failed)
    }

    func testIgnoresCallbacksFromStalePeripheralAndCharacteristicObjects() {
        let peripheral = NSObject()
        let stalePeripheral = NSObject()
        let dataCharacteristic = NSObject()
        let staleDataCharacteristic = NSObject()
        var tracker = WhoopBleNotificationSubscriptionTracker(
            peripheral: peripheral,
            dataCharacteristic: dataCharacteristic,
            commandResponseCharacteristic: nil
        )

        XCTAssertEqual(
            tracker.recordNotificationState(
                peripheral: stalePeripheral,
                characteristic: dataCharacteristic,
                isNotifying: true,
                hasError: false
            ),
            .ignored
        )
        XCTAssertEqual(
            tracker.recordNotificationState(
                peripheral: peripheral,
                characteristic: staleDataCharacteristic,
                isNotifying: true,
                hasError: false
            ),
            .ignored
        )
        XCTAssertEqual(
            tracker.recordNotificationState(
                peripheral: peripheral,
                characteristic: dataCharacteristic,
                isNotifying: true,
                hasError: false
            ),
            .ready
        )
    }
}
