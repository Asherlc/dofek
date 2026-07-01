import XCTest
@testable import BleHeartRateLib

final class BleHeartRateSampleBufferTests: XCTestCase {
    private func sample(bpm: Int, rrIntervals: [Int] = []) -> BleHeartRateSample {
        BleHeartRateSample(
            timestamp: Date(timeIntervalSince1970: 1_711_800_000),
            heartRateBpm: bpm,
            rrIntervalsMs: rrIntervals
        )
    }

    func testAppendIncrementsCount() {
        let buffer = BleHeartRateSampleBuffer()
        buffer.append(sample(bpm: 60))
        buffer.append(sample(bpm: 61))
        XCTAssertEqual(buffer.sampleCount, 2)
    }

    func testPeekDoesNotRemoveSamples() {
        let buffer = BleHeartRateSampleBuffer()
        buffer.append(sample(bpm: 60))
        _ = buffer.peekSamples()
        XCTAssertEqual(buffer.sampleCount, 1)
    }

    func testPeekSerializesFields() {
        let buffer = BleHeartRateSampleBuffer()
        buffer.append(sample(bpm: 142, rrIntervals: [1000, 500]))
        let peeked = buffer.peekSamples()
        XCTAssertEqual(peeked.count, 1)
        XCTAssertEqual(peeked[0]["heartRateBpm"] as? Int, 142)
        XCTAssertEqual(peeked[0]["rrIntervalsMs"] as? [Int], [1000, 500])
        XCTAssertEqual(peeked[0]["timestamp"] as? String, "2024-03-30T12:00:00.000Z")
    }

    func testPeekRespectsMaxCount() {
        let buffer = BleHeartRateSampleBuffer()
        buffer.append(sample(bpm: 60))
        buffer.append(sample(bpm: 61))
        buffer.append(sample(bpm: 62))
        XCTAssertEqual(buffer.peekSamples(maxCount: 2).count, 2)
    }

    func testConfirmDrainRemovesFromFront() {
        let buffer = BleHeartRateSampleBuffer()
        buffer.append(sample(bpm: 60))
        buffer.append(sample(bpm: 61))
        buffer.append(sample(bpm: 62))
        buffer.confirmDrain(count: 2)
        let remaining = buffer.peekSamples()
        XCTAssertEqual(remaining.count, 1)
        XCTAssertEqual(remaining[0]["heartRateBpm"] as? Int, 62)
    }

    func testConfirmDrainClampsToBufferSize() {
        let buffer = BleHeartRateSampleBuffer()
        buffer.append(sample(bpm: 60))
        buffer.confirmDrain(count: 5)
        XCTAssertEqual(buffer.sampleCount, 0)
    }

    func testClearAllEmptiesBuffer() {
        let buffer = BleHeartRateSampleBuffer()
        buffer.append(sample(bpm: 60))
        buffer.clearAll()
        XCTAssertEqual(buffer.sampleCount, 0)
    }
}
