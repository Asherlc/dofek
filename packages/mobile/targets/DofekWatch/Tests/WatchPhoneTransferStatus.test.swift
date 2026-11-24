#if canImport(XCTest)
@testable import DofekWatchTransferCore
import XCTest

final class WatchPhoneTransferStatusTests: XCTestCase {
    func testPausedOverridesQueuedOrError() {
        XCTAssertEqual(
            WatchPhoneTransferStatus.resolve(
                isSyncEnabled: false,
                isCompanionAvailable: true,
                hasOutstandingFileTransfers: true,
                isTransferring: false,
                hasFailedAttempt: true
            ),
            .paused
        )
    }

    func testQueuedSurvivesLiveIPhoneUnreachability() {
        XCTAssertEqual(
            WatchPhoneTransferStatus.resolve(
                isSyncEnabled: true,
                isCompanionAvailable: false,
                hasOutstandingFileTransfers: true,
                isTransferring: false,
                hasFailedAttempt: false
            ),
            .waitingForPhone
        )
    }

    func testUnavailableOverridesFalseEmptyStatus() {
        XCTAssertEqual(
            WatchPhoneTransferStatus.resolve(
                isSyncEnabled: true,
                isCompanionAvailable: false,
                hasOutstandingFileTransfers: false,
                isTransferring: false,
                hasFailedAttempt: false
            ),
            .unavailable
        )
    }

    func testPreparingWhileCurrentRequestActiveAndQueueEmpty() {
        XCTAssertEqual(
            WatchPhoneTransferStatus.resolve(
                isSyncEnabled: true,
                isCompanionAvailable: true,
                hasOutstandingFileTransfers: false,
                isTransferring: true,
                hasFailedAttempt: false
            ),
            .preparing
        )
    }

    func testFailedAfterUnsuccessfulAttempt() {
        XCTAssertEqual(
            WatchPhoneTransferStatus.resolve(
                isSyncEnabled: true,
                isCompanionAvailable: true,
                hasOutstandingFileTransfers: false,
                isTransferring: false,
                hasFailedAttempt: true
            ),
            .failed
        )
    }

    func testIdleWithEmptyQueue() {
        XCTAssertEqual(
            WatchPhoneTransferStatus.resolve(
                isSyncEnabled: true,
                isCompanionAvailable: true,
                hasOutstandingFileTransfers: false,
                isTransferring: false,
                hasFailedAttempt: false
            ),
            .empty
        )
    }

    func testQueueTakesPrecedenceOverPriorError() {
        XCTAssertEqual(
            WatchPhoneTransferStatus.resolve(
                isSyncEnabled: true,
                isCompanionAvailable: true,
                hasOutstandingFileTransfers: true,
                isTransferring: false,
                hasFailedAttempt: true
            ),
            .waitingForPhone
        )
    }

    func testUnavailableTakesPrecedenceOverPriorFailure() {
        XCTAssertEqual(
            WatchPhoneTransferStatus.resolve(
                isSyncEnabled: true,
                isCompanionAvailable: false,
                hasOutstandingFileTransfers: false,
                isTransferring: false,
                hasFailedAttempt: true
            ),
            .unavailable
        )
    }
}
#endif
