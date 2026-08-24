import CoreBluetooth
import XCTest
@testable import BleHeartRateLib

final class BleHeartRateConnectionManagerTests: XCTestCase {
    func testDisconnectRemovesOnlyItsPendingSessionAndPreservesOtherSessionRouting() {
        let central = FakeCentralManager(state: .unknown)
        let manager = BleHeartRateConnectionManager { _, _ in central }
        let delegate = ConnectionDelegate()
        manager.delegate = delegate
        let firstId = "00000000-0000-0000-0000-000000000021"
        let secondId = "00000000-0000-0000-0000-000000000022"
        let firstConnecting = expectation(description: "first session starts connecting")
        let secondConnecting = expectation(description: "second session starts connecting")
        delegate.onStateChange = { id, state in
            if id == firstId, state == .connecting {
                firstConnecting.fulfill()
            }
            if id == secondId, state == .connecting {
                secondConnecting.fulfill()
            }
        }
        var firstResult: Result<BleHeartRateDevice, BleHeartRateConnectionError>?
        var secondResult: Result<BleHeartRateDevice, BleHeartRateConnectionError>?

        manager.connect(peripheralId: firstId) { firstResult = $0 }
        manager.connect(peripheralId: secondId) { secondResult = $0 }
        wait(for: [firstConnecting, secondConnecting], timeout: 1)

        manager.disconnect(peripheralId: firstId)
        manager.bleQueue.sync {}

        XCTAssertEqual(delegate.states[firstId], [.connecting, .idle])
        XCTAssertEqual(delegate.states[secondId], [.connecting])
        XCTAssertEqual(delegate.disconnectedIds, [firstId])
        guard case .failure(.disconnected) = firstResult else {
            return XCTFail("Expected only the disconnected session to fail")
        }
        XCTAssertNil(secondResult)

        manager.disconnect(peripheralId: secondId)
        manager.bleQueue.sync {}

        XCTAssertEqual(delegate.states[secondId], [.connecting, .idle])
        XCTAssertEqual(delegate.disconnectedIds, [firstId, secondId])
        guard case .failure(.disconnected) = secondResult else {
            return XCTFail("Expected the remaining session to disconnect independently")
        }
    }

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

private final class FakeCentralManager: BleHeartRateCentralManaging {
    var state: CBManagerState

    init(state: CBManagerState) {
        self.state = state
    }

    func scanForPeripherals(withServices _: [CBUUID]?, options _: [String: Any]?) {}
    func stopScan() {}
    func retrievePeripherals(withIdentifiers _: [UUID]) -> [CBPeripheral] { [] }
    func connect(_: CBPeripheral, options _: [String: Any]?) {}
    func cancelPeripheralConnection(_: CBPeripheral) {}
}

private final class ConnectionDelegate: BleHeartRateConnectionManagerDelegate {
    var states: [String: [BleHeartRateConnectionState]] = [:]
    var disconnectedIds: [String] = []
    var onStateChange: ((String, BleHeartRateConnectionState) -> Void)?

    func connectionManager(
        _: BleHeartRateConnectionManager,
        didChangeState state: BleHeartRateConnectionState,
        for peripheralId: String
    ) {
        states[peripheralId, default: []].append(state)
        onStateChange?(peripheralId, state)
    }

    func connectionManagerDidDisconnect(
        _: BleHeartRateConnectionManager,
        peripheralId: String,
        error _: Error?
    ) {
        disconnectedIds.append(peripheralId)
    }

    func connectionManager(
        _: BleHeartRateConnectionManager,
        didReceiveMeasurement _: BleHeartRateMeasurement,
        from _: String,
        at _: Date
    ) {}
}
