import XCTest
@testable import BleHeartRateLib

final class BleHeartRateConnectionManagerTests: XCTestCase {
    func testDisconnectCompletionFencesPreviouslyQueuedMeasurementCallback() {
        let manager = BleHeartRateConnectionManager()
        let buffer = BleHeartRateSampleBuffer()
        let callbackStarted = DispatchSemaphore(value: 0)
        let allowCallbackToFinish = DispatchSemaphore(value: 0)
        let disconnected = DispatchSemaphore(value: 0)

        manager.bleQueue.async {
            callbackStarted.signal()
            allowCallbackToFinish.wait()
            buffer.append(
                BleHeartRateSample(
                    deviceId: "prior-account-strap",
                    timestamp: Date(timeIntervalSince1970: 1_711_800_000),
                    heartRateBpm: 142,
                    rrIntervalsMs: [811]
                )
            )
        }
        XCTAssertEqual(callbackStarted.wait(timeout: .now() + 1), .success)

        manager.disconnect {
            buffer.clearAll()
            disconnected.signal()
        }

        XCTAssertEqual(disconnected.wait(timeout: .now() + 0.05), .timedOut)
        allowCallbackToFinish.signal()
        XCTAssertEqual(disconnected.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(buffer.sampleCount, 0)
    }
}
