import XCTest
@testable import WhoopBleLib

final class WhoopBleOrientationProcessorTests: XCTestCase {

    private var processor: WhoopBleOrientationProcessor!

    override func setUp() {
        super.setUp()
        processor = WhoopBleOrientationProcessor(sampleRate: 100, beta: 0.1, emitInterval: 3)
    }

    func testEmitsOrientationEveryNthSample() {
        var emitCount = 0
        let samples = makeStationarySamples(count: 9) // 9 samples / 3 interval = 3 emissions

        processor.processSamples(samples) { _, _ in
            emitCount += 1
        }

        XCTAssertEqual(emitCount, 3)
    }

    func testNoEmissionForFewerThanIntervalSamples() {
        var emitCount = 0
        let samples = makeStationarySamples(count: 2) // 2 < 3

        processor.processSamples(samples) { _, _ in
            emitCount += 1
        }

        XCTAssertEqual(emitCount, 0)
    }

    func testEmittedQuaternionIsNormalized() {
        let samples = makeStationarySamples(count: 30)
        var lastQuaternion: Quaternion?

        processor.processSamples(samples) { quaternion, _ in
            lastQuaternion = quaternion
        }

        guard let quaternion = lastQuaternion else {
            XCTFail("No orientation emitted")
            return
        }

        let magnitude = sqrt(
            quaternion.w * quaternion.w +
            quaternion.x * quaternion.x +
            quaternion.y * quaternion.y +
            quaternion.z * quaternion.z
        )
        XCTAssertEqual(magnitude, 1.0, accuracy: 0.01)
    }

    func testEulerAnglesInExpectedRanges() {
        let samples = makeStationarySamples(count: 30)
        var lastEuler: EulerAngles?

        processor.processSamples(samples) { _, euler in
            lastEuler = euler
        }

        guard let euler = lastEuler else {
            XCTFail("No orientation emitted")
            return
        }

        XCTAssertGreaterThanOrEqual(euler.roll, -180)
        XCTAssertLessThanOrEqual(euler.roll, 180)
        XCTAssertGreaterThanOrEqual(euler.pitch, -90)
        XCTAssertLessThanOrEqual(euler.pitch, 90)
        XCTAssertGreaterThanOrEqual(euler.yaw, -180)
        XCTAssertLessThanOrEqual(euler.yaw, 180)
    }

    func testResetClearsFilterState() {
        // Process some samples to change filter state
        let samples = makeStationarySamples(count: 30)
        processor.processSamples(samples) { _, _ in }

        processor.reset()

        // After reset, the emission counter should restart
        var emitCount = 0
        let moreSamples = makeStationarySamples(count: 3) // exactly one interval
        processor.processSamples(moreSamples) { _, _ in
            emitCount += 1
        }

        XCTAssertEqual(emitCount, 1)
    }

    func testEmitCounterPersistsAcrossCalls() {
        var emitCount = 0

        // 2 samples — not enough for one emission (interval = 3)
        processor.processSamples(makeStationarySamples(count: 2)) { _, _ in
            emitCount += 1
        }
        XCTAssertEqual(emitCount, 0)

        // 1 more sample — counter was at 2, now hits 3 → emit
        processor.processSamples(makeStationarySamples(count: 1)) { _, _ in
            emitCount += 1
        }
        XCTAssertEqual(emitCount, 1)
    }

    // MARK: - Helpers

    private func makeStationarySamples(count: Int) -> [WhoopImuSample] {
        (0..<count).map { index in
            WhoopImuSample(
                timestampSeconds: 1711000000,
                subSeconds: 0,
                sampleIndex: index,
                accelerometerX: 0,
                accelerometerY: 0,
                accelerometerZ: 1.0,  // gravity along Z
                gyroscopeX: 0,
                gyroscopeY: 0,
                gyroscopeZ: 0
            )
        }
    }
}
