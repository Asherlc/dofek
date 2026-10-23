#if canImport(XCTest)
@testable import DofekWatchTransferCore
import Foundation
import XCTest

final class WatchRecordingCallbackFenceTests: XCTestCase {
    func testPriorSessionCannotAppendAfterRecordingRestarts() {
        let fence = WatchRecordingCallbackFence()
        var samples: [Int] = []
        let first = fence.reset()
        fence.apply(ifCurrent: first) { samples.append(1) }
        let second = fence.reset()

        fence.apply(ifCurrent: first) { samples.append(2) }
        fence.apply(ifCurrent: second) { samples.append(3) }

        XCTAssertEqual(samples, [1, 3])
    }

    func testQueuedErrorCannotStopAReplacementRecording() {
        let fence = WatchRecordingCallbackFence()
        let first = fence.reset()
        let queued = DispatchSemaphore(value: 0)
        let result = CallbackResult()
        DispatchQueue.global().async {
            fence.whenCurrentOnMain(first) { result.oldRecordingStopped = true }
            queued.signal()
        }
        XCTAssertEqual(queued.wait(timeout: .now() + 1), .success)

        let second = fence.reset()
        fence.whenCurrentOnMain(second) { result.currentRecordingHandled = true }
        drainMainQueue()

        XCTAssertFalse(result.oldRecordingStopped)
        XCTAssertTrue(result.currentRecordingHandled)
    }

    func testCurrentErrorRunsOnMainAndCanInvalidateWithoutHoldingTheFenceLock() {
        let fence = WatchRecordingCallbackFence()
        let current = fence.reset()
        let applied = expectation(description: "current error applied")
        DispatchQueue.global().async {
            fence.whenCurrentOnMain(current) {
                XCTAssertTrue(Thread.isMainThread)
                fence.reset()
                applied.fulfill()
            }
        }

        wait(for: [applied], timeout: 1)
    }

    func testPurgeInvalidatesPriorCallbacksAndPreservesALaterRecording() {
        let fence = WatchRecordingCallbackFence()
        let first = fence.reset()
        var samples = [1]
        let purged = fence.reset { samples.removeAll() }
        fence.apply(ifCurrent: first) { samples.append(2) }
        XCTAssertTrue(samples.isEmpty)
        let queued = DispatchSemaphore(value: 0)
        let result = CallbackResult()
        DispatchQueue.global().async {
            fence.whenCurrentOnMain(purged) { result.oldRecordingStopped = true }
            queued.signal()
        }
        XCTAssertEqual(queued.wait(timeout: .now() + 1), .success)

        let second = fence.reset()
        fence.apply(ifCurrent: second) { samples.append(3) }
        drainMainQueue()

        XCTAssertFalse(result.oldRecordingStopped)
        XCTAssertEqual(samples, [3])
    }

    func testAppendAndPurgeCannotInterleaveTheirBufferMutations() {
        let fence = WatchRecordingCallbackFence()
        let current = fence.reset()
        let buffer = CallbackBuffer()
        let appendEntered = DispatchSemaphore(value: 0)
        let releaseAppend = DispatchSemaphore(value: 0)
        let purgeStarted = DispatchSemaphore(value: 0)
        let purgeFinished = DispatchSemaphore(value: 0)
        let appended = expectation(description: "append completed")
        DispatchQueue.global().async {
            fence.apply(ifCurrent: current) {
                appendEntered.signal()
                XCTAssertEqual(releaseAppend.wait(timeout: .now() + 1), .success)
                buffer.samples.append(1)
            }
            appended.fulfill()
        }
        XCTAssertEqual(appendEntered.wait(timeout: .now() + 1), .success)
        DispatchQueue.global().async {
            purgeStarted.signal()
            fence.reset { buffer.samples.removeAll() }
            purgeFinished.signal()
        }
        XCTAssertEqual(purgeStarted.wait(timeout: .now() + 1), .success)

        XCTAssertEqual(purgeFinished.wait(timeout: .now() + 0.1), .timedOut)
        releaseAppend.signal()
        wait(for: [appended], timeout: 1)
        XCTAssertEqual(purgeFinished.wait(timeout: .now() + 1), .success)
        XCTAssertTrue(buffer.samples.isEmpty)
    }

    private func drainMainQueue() {
        let drained = expectation(description: "main queue drained")
        DispatchQueue.main.async { drained.fulfill() }
        wait(for: [drained], timeout: 1)
    }
}

private final class CallbackResult {
    var oldRecordingStopped = false
    var currentRecordingHandled = false
}

private final class CallbackBuffer {
    var samples: [Int] = []
}
#endif
