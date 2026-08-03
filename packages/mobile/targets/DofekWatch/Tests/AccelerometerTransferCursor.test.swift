// @bacons/apple-targets includes all Swift files in the target directory as app
// target sources. XCTest is only available on the framework search path for test
// targets, so guard the entire file to prevent app-build import failures.
#if canImport(XCTest)
@testable import DofekWatchTransferCore
import Foundation
import XCTest

final class AccelerometerTransferCursorTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "AccelerometerTransferCursorTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    func testPreparationFailureBeforeQueueingDoesNotAdvanceConfirmedCursor() {
        let cursor = AccelerometerTransferCursor(defaults: defaults)
        let confirmedBoundary = Date(timeIntervalSince1970: 100)
        let preparedBoundary = Date(timeIntervalSince1970: 200)
        cursor.confirm(through: confirmedBoundary)

        // A preparation failure ends the lifecycle after metadata creation,
        // before WatchConnectivity can provide a completion callback.
        _ = cursor.metadata(through: preparedBoundary)

        XCTAssertEqual(cursor.confirmedBoundary, confirmedBoundary)
    }

    func testFailedQueuedTransferDoesNotAdvanceConfirmedCursor() {
        let cursor = AccelerometerTransferCursor(defaults: defaults)
        let confirmedBoundary = Date(timeIntervalSince1970: 100)
        let queuedBoundary = Date(timeIntervalSince1970: 200)
        cursor.confirm(through: confirmedBoundary)
        let metadata = cursor.metadata(through: queuedBoundary)

        let completion = cursor.completeTransfer(
            metadata: metadata,
            error: TestTransferError.deliveryFailed
        )

        guard case .failed = completion else {
            return XCTFail("Expected failed completion")
        }
        XCTAssertEqual(cursor.confirmedBoundary, confirmedBoundary)
    }

    func testMalformedSuccessfulCompletionDoesNotAdvanceConfirmedCursor() {
        let cursor = AccelerometerTransferCursor(defaults: defaults)
        let confirmedBoundary = Date(timeIntervalSince1970: 100)
        cursor.confirm(through: confirmedBoundary)

        let completion = cursor.completeTransfer(metadata: [:], error: nil)

        guard case .invalidMetadata = completion else {
            return XCTFail("Expected invalid metadata completion")
        }
        XCTAssertEqual(cursor.confirmedBoundary, confirmedBoundary)
    }

    func testSuccessfulCompletionAdvancesToTransferredBoundary() {
        let cursor = AccelerometerTransferCursor(defaults: defaults)
        let confirmedBoundary = Date(timeIntervalSince1970: 100)
        let transferredBoundary = Date(timeIntervalSince1970: 200.125)
        cursor.confirm(through: confirmedBoundary)
        let metadata = cursor.metadata(through: transferredBoundary)

        let completion = cursor.completeTransfer(metadata: metadata, error: nil)

        guard case let .confirmed(boundary) = completion else {
            return XCTFail("Expected confirmed completion")
        }
        XCTAssertEqual(boundary, transferredBoundary)
        XCTAssertEqual(cursor.confirmedBoundary, transferredBoundary)
    }

    func testAccountPurgeClearsConfirmedBoundary() {
        let cursor = AccelerometerTransferCursor(defaults: defaults)
        cursor.confirm(through: Date(timeIntervalSince1970: 200))

        cursor.purge()

        XCTAssertNil(cursor.confirmedBoundary)
    }
}

private enum TestTransferError: Error {
    case deliveryFailed
}
#endif
