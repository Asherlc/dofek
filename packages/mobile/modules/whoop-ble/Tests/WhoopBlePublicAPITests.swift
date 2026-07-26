import Foundation
import XCTest
import WhoopBLE

final class WhoopBlePublicAPITests: XCTestCase {
    func testNativeConsumerCanConstructDomainValues() {
        let deviceId = UUID()
        let device = WhoopDevice(id: deviceId, name: "WHOOP")
        let realtimeSample = WhoopRealtimeDataSample(
            timestampSeconds: 1_700_000_000,
            subSeconds: 250,
            heartRate: 60,
            rrIntervalMs: 1_000,
            quaternionW: 1,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
            opticalBytes: Data([0x01, 0x02])
        )
        let imuSample = WhoopImuSample(
            timestampSeconds: 1_700_000_000,
            subSeconds: 250,
            sampleIndex: 0,
            samplesInFrame: 1,
            accelerometerX: 0,
            accelerometerY: 0,
            accelerometerZ: 1,
            gyroscopeX: 0,
            gyroscopeY: 0,
            gyroscopeZ: 0
        )

        XCTAssertEqual(device.id, deviceId)
        XCTAssertEqual(device.name, "WHOOP")
        XCTAssertEqual(realtimeSample.rrIntervalMs, 1_000)
        XCTAssertEqual(imuSample.accelerometerZ, 1)
    }

    func testNativeConsumerCanConstructClientAndSampleStreams() {
        let client = WhoopBleClient()
        let discover: () async -> WhoopDevice? = client.discover
        let connect: (WhoopDevice) async throws -> Void = client.connect(to:)
        let startRealtime: () async throws -> Void = client.startRealtimeStreaming
        let startImu: () async throws -> Void = client.startImuStreaming
        let stop: () async -> Void = client.stopStreaming

        XCTAssertEqual(client.state, .idle)
        _ = \WhoopBleClient.bluetoothState
        _ = \WhoopBleClient.isBluetoothAvailable
        _ = client.realtimeSamples()
        _ = client.imuSamples()
        _ = discover
        _ = connect
        _ = startRealtime
        _ = startImu
        _ = stop
    }

    func testPublicErrorsExplainFailureAndRecovery() {
        let error = WhoopBleError.notReady(state: .connecting)

        XCTAssertEqual(
            error.errorDescription,
            "The WHOOP strap is not ready to stream (current state: connecting)."
        )
        XCTAssertEqual(
            error.recoverySuggestion,
            "Wait for the connection to become ready, then start streaming again."
        )
    }
}
