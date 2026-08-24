import Foundation
import XCTest
@testable import BleHeartRateLib

final class BleHeartRateDeviceCoordinatorTests: XCTestCase {
    func testConnectPreservesInvalidIdentifierErrorBeforeRegistryAdmission() throws {
        let registry = try BleHeartRateDeviceRegistry(defaults: makeDefaults())
        let manager = FakeConnectionManager()
        let coordinator = makeCoordinator(
            manager: manager,
            registry: registry,
            sampleBuffer: BleHeartRateSampleBuffer(),
            events: EventRecorder()
        )

        var receivedError: BleHeartRateDeviceCoordinatorError?
        coordinator.connect(peripheralId: "not-a-uuid") { result in
            if case .failure(let error) = result {
                receivedError = error
            }
        }

        guard case .connection(.invalidPeripheralId(let rejectedId)) = receivedError else {
            return XCTFail("Expected the existing invalid-ID error")
        }
        XCTAssertEqual(rejectedId, "not-a-uuid")
        XCTAssertTrue(manager.connectCalls.isEmpty)
    }

    func testConnectRejectsForgottenDeviceBeforeManagerCreatesSession() throws {
        let registry = try BleHeartRateDeviceRegistry(defaults: makeDefaults())
        let forgottenId = "00000000-0000-0000-0000-000000000001"
        try registry.register(BleHeartRateDevice(id: forgottenId, name: "Forgotten strap"))
        try registry.remove(id: forgottenId)
        let manager = FakeConnectionManager()
        manager.connectResult = .success(BleHeartRateDevice(id: forgottenId, name: "Forgotten strap"))
        let sampleBuffer = BleHeartRateSampleBuffer()
        let events = EventRecorder()
        let coordinator = makeCoordinator(
            manager: manager,
            registry: registry,
            sampleBuffer: sampleBuffer,
            events: events
        )

        var receivedError: BleHeartRateDeviceCoordinatorError?
        coordinator.connect(peripheralId: forgottenId) { result in
            if case .failure(let error) = result {
                receivedError = error
            }
        }

        guard case .unmanagedDevice(let rejectedId) = receivedError else {
            return XCTFail("Expected an unmanaged-device error")
        }
        XCTAssertEqual(rejectedId, forgottenId)
        XCTAssertTrue(manager.connectCalls.isEmpty)
        XCTAssertEqual(sampleBuffer.sampleCount, 0)
        XCTAssertTrue(events.connectedDeviceIds.isEmpty)
    }

    func testScanPersistenceFailureDisconnectsWithoutConnectedEvent() throws {
        let codec = BleHeartRateDeviceRegistryCodec(
            decode: { data in
                try JSONDecoder().decode([BleHeartRateRegisteredDevice].self, from: data)
            },
            encode: { _ in throw TestPersistenceError.encodingFailed }
        )
        let registry = try BleHeartRateDeviceRegistry(defaults: makeDefaults(), codec: codec)
        let manager = FakeConnectionManager()
        let scannedDevice = BleHeartRateDevice(
            id: "00000000-0000-0000-0000-000000000002",
            name: "Unpersisted strap"
        )
        manager.scanResult = .success(scannedDevice)
        let sampleBuffer = BleHeartRateSampleBuffer()
        let events = EventRecorder()
        let coordinator = makeCoordinator(
            manager: manager,
            registry: registry,
            sampleBuffer: sampleBuffer,
            events: events
        )

        var receivedError: BleHeartRateDeviceCoordinatorError?
        coordinator.scanAndConnect { result in
            if case .failure(let error) = result {
                receivedError = error
            }
        }

        guard case .registry(let error) = receivedError else {
            return XCTFail("Expected a registry-persistence error")
        }
        XCTAssertEqual(error as? BleHeartRateDeviceRegistryError, .encodeFailed)
        XCTAssertEqual(manager.disconnectCalls, [scannedDevice.id])
        XCTAssertTrue(registry.devices.isEmpty)
        XCTAssertEqual(sampleBuffer.sampleCount, 0)
        XCTAssertTrue(events.connectedDeviceIds.isEmpty)
    }

    private func makeCoordinator(
        manager: FakeConnectionManager,
        registry: BleHeartRateDeviceRegistry,
        sampleBuffer: BleHeartRateSampleBuffer,
        events: EventRecorder
    ) -> BleHeartRateDeviceCoordinator {
        BleHeartRateDeviceCoordinator(
            connectionManager: manager,
            deviceRegistry: registry,
            sampleBuffer: sampleBuffer,
            onConnectionEvent: { event in
                if case .connected(let device) = event {
                    events.connectedDeviceIds.append(device.id)
                }
            },
            onDeviceStateChanged: { _ in },
            onHeartRateMeasurement: { _ in },
            onRegistryError: { _, _ in }
        )
    }

    private func makeDefaults() -> UserDefaults {
        let suiteName = "BleHeartRateDeviceCoordinatorTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }

    private enum TestPersistenceError: Error {
        case encodingFailed
    }

    private final class EventRecorder {
        var connectedDeviceIds: [String] = []
    }
}

private final class FakeConnectionManager: BleHeartRateConnectionManaging {
    weak var delegate: BleHeartRateConnectionManagerDelegate?

    var scanResult: Result<BleHeartRateDevice, BleHeartRateConnectionError> = .failure(.scanTimeout)
    var connectResult: Result<BleHeartRateDevice, BleHeartRateConnectionError> = .failure(.connectTimeout)
    private(set) var connectCalls: [String] = []
    private(set) var disconnectCalls: [String] = []

    func scanAndConnect(
        completion: @escaping (Result<BleHeartRateDevice, BleHeartRateConnectionError>) -> Void
    ) {
        completion(scanResult)
    }

    func connect(
        peripheralId: String,
        completion: @escaping (Result<BleHeartRateDevice, BleHeartRateConnectionError>) -> Void
    ) {
        connectCalls.append(peripheralId)
        completion(connectResult)
    }

    func disconnect(peripheralId: String) {
        disconnectCalls.append(peripheralId)
    }

    func disconnectAll() {}
}
