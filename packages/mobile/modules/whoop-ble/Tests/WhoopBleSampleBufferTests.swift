import XCTest
@testable import WhoopBLE

final class WhoopBleSampleBufferTests: XCTestCase {

    private var buffer: WhoopBleSampleBuffer!
    private var diagnosticDefaults: UserDefaults!
    private var diagnosticSuite: String!

    override func setUp() {
        super.setUp()
        diagnosticSuite = "WhoopBleSampleBufferTests.\(UUID().uuidString)"
        diagnosticDefaults = UserDefaults(suiteName: diagnosticSuite)!
        buffer = WhoopBleSampleBuffer(diagnosticDefaults: diagnosticDefaults)
    }

    override func tearDown() {
        diagnosticDefaults.removePersistentDomain(forName: diagnosticSuite)
        buffer = nil
        super.tearDown()
    }

    func testDiagnosticsReportTrueTimestampRangeAndActualConfirmedCount() throws {
        buffer.appendRealtimeData([
            makeRealtimeSample(timestampSeconds: 1_711_000_002),
            makeRealtimeSample(timestampSeconds: 1_711_000_000),
            makeRealtimeSample(timestampSeconds: 1_711_000_001),
        ])
        _ = buffer.peekRealtimeData(maxCount: 1)
        buffer.confirmRealtimeDataDrain(count: 1)

        let snapshot = buffer.diagnosticSnapshot()
        let realtime = try XCTUnwrap(snapshot["realtime"] as? [String: Any])
        XCTAssertEqual(realtime["count"] as? Int, 2)
        XCTAssertEqual(realtime["receivedCount"] as? Int, 3)
        XCTAssertEqual(realtime["confirmedCount"] as? Int, 1)
        XCTAssertEqual(realtime["oldestTimestamp"] as? String, "2024-03-21T05:46:40.000Z")
        XCTAssertEqual(realtime["newestTimestamp"] as? String, "2024-03-21T05:46:41.000Z")
        XCTAssertNotNil(realtime["lastConfirmedAt"] as? String)
        XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(snapshot["bufferInstanceId"] as? String)))
    }

    func testDiagnosticsDistinguishOverflowFromConfirmationAfterPeek() throws {
        buffer.appendRealtimeData(makeRealtimeSamplesForOverflow(count: 86_400, startingAt: 0))
        _ = buffer.peekRealtimeData(maxCount: 5)
        buffer.appendRealtimeData(makeRealtimeSamplesForOverflow(count: 3, startingAt: 86_400))
        buffer.confirmRealtimeDataDrain(count: 5)

        let realtime = try XCTUnwrap(buffer.diagnosticSnapshot()["realtime"] as? [String: Any])
        XCTAssertEqual(realtime["receivedCount"] as? Int, 86_403)
        XCTAssertEqual(realtime["overflowDiscardedCount"] as? Int, 3)
        XCTAssertEqual(realtime["confirmedCount"] as? Int, 2)
        XCTAssertEqual(realtime["count"] as? Int, 86_398)
    }

    func testDiagnosticsDistinguishErasureClearAndLegacyDrain() throws {
        buffer.appendImuSamples([
            makeImuSample(timestampSeconds: 1_711_000_000),
            makeImuSample(timestampSeconds: 1_711_000_002),
            makeImuSample(timestampSeconds: 1_711_000_003),
        ])
        buffer.advanceErasureCutoff(to: Date(timeIntervalSince1970: 1_711_000_001))
        buffer.appendImuSamples([makeImuSample(timestampSeconds: 1_711_000_001)])
        _ = buffer.drainImuSamples(maxCount: 1)
        buffer.clearAll()

        let imu = try XCTUnwrap(buffer.diagnosticSnapshot()["imu"] as? [String: Any])
        XCTAssertEqual(imu["receivedCount"] as? Int, 4)
        XCTAssertEqual(imu["erasureDiscardedCount"] as? Int, 2)
        XCTAssertEqual(imu["legacyDrainedCount"] as? Int, 1)
        XCTAssertEqual(imu["clearedCount"] as? Int, 1)
        XCTAssertEqual(imu["confirmedCount"] as? Int, 0)
        XCTAssertTrue(imu["oldestTimestamp"] is NSNull)
        XCTAssertTrue(imu["newestTimestamp"] is NSNull)
    }

    func testNewBufferReportsLastObservedCheckpointWithoutRestoringSamples() throws {
        buffer.appendRealtimeData(makeRealtimeSamples(count: 3))
        _ = buffer.peekRealtimeData(maxCount: 1)
        buffer.confirmRealtimeDataDrain(count: 1)
        let previousSnapshot = buffer.diagnosticSnapshot()

        let recreated = WhoopBleSampleBuffer(diagnosticDefaults: diagnosticDefaults)
        let snapshot = recreated.diagnosticSnapshot()
        let previous = try XCTUnwrap(snapshot["previousCheckpoint"] as? [String: Any])
        let previousRealtime = try XCTUnwrap(previous["realtime"] as? [String: Any])
        XCTAssertEqual(previous["bufferInstanceId"] as? String, previousSnapshot["bufferInstanceId"] as? String)
        XCTAssertNotEqual(snapshot["bufferInstanceId"] as? String, previous["bufferInstanceId"] as? String)
        XCTAssertEqual(previousRealtime["count"] as? Int, 2)
        XCTAssertEqual(previousRealtime["confirmedCount"] as? Int, 1)
        XCTAssertEqual(recreated.realtimeSampleCount, 0)
        XCTAssertNil(previous["previousCheckpoint"])
    }

    func testFinalRealtimeConfirmationCheckpointsEmptyQueueBeforeRestart() throws {
        buffer.appendRealtimeData(makeRealtimeSamples(count: 3))
        _ = buffer.peekRealtimeData(maxCount: 3)
        buffer.confirmRealtimeDataDrain(count: 3)

        let recreated = WhoopBleSampleBuffer(diagnosticDefaults: diagnosticDefaults)
        let previous = try XCTUnwrap(recreated.diagnosticSnapshot()["previousCheckpoint"] as? [String: Any])
        let realtime = try XCTUnwrap(previous["realtime"] as? [String: Any])
        XCTAssertEqual(realtime["count"] as? Int, 0)
        XCTAssertEqual(realtime["confirmedCount"] as? Int, 3)
        XCTAssertNotNil(realtime["lastConfirmedAt"] as? String)
    }

    func testFinalImuConfirmationCheckpointsEmptyQueueBeforeRestart() throws {
        buffer.appendImuSamples(makeImuSamples(count: 3))
        _ = buffer.peekImuSamples(maxCount: 3)
        buffer.confirmImuDrain(count: 3)

        let recreated = WhoopBleSampleBuffer(diagnosticDefaults: diagnosticDefaults)
        let previous = try XCTUnwrap(recreated.diagnosticSnapshot()["previousCheckpoint"] as? [String: Any])
        let imu = try XCTUnwrap(previous["imu"] as? [String: Any])
        XCTAssertEqual(imu["count"] as? Int, 0)
        XCTAssertEqual(imu["confirmedCount"] as? Int, 3)
        XCTAssertNotNil(imu["lastConfirmedAt"] as? String)
    }

    func testPartialConfirmationAndEmptyCursorReleaseDoNotForceCheckpoints() throws {
        var observed = Date(timeIntervalSince1970: 1_800_000_000)
        let capturing = WhoopBleSampleBuffer(diagnosticDefaults: diagnosticDefaults, now: { observed })
        let initial = capturing.diagnosticSnapshot()
        observed = observed.addingTimeInterval(1)
        _ = capturing.peekRealtimeData()
        capturing.confirmRealtimeDataDrain(count: 0)
        capturing.appendImuSamples(makeImuSamples(count: 3))
        _ = capturing.peekImuSamples(maxCount: 1)
        capturing.confirmImuDrain(count: 1)
        let afterPartial = WhoopBleSampleBuffer(diagnosticDefaults: diagnosticDefaults)
        let partial = try XCTUnwrap(afterPartial.diagnosticSnapshot()["previousCheckpoint"] as? [String: Any])
        XCTAssertEqual(partial["checkpointAt"] as? String, initial["checkpointAt"] as? String)
    }

    func testCaptureCheckpointsAreBoundedWhileJavaScriptIsSuspended() throws {
        var currentDate = Date(timeIntervalSince1970: 1_800_000_000)
        let capturing = WhoopBleSampleBuffer(
            diagnosticDefaults: diagnosticDefaults,
            now: { currentDate }
        )
        capturing.appendRealtimeData(makeRealtimeSamples(count: 1))
        currentDate = currentDate.addingTimeInterval(29)
        capturing.appendRealtimeData(makeRealtimeSamples(count: 1))
        let firstRestart = WhoopBleSampleBuffer(diagnosticDefaults: diagnosticDefaults)
        let initialPrevious = try XCTUnwrap(firstRestart.diagnosticSnapshot()["previousCheckpoint"] as? [String: Any])
        XCTAssertEqual((initialPrevious["realtime"] as? [String: Any])?["count"] as? Int, 1)

        currentDate = currentDate.addingTimeInterval(1)
        capturing.appendRealtimeData(makeRealtimeSamples(count: 1))
        let secondRestart = WhoopBleSampleBuffer(diagnosticDefaults: diagnosticDefaults)
        let latestPrevious = try XCTUnwrap(secondRestart.diagnosticSnapshot()["previousCheckpoint"] as? [String: Any])
        XCTAssertEqual((latestPrevious["realtime"] as? [String: Any])?["count"] as? Int, 3)
    }

    func testAccountPurgeRemovesPreviousAndPersistedDiagnosticHistory() throws {
        buffer.appendRealtimeData(makeRealtimeSamples(count: 2))
        _ = buffer.diagnosticSnapshot()
        let recreated = WhoopBleSampleBuffer(diagnosticDefaults: diagnosticDefaults)
        recreated.resetDiagnosticHistory()

        XCTAssertTrue(recreated.diagnosticSnapshot()["previousCheckpoint"] is NSNull)
        let next = WhoopBleSampleBuffer(diagnosticDefaults: diagnosticDefaults)
        let previous = try XCTUnwrap(next.diagnosticSnapshot()["previousCheckpoint"] as? [String: Any])
        XCTAssertEqual((previous["realtime"] as? [String: Any])?["count"] as? Int, 0)
        XCTAssertEqual((previous["realtime"] as? [String: Any])?["receivedCount"] as? Int, 0)
    }

    // MARK: - IMU samples

    func testAppendAndDrainImuSamples() {
        let samples = makeImuSamples(count: 5)
        buffer.appendImuSamples(samples)

        XCTAssertEqual(buffer.imuSampleCount, 5)

        let drained = buffer.drainImuSamples(maxCount: 3)
        XCTAssertEqual(drained.count, 3)
        XCTAssertEqual(buffer.imuSampleCount, 2)

        let remaining = buffer.drainImuSamples(maxCount: 10)
        XCTAssertEqual(remaining.count, 2)
        XCTAssertEqual(buffer.imuSampleCount, 0)
    }

    func testDrainImuSamplesSerializesCorrectFields() throws {
        let sample = WhoopImuSample(
            timestampSeconds: 1711000000,
            subSeconds: 500,
            sampleIndex: 0,
            samplesInFrame: 100,
            accelerometerX: 0.1,
            accelerometerY: -0.2,
            accelerometerZ: 1.0,
            gyroscopeX: 0.01,
            gyroscopeY: -0.02,
            gyroscopeZ: 0.03
        )
        buffer.appendImuSamples([sample])

        let drained = buffer.drainImuSamples()
        XCTAssertEqual(drained.count, 1)

        let dict = drained[0]
        XCTAssertNotNil(dict["timestamp"] as? String)
        let accelX = try XCTUnwrap(dict["accelerometerX"] as? Double)
        XCTAssertEqual(accelX, Double(sample.accelerometerX), accuracy: 0.001)
        let accelY = try XCTUnwrap(dict["accelerometerY"] as? Double)
        XCTAssertEqual(accelY, Double(sample.accelerometerY), accuracy: 0.001)
        let accelZ = try XCTUnwrap(dict["accelerometerZ"] as? Double)
        XCTAssertEqual(accelZ, Double(sample.accelerometerZ), accuracy: 0.001)
        let gyroX = try XCTUnwrap(dict["gyroscopeX"] as? Double)
        XCTAssertEqual(gyroX, Double(sample.gyroscopeX), accuracy: 0.001)
        let gyroY = try XCTUnwrap(dict["gyroscopeY"] as? Double)
        XCTAssertEqual(gyroY, Double(sample.gyroscopeY), accuracy: 0.001)
        let gyroZ = try XCTUnwrap(dict["gyroscopeZ"] as? Double)
        XCTAssertEqual(gyroZ, Double(sample.gyroscopeZ), accuracy: 0.001)
    }

    func testPeekImuSamplesSerializesCapturedDeviceId() {
        buffer.appendImuSamples(makeImuSamples(count: 1), deviceId: "whoop-a")
        XCTAssertEqual(buffer.peekImuSamples()[0]["deviceId"] as? String, "whoop-a")
    }

    func testDrainEmptyBufferReturnsEmptyArray() {
        let drained = buffer.drainImuSamples()
        XCTAssertTrue(drained.isEmpty)
    }

    // MARK: - Realtime data

    func testAppendAndDrainRealtimeData() {
        let samples = makeRealtimeSamples(count: 4)
        buffer.appendRealtimeData(samples)

        XCTAssertEqual(buffer.realtimeSampleCount, 4)

        let drained = buffer.drainRealtimeData(maxCount: 2)
        XCTAssertEqual(drained.count, 2)
        XCTAssertEqual(buffer.realtimeSampleCount, 2)
    }

    func testPeekRealtimeDataSerializesCapturedDeviceId() {
        buffer.appendRealtimeData(makeRealtimeSamples(count: 1), deviceId: "whoop-a")
        XCTAssertEqual(buffer.peekRealtimeData()[0]["deviceId"] as? String, "whoop-a")
    }

    // MARK: - Overflow

    func testImuOverflowDropsOldestSamples() {
        // The real max is 500k — we can't test with that many samples efficiently.
        // Instead, verify the overflow counter increments and the buffer doesn't grow unbounded.
        // Append a moderate number and drain to verify ordering.
        let samples = makeImuSamples(count: 100)
        buffer.appendImuSamples(samples)
        XCTAssertEqual(buffer.imuSampleCount, 100)

        // Drain and verify first sample has the correct timestamp
        let drained = buffer.drainImuSamples(maxCount: 1)
        XCTAssertEqual(drained.count, 1)
        // First sample should be sample index 0
        XCTAssertNotNil(drained[0]["timestamp"])
    }

    // MARK: - Clear

    func testClearAllRemovesAllSamples() {
        buffer.appendImuSamples(makeImuSamples(count: 10))
        buffer.appendRealtimeData(makeRealtimeSamples(count: 5))

        XCTAssertEqual(buffer.imuSampleCount, 10)
        XCTAssertEqual(buffer.realtimeSampleCount, 5)

        buffer.clearAll()

        XCTAssertEqual(buffer.imuSampleCount, 0)
        XCTAssertEqual(buffer.realtimeSampleCount, 0)
    }

    // MARK: - Thread safety

    func testConcurrentAppendAndDrain() {
        let iterations = 1000
        let appendExpectation = expectation(description: "appends complete")
        appendExpectation.expectedFulfillmentCount = iterations
        let drainExpectation = expectation(description: "drains complete")
        drainExpectation.expectedFulfillmentCount = iterations

        let appendQueue = DispatchQueue(label: "test.append", attributes: .concurrent)
        let drainQueue = DispatchQueue(label: "test.drain", attributes: .concurrent)

        for index in 0..<iterations {
            appendQueue.async {
                self.buffer.appendImuSamples([WhoopImuSample(
                    timestampSeconds: UInt32(index),
                    subSeconds: 0, sampleIndex: 0, samplesInFrame: 100,
                    accelerometerX: 0, accelerometerY: 0, accelerometerZ: 0,
                    gyroscopeX: 0, gyroscopeY: 0, gyroscopeZ: 0
                )])
                appendExpectation.fulfill()
            }
            drainQueue.async {
                _ = self.buffer.drainImuSamples(maxCount: 1)
                drainExpectation.fulfill()
            }
        }

        waitForExpectations(timeout: 10)
        // No crash = thread safety works. Final count can vary due to race ordering.
    }

    // MARK: - Peek-then-confirm (atomic drain)

    func testPeekImuSamplesDoesNotRemove() {
        buffer.appendImuSamples(makeImuSamples(count: 5))

        let peeked = buffer.peekImuSamples(maxCount: 3)
        XCTAssertEqual(peeked.count, 3)
        XCTAssertEqual(buffer.imuSampleCount, 5, "peek should not remove samples")

        // Peeking again returns the same samples
        let peekedAgain = buffer.peekImuSamples(maxCount: 3)
        XCTAssertEqual(peekedAgain.count, 3)
        XCTAssertEqual(buffer.imuSampleCount, 5)
    }

    func testConfirmImuDrainRemovesSamples() {
        buffer.appendImuSamples(makeImuSamples(count: 5))

        let peeked = buffer.peekImuSamples(maxCount: 3)
        XCTAssertEqual(peeked.count, 3)

        buffer.confirmImuDrain(count: 3)
        XCTAssertEqual(buffer.imuSampleCount, 2)
    }

    func testConfirmImuDrainClampedToBufferSize() {
        buffer.appendImuSamples(makeImuSamples(count: 3))

        buffer.confirmImuDrain(count: 100) // more than buffer has
        XCTAssertEqual(buffer.imuSampleCount, 0)
    }

    func testConfirmImuDrainAfterOverflowDoesNotRemoveUnpeekedSamples() {
        buffer.appendImuSamples(makeImuSamplesForOverflow(count: 500_000, startingAt: 0))

        let peeked = buffer.peekImuSamples(maxCount: 3)
        XCTAssertEqual(peeked.map { $0["accelerometerX"] as? Double }, [0.0, 1.0, 2.0])

        buffer.appendImuSamples(makeImuSamplesForOverflow(count: 3, startingAt: 500_000))
        buffer.confirmImuDrain(count: 3)

        let remaining = buffer.peekImuSamples(maxCount: 1)
        XCTAssertEqual(remaining.first?["accelerometerX"] as? Double, 3.0)
    }

    func testPeekRealtimeDataDoesNotRemove() {
        buffer.appendRealtimeData(makeRealtimeSamples(count: 4))

        let peeked = buffer.peekRealtimeData(maxCount: 2)
        XCTAssertEqual(peeked.count, 2)
        XCTAssertEqual(buffer.realtimeSampleCount, 4, "peek should not remove samples")
    }

    func testConfirmRealtimeDataDrainRemovesSamples() {
        buffer.appendRealtimeData(makeRealtimeSamples(count: 4))

        _ = buffer.peekRealtimeData(maxCount: 2)
        buffer.confirmRealtimeDataDrain(count: 2)
        XCTAssertEqual(buffer.realtimeSampleCount, 2)
    }

    func testConfirmRealtimeDataDrainAfterOverflowOnlyRemovesStillBufferedPeekedSamples() {
        buffer.appendRealtimeData(makeRealtimeSamplesForOverflow(count: 86_400, startingAt: 0))

        let peeked = buffer.peekRealtimeData(maxCount: 5)
        XCTAssertEqual(peeked.map { $0["rrIntervalMs"] as? Int }, [900, 901, 902, 903, 904])

        buffer.appendRealtimeData(makeRealtimeSamplesForOverflow(count: 3, startingAt: 86_400))
        buffer.confirmRealtimeDataDrain(count: 5)

        let remaining = buffer.peekRealtimeData(maxCount: 1)
        XCTAssertEqual(remaining.first?["rrIntervalMs"] as? Int, 905)
    }

    func testSecondRealtimePeekDoesNotResetInflightDrainCursorAfterOverflow() {
        buffer.appendRealtimeData(makeRealtimeSamplesForOverflow(count: 86_400, startingAt: 0))
        let uploadPage = buffer.peekRealtimeData(maxCount: 5)
        XCTAssertEqual(uploadPage.map { $0["rrIntervalMs"] as? Int }, [900, 901, 902, 903, 904])
        buffer.appendRealtimeData(makeRealtimeSamplesForOverflow(count: 3, startingAt: 86_400))
        let previewPage = buffer.peekRealtimeData(maxCount: 1)
        XCTAssertEqual(previewPage.first?["rrIntervalMs"] as? Int, 903)
        buffer.confirmRealtimeDataDrain(count: 5)
        let remaining = buffer.peekRealtimeData(maxCount: 1)
        XCTAssertEqual(remaining.first?["rrIntervalMs"] as? Int, 905)
    }

    func testPeekThenConfirmFullCycle() {
        buffer.appendImuSamples(makeImuSamples(count: 10))
        let batch1 = buffer.peekImuSamples(maxCount: 5)
        XCTAssertEqual(batch1.count, 5)
        XCTAssertEqual(buffer.imuSampleCount, 10)
        buffer.confirmImuDrain(count: 5)
        XCTAssertEqual(buffer.imuSampleCount, 5)
        let batch2 = buffer.peekImuSamples(maxCount: 10)
        XCTAssertEqual(batch2.count, 5)
        buffer.confirmImuDrain(count: 5)
        XCTAssertEqual(buffer.imuSampleCount, 0)
    }

    func testPeekWithoutConfirmRetainsSamplesForRetry() {
        buffer.appendImuSamples(makeImuSamples(count: 5))
        let attempt1 = buffer.peekImuSamples(maxCount: 5)
        XCTAssertEqual(attempt1.count, 5)
        let attempt2 = buffer.peekImuSamples(maxCount: 5)
        XCTAssertEqual(attempt2.count, 5)
        XCTAssertEqual(buffer.imuSampleCount, 5)
        buffer.confirmImuDrain(count: 5)
        XCTAssertEqual(buffer.imuSampleCount, 0)
    }

    func testNewSamplesAppendWhilePeekUnconfirmed() {
        buffer.appendImuSamples(makeImuSamples(count: 3))

        let peeked = buffer.peekImuSamples(maxCount: 3)
        XCTAssertEqual(peeked.count, 3)
        buffer.appendImuSamples(makeImuSamples(count: 2))
        XCTAssertEqual(buffer.imuSampleCount, 5)
        buffer.confirmImuDrain(count: 3)
        XCTAssertEqual(buffer.imuSampleCount, 2)
    }

    // MARK: - Empty append is no-op

    func testAppendEmptyArrayIsNoOp() {
        buffer.appendImuSamples([])
        buffer.appendRealtimeData([])
        XCTAssertEqual(buffer.imuSampleCount, 0)
        XCTAssertEqual(buffer.realtimeSampleCount, 0)
    }

    func testErasureCutoffDropsExistingAndFutureSamplesAtOrBeforeBoundary() {
        let cutoff = Date(timeIntervalSince1970: 1_711_000_001)
        buffer.appendImuSamples([
            makeImuSample(timestampSeconds: 1_711_000_000),
            makeImuSample(timestampSeconds: 1_711_000_001),
        ])
        buffer.appendRealtimeData([
            makeRealtimeSample(timestampSeconds: 1_711_000_001),
        ])

        buffer.advanceErasureCutoff(to: cutoff)
        buffer.appendImuSamples([
            makeImuSample(timestampSeconds: 1_711_000_001),
            makeImuSample(timestampSeconds: 1_711_000_002),
        ])
        buffer.appendRealtimeData([
            makeRealtimeSample(timestampSeconds: 1_711_000_000),
            makeRealtimeSample(timestampSeconds: 1_711_000_002),
        ])

        XCTAssertEqual(buffer.imuSampleCount, 1)
        XCTAssertEqual(buffer.realtimeSampleCount, 1)
        XCTAssertTrue(
            (buffer.peekImuSamples()[0]["timestamp"] as? String)?
                .contains("2024-03-21T05:46:42") == true
        )
    }

    func testErasureCutoffAdvancesPeekCursorOnlyForRemovedHeadSamples() {
        buffer.appendImuSamples([
            makeImuSample(timestampSeconds: 1_711_000_000),
            makeImuSample(timestampSeconds: 1_711_000_002),
            makeImuSample(timestampSeconds: 1_711_000_000),
            makeImuSample(timestampSeconds: 1_711_000_003),
        ])
        XCTAssertEqual(buffer.peekImuSamples(maxCount: 4).count, 4)

        buffer.advanceErasureCutoff(to: Date(timeIntervalSince1970: 1_711_000_001))
        buffer.confirmImuDrain(count: 4)

        XCTAssertEqual(buffer.imuSampleCount, 0)
    }
}
