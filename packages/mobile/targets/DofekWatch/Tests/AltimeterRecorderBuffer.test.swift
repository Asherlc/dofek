// @bacons/apple-targets includes all Swift files in the target directory as app
// target sources. XCTest is only available on the framework search path for test
// targets, so guard the entire file to prevent "no such module" errors during
// app builds (both device and simulator).
#if canImport(XCTest)
import XCTest

/// Verifies the count-based buffer trim used by `AltimeterRecorder.clearBufferedSamples(count:)`.
///
/// Samples appended after `copyBufferedSamples()` must survive a transfer clear so
/// in-flight recordings are not dropped while JSON is serialized and transferred.
final class AltimeterRecorderBufferTests: XCTestCase {
    private func trimBufferedSamples(buffer: inout [Int], count: Int) {
        if count >= buffer.count {
            buffer.removeAll()
        } else if count > 0 {
            buffer.removeFirst(count)
        }
    }

    func testTrimRemovesOnlyTransferredPrefix() {
        var buffer = [1, 2, 3, 4, 5]
        trimBufferedSamples(buffer: &buffer, count: 3)
        XCTAssertEqual(buffer, [4, 5])
    }

    func testTrimClearsEntireBufferWhenCountMatchesSnapshot() {
        var buffer = [1, 2, 3]
        trimBufferedSamples(buffer: &buffer, count: 3)
        XCTAssertTrue(buffer.isEmpty)
    }

    func testTrimPreservesSamplesAppendedAfterSnapshot() {
        var snapshot = [1, 2, 3]
        var buffer = snapshot
        buffer.append(contentsOf: [4, 5])
        trimBufferedSamples(buffer: &buffer, count: snapshot.count)
        XCTAssertEqual(buffer, [4, 5])
    }

    func testTrimIgnoresZeroCount() {
        var buffer = [1, 2, 3]
        trimBufferedSamples(buffer: &buffer, count: 0)
        XCTAssertEqual(buffer, [1, 2, 3])
    }
}
#endif
