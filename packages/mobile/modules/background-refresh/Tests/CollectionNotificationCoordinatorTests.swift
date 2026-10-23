import XCTest
@testable import BackgroundRefreshLib

final class CollectionNotificationCoordinatorTests: XCTestCase {
    func testUnexpectedDisconnectAfterConnectionSchedulesOneWhoopAlert() {
        let recorder = NotificationRecorder()
        let coordinator = recorder.makeCoordinator()
        coordinator.setEnabled(true)
        coordinator.whoopConnected()

        coordinator.whoopDisconnected()
        coordinator.whoopDisconnected()

        XCTAssertEqual(recorder.scheduled, [.whoopDisconnected])
        XCTAssertEqual(recorder.scheduled.first?.identifier, "com.dofek.collection.whoop-disconnected")
        XCTAssertEqual(recorder.scheduled.first?.delay, 300)
    }

    func testDisconnectBeforeAnyConnectionDoesNotWarn() {
        let recorder = NotificationRecorder()
        let coordinator = recorder.makeCoordinator()
        coordinator.setEnabled(true)

        coordinator.whoopDisconnected()

        XCTAssertTrue(recorder.scheduled.isEmpty)
    }

    func testReconnectCancelsOnlyWhoopAlert() {
        let recorder = NotificationRecorder()
        let coordinator = recorder.makeCoordinator()
        coordinator.setEnabled(true)
        coordinator.whoopConnected()
        coordinator.whoopDisconnected()
        coordinator.appWillTerminate()
        recorder.cancellations.removeAll()

        coordinator.whoopConnected()

        XCTAssertEqual(recorder.cancellations, [["com.dofek.collection.whoop-disconnected"]])
        XCTAssertEqual(recorder.scheduled, [.whoopDisconnected, .appClosed])
    }

    func testReconnectedDeviceCanWarnOnANewDisconnect() {
        let recorder = NotificationRecorder()
        let coordinator = recorder.makeCoordinator()
        coordinator.setEnabled(true)
        coordinator.whoopConnected()
        coordinator.whoopDisconnected()
        coordinator.whoopConnected()

        coordinator.whoopDisconnected()

        XCTAssertEqual(recorder.scheduled, [.whoopDisconnected, .whoopDisconnected])
    }

    func testIntentionalDisconnectCancelsOnlyWhoopAndClearsConnection() {
        let recorder = NotificationRecorder()
        let coordinator = recorder.makeCoordinator()
        coordinator.setEnabled(true)
        coordinator.whoopConnected()
        coordinator.whoopDisconnected()
        coordinator.appWillTerminate()
        recorder.cancellations.removeAll()

        coordinator.whoopIntentionallyDisconnected()
        coordinator.whoopDisconnected()

        XCTAssertEqual(recorder.cancellations, [["com.dofek.collection.whoop-disconnected"]])
        XCTAssertEqual(recorder.scheduled, [.whoopDisconnected, .appClosed])
    }

    func testTerminationWarnsWithoutAnyWhoopConnection() {
        let recorder = NotificationRecorder()
        let coordinator = recorder.makeCoordinator()
        coordinator.setEnabled(true)

        coordinator.appWillTerminate()

        XCTAssertEqual(recorder.scheduled, [.appClosed])
        XCTAssertEqual(recorder.scheduled.first?.identifier, "com.dofek.collection.app-closed")
        XCTAssertEqual(recorder.scheduled.first?.delay, 1)
    }

    func testForegroundCancelsOnlyAppClosureAlert() {
        let recorder = NotificationRecorder()
        let coordinator = recorder.makeCoordinator()
        coordinator.setEnabled(true)
        coordinator.whoopConnected()
        coordinator.whoopDisconnected()
        coordinator.appWillTerminate()
        recorder.cancellations.removeAll()

        coordinator.appBecameActive()

        XCTAssertEqual(recorder.cancellations, [["com.dofek.collection.app-closed"]])
        XCTAssertEqual(recorder.scheduled, [.whoopDisconnected, .appClosed])
    }

    func testForegroundDoesNotInferWhoopReconnection() {
        let recorder = NotificationRecorder()
        let coordinator = recorder.makeCoordinator()
        coordinator.setEnabled(true)
        coordinator.whoopConnected()
        coordinator.whoopDisconnected()

        coordinator.appBecameActive()
        coordinator.whoopDisconnected()

        XCTAssertEqual(recorder.scheduled, [.whoopDisconnected])
    }

    func testDisabledCoordinatorDoesNotScheduleEitherAlert() {
        let recorder = NotificationRecorder()
        let coordinator = recorder.makeCoordinator()

        coordinator.whoopConnected()
        coordinator.whoopDisconnected()
        coordinator.appWillTerminate()

        XCTAssertTrue(recorder.scheduled.isEmpty)
    }

    func testDisablingCancelsBothAlertKinds() {
        let recorder = NotificationRecorder()
        let coordinator = recorder.makeCoordinator()
        coordinator.setEnabled(true)
        coordinator.whoopConnected()
        coordinator.whoopDisconnected()
        coordinator.appWillTerminate()
        recorder.cancellations.removeAll()

        coordinator.setEnabled(false)
        coordinator.appWillTerminate()

        XCTAssertEqual(recorder.cancellations, [[
            "com.dofek.collection.whoop-disconnected",
            "com.dofek.collection.app-closed",
        ]])
        XCTAssertEqual(recorder.scheduled, [.whoopDisconnected, .appClosed])
    }

    func testReenablingRequiresANewWhoopConnection() {
        let recorder = NotificationRecorder()
        let coordinator = recorder.makeCoordinator()
        coordinator.setEnabled(true)
        coordinator.whoopConnected()
        coordinator.setEnabled(false)

        coordinator.setEnabled(true)
        coordinator.whoopDisconnected()
        coordinator.appWillTerminate()

        XCTAssertEqual(recorder.scheduled, [.appClosed])
    }

    func testConnectionsObservedWhileDisabledDoNotEnableWhoopWarnings() {
        let recorder = NotificationRecorder()
        let coordinator = recorder.makeCoordinator()
        coordinator.whoopConnected()

        coordinator.setEnabled(true)
        coordinator.whoopDisconnected()

        XCTAssertTrue(recorder.scheduled.isEmpty)
    }

    func testRepeatedEnablePreservesKnownWhoopConnection() {
        let recorder = NotificationRecorder()
        let coordinator = recorder.makeCoordinator()
        coordinator.setEnabled(true)
        coordinator.whoopConnected()

        coordinator.setEnabled(true)
        coordinator.whoopDisconnected()

        XCTAssertEqual(recorder.scheduled, [.whoopDisconnected])
    }

    func testEnablingDoesNotScheduleAnAppClosureAlert() {
        let recorder = NotificationRecorder()
        let coordinator = recorder.makeCoordinator()

        coordinator.setEnabled(true)
        coordinator.appBecameActive()

        XCTAssertTrue(recorder.scheduled.isEmpty)
    }
}

private final class NotificationRecorder {
    var scheduled: [CollectionNotification] = []
    var cancellations: [[String]] = []

    func makeCoordinator() -> CollectionNotificationCoordinator {
        CollectionNotificationCoordinator(
            schedule: { [self] in scheduled.append($0) },
            cancel: { [self] in cancellations.append($0) }
        )
    }
}
