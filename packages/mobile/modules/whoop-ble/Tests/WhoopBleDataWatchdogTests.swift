import XCTest
@testable import WhoopBleLib

final class WhoopBleDataWatchdogTests: XCTestCase {

    private var watchdog: WhoopBleDataWatchdog!
    private var delegateHandler: MockWatchdogDelegate!
    private var queue: DispatchQueue!

    override func setUp() {
        super.setUp()
        queue = DispatchQueue(label: "test.watchdog")
        watchdog = WhoopBleDataWatchdog(queue: queue, timeoutSeconds: 0.3)
        delegateHandler = MockWatchdogDelegate()
        watchdog.delegate = delegateHandler
    }

    override func tearDown() {
        watchdog.stop()
        watchdog = nil
        delegateHandler = nil
        queue = nil
        super.tearDown()
    }

    func testDetectsSilenceAfterTimeout() {
        let expectation = expectation(description: "watchdog fires")
        delegateHandler.onSilence = { _, _ in
            expectation.fulfill()
        }

        queue.async { self.watchdog.start() }
        waitForExpectations(timeout: 2)

        XCTAssertEqual(watchdog.retryCount, 1)
    }

    func testRecordDataReceivedResetsTimer() {
        let silenceExpectation = expectation(description: "watchdog fires")
        silenceExpectation.isInverted = true
        delegateHandler.onSilence = { _, _ in
            silenceExpectation.fulfill()
        }

        queue.async { self.watchdog.start() }

        // Keep nudging the watchdog before it times out (0.3s timeout)
        for delay in stride(from: 0.1, through: 0.5, by: 0.1) {
            queue.asyncAfter(deadline: .now() + delay) {
                self.watchdog.recordDataReceived()
            }
        }

        // Wait slightly longer than the timeout — should NOT fire because we kept resetting
        waitForExpectations(timeout: 0.7)
    }

    func testStopPreventsCallback() {
        let expectation = expectation(description: "watchdog should not fire")
        expectation.isInverted = true
        delegateHandler.onSilence = { _, _ in
            expectation.fulfill()
        }

        queue.async {
            self.watchdog.start()
            self.watchdog.stop()
        }

        waitForExpectations(timeout: 0.6)
        XCTAssertEqual(watchdog.retryCount, 0)
    }

    func testRetryCountIncrements() {
        let expectation = expectation(description: "watchdog fires twice")
        expectation.expectedFulfillmentCount = 2
        delegateHandler.onSilence = { _, _ in
            expectation.fulfill()
        }

        queue.async { self.watchdog.start() }
        waitForExpectations(timeout: 2)

        XCTAssertEqual(watchdog.retryCount, 2)
    }

    func testRetryCountPassedToDelegate() {
        var receivedCounts: [UInt64] = []
        let expectation = expectation(description: "watchdog fires twice")
        expectation.expectedFulfillmentCount = 2
        delegateHandler.onSilence = { _, count in
            receivedCounts.append(count)
            expectation.fulfill()
        }

        queue.async { self.watchdog.start() }
        waitForExpectations(timeout: 2)

        XCTAssertEqual(receivedCounts, [1, 2])
    }

    func testStartResetsTimestamp() {
        // Start, let it fire once, stop, start again — retry count continues
        let firstFire = expectation(description: "first fire")
        delegateHandler.onSilence = { _, _ in
            firstFire.fulfill()
        }

        queue.async { self.watchdog.start() }
        waitForExpectations(timeout: 1)

        queue.sync { self.watchdog.stop() }

        let secondFire = expectation(description: "second fire")
        delegateHandler.onSilence = { _, _ in
            secondFire.fulfill()
        }

        queue.async { self.watchdog.start() }
        waitForExpectations(timeout: 1)

        XCTAssertEqual(watchdog.retryCount, 2)
    }
}

// MARK: - Mock

private final class MockWatchdogDelegate: WhoopBleDataWatchdogDelegate {
    var onSilence: ((WhoopBleDataWatchdog, UInt64) -> Void)?

    func watchdogDidDetectSilence(_ watchdog: WhoopBleDataWatchdog, retryCount: UInt64) {
        onSilence?(watchdog, retryCount)
    }
}
