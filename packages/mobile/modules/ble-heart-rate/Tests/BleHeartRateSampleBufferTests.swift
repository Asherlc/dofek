import XCTest
@testable import BleHeartRateLib

final class BleHeartRateSampleBufferTests: XCTestCase {
    private func sample(bpm: Int, rrIntervals: [Int] = []) -> BleHeartRateSample {
        BleHeartRateSample(
            deviceId: "strap-a",
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

    func testPeekSerializesCapturedDeviceId() {
        let buffer = BleHeartRateSampleBuffer()
        buffer.append(
            BleHeartRateSample(
                deviceId: "strap-a",
                timestamp: Date(timeIntervalSince1970: 1_711_800_000),
                heartRateBpm: 142,
                rrIntervalsMs: []
            )
        )

        let peeked = buffer.peekSamples()

        XCTAssertEqual(peeked[0]["deviceId"] as? String, "strap-a")
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

    func testConfirmDrainAfterOverflowOnlyRemovesStillBufferedPeekedSamples() {
        let buffer = BleHeartRateSampleBuffer()
        for index in 0..<86_400 {
            buffer.append(sample(bpm: index))
        }

        let peeked = buffer.peekSamples(maxCount: 5)
        XCTAssertEqual(peeked.map { $0["heartRateBpm"] as? Int }, [0, 1, 2, 3, 4])

        for index in 86_400..<86_403 {
            buffer.append(sample(bpm: index))
        }

        buffer.confirmDrain(count: 5)

        let remaining = buffer.peekSamples(maxCount: 1)
        XCTAssertEqual(remaining.first?["heartRateBpm"] as? Int, 5)
    }

    func testClearAllEmptiesBuffer() {
        let buffer = BleHeartRateSampleBuffer()
        buffer.append(sample(bpm: 60))
        buffer.clearAll()
        XCTAssertEqual(buffer.sampleCount, 0)
    }

    func testNegativePeekCountReturnsEmptyWithoutCrashing() {
        let buffer = BleHeartRateSampleBuffer()
        buffer.append(sample(bpm: 60))
        XCTAssertEqual(buffer.peekSamples(maxCount: -5).count, 0)
    }

    func testNegativeDrainCountIsClampedWithoutCrashing() {
        let buffer = BleHeartRateSampleBuffer()
        buffer.append(sample(bpm: 60))
        buffer.confirmDrain(count: -5)
        XCTAssertEqual(buffer.sampleCount, 1)
    }
}
