#if canImport(XCTest)
@testable import DofekWatchTransferCore
import XCTest

final class GyroscopeSampleBufferTests: XCTestCase {
    func testPreparationFailureRetainsSnapshotSamples() {
        let buffer = GyroscopeSampleBuffer()
        buffer.append(sample(id: 1))
        buffer.append(sample(id: 2))

        let snapshot = buffer.snapshot()

        XCTAssertEqual(snapshot.count, 2)
        XCTAssertEqual(sampleIDs(in: buffer.snapshot()), [1, 2])
    }

    func testTransferFailureRetainsQueuedSamples() {
        let buffer = GyroscopeSampleBuffer()
        buffer.append(sample(id: 1))
        buffer.append(sample(id: 2))
        let queuedSnapshot = buffer.snapshot()

        // A failed delivery never confirms the queued snapshot.

        XCTAssertEqual(queuedSnapshot.count, 2)
        XCTAssertEqual(sampleIDs(in: buffer.snapshot()), [1, 2])
    }

    func testSuccessfulConfirmationRetainsSamplesAppendedAfterSnapshot() {
        let buffer = GyroscopeSampleBuffer()
        buffer.append(sample(id: 1))
        buffer.append(sample(id: 2))
        let queuedSnapshot = buffer.snapshot()
        buffer.append(sample(id: 3))

        buffer.confirmTransferredSamples(count: queuedSnapshot.count)

        XCTAssertEqual(sampleIDs(in: buffer.snapshot()), [3])
    }

    func testSuccessfulConfirmationRemovesExactSnapshot() {
        let buffer = GyroscopeSampleBuffer()
        buffer.append(sample(id: 1))
        buffer.append(sample(id: 2))
        let queuedSnapshot = buffer.snapshot()

        buffer.confirmTransferredSamples(count: queuedSnapshot.count)

        XCTAssertEqual(buffer.count, 0)
    }

    func testAccountPurgeClearsEveryBufferedSample() {
        let buffer = GyroscopeSampleBuffer()
        buffer.append(sample(id: 1))
        buffer.append(sample(id: 2))

        buffer.clearAll()

        XCTAssertEqual(buffer.count, 0)
    }

    private func sample(id: Int) -> [String: Any] {
        ["id": id]
    }

    private func sampleIDs(in samples: [[String: Any]]) -> [Int] {
        samples.compactMap { $0["id"] as? Int }
    }
}
#endif
