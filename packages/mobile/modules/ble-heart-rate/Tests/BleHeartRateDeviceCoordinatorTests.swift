import Foundation
import XCTest
@testable import BleHeartRateLib

final class BleHeartRateDeviceCoordinatorTests: XCTestCase {
    func testDisconnectLifecycleForOneDeviceKeepsAnotherDeviceReady() throws {
        let registry = try BleHeartRateDeviceRegistry(defaults: makeDefaults())
        let readyId = "00000000-0000-0000-0000-000000000010"
        let disconnectedId = "00000000-0000-0000-0000-000000000011"
        try registry.register(BleHeartRateDevice(id: readyId, name: "Ready strap"))
        try registry.register(BleHeartRateDevice(id: disconnectedId, name: "Other strap"))
        let events = EventRecorder()
        let coordinator = makeCoordinator(
            manager: FakeConnectionManager(),
            registry: registry,
            sampleBuffer: BleHeartRateSampleBuffer(),
            events: events
        )
        let manager = BleHeartRateConnectionManager()

        coordinator.connectionManager(manager, didChangeState: .ready, for: readyId)
        coordinator.connectionManager(manager, didChangeState: .ready, for: disconnectedId)
        coordinator.connectionManager(manager, didChangeState: .idle, for: disconnectedId)

        XCTAssertEqual(registry.snapshot(id: readyId, bufferedSampleCount: 0)?.connectionState, "ready")
        XCTAssertEqual(registry.snapshot(id: disconnectedId, bufferedSampleCount: 0)?.connectionState, "idle")
        XCTAssertEqual(events.deviceStates[readyId], ["ready"])
        XCTAssertEqual(events.deviceStates[disconnectedId], ["ready", "idle"])
    }

    func testTimeoutLifecycleForOneDeviceKeepsAnotherDeviceReady() throws {
        let registry = try BleHeartRateDeviceRegistry(defaults: makeDefaults())
        let readyId = "00000000-0000-0000-0000-000000000012"
        let timedOutId = "00000000-0000-0000-0000-000000000013"
        try registry.register(BleHeartRateDevice(id: readyId, name: "Ready strap"))
        try registry.register(BleHeartRateDevice(id: timedOutId, name: "Timed-out strap"))
        let events = EventRecorder()
        let coordinator = makeCoordinator(
            manager: FakeConnectionManager(),
            registry: registry,
            sampleBuffer: BleHeartRateSampleBuffer(),
            events: events
        )
        let manager = BleHeartRateConnectionManager()

        coordinator.connectionManager(manager, didChangeState: .ready, for: readyId)
        coordinator.connectionManager(manager, didChangeState: .connecting, for: timedOutId)
        coordinator.connectionManager(manager, didChangeState: .idle, for: timedOutId)

        XCTAssertEqual(registry.snapshot(id: readyId, bufferedSampleCount: 0)?.connectionState, "ready")
        XCTAssertEqual(registry.snapshot(id: timedOutId, bufferedSampleCount: 0)?.connectionState, "idle")
        XCTAssertEqual(events.deviceStates[readyId], ["ready"])
        XCTAssertEqual(events.deviceStates[timedOutId], ["connecting", "idle"])
    }

    func testAccountPurgeWaitsForSerializedBleBoundaryAndRejectsRacingMeasurements() throws {
        let registry = try BleHeartRateDeviceRegistry(defaults: makeDefaults())
        let deviceId = "00000000-0000-0000-0000-000000000014"
        try registry.register(BleHeartRateDevice(id: deviceId, name: "Old-account strap"))
        let manager = FakeConnectionManager()
        let sampleBuffer = BleHeartRateSampleBuffer()
        let events = EventRecorder()
        let coordinator = makeCoordinator(
            manager: manager,
            registry: registry,
            sampleBuffer: sampleBuffer,
            events: events
        )
        let concreteManager = BleHeartRateConnectionManager()
        let cutoff = Date(timeIntervalSince1970: 2_000)
        coordinator.connectionManager(
            concreteManager,
            didReceiveMeasurement: BleHeartRateMeasurement(heartRateBpm: 60, rrIntervalsMs: []),
            from: deviceId,
            at: Date(timeIntervalSince1970: 2_001)
        )
        events.measurements.removeAll()
        var purgeResult: Result<Void, Error>?

        coordinator.purgeAccountState(cutoff: cutoff) { result in
            purgeResult = result
        }

        XCTAssertNil(purgeResult)
        XCTAssertEqual(sampleBuffer.sampleCount, 1)
        XCTAssertEqual(registry.devices.map(\.id), [deviceId])

        manager.afterPurgeWorkBeforeCompletion = {
            coordinator.connectionManager(
                concreteManager,
                didReceiveMeasurement: BleHeartRateMeasurement(heartRateBpm: 180, rrIntervalsMs: []),
                from: deviceId,
                at: Date(timeIntervalSince1970: 2_002)
            )
        }
        manager.completeAccountPurge()

        XCTAssertEqual(manager.lifecycleEvents, ["disconnect-all", "purge-work", "complete"])
        XCTAssertEqual(sampleBuffer.sampleCount, 0)
        XCTAssertTrue(registry.devices.isEmpty)
        XCTAssertNotNil(purgeResult)
        XCTAssertTrue(events.measurements.isEmpty)
    }

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
            onDeviceStateChanged: { snapshot in
                events.deviceStates[snapshot.id, default: []].append(snapshot.connectionState)
            },
            onHeartRateMeasurement: { sample in
                events.measurements.append(sample)
            },
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
        var deviceStates: [String: [String]] = [:]
        var measurements: [BleHeartRateSample] = []
    }
}

private final class FakeConnectionManager: BleHeartRateConnectionManaging {
    weak var delegate: BleHeartRateConnectionManagerDelegate?

    var scanResult: Result<BleHeartRateDevice, BleHeartRateConnectionError> = .failure(.scanTimeout)
    var connectResult: Result<BleHeartRateDevice, BleHeartRateConnectionError> = .failure(.connectTimeout)
    private(set) var connectCalls: [String] = []
    private(set) var disconnectCalls: [String] = []
    private(set) var lifecycleEvents: [String] = []
    var afterPurgeWorkBeforeCompletion: (() -> Void)?
    private var pendingPurgeWork: (() throws -> Void)?
    private var pendingPurgeCompletion: ((Result<Void, Error>) -> Void)?

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

    func performAccountPurge(
        work: @escaping () throws -> Void,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        pendingPurgeWork = work
        pendingPurgeCompletion = completion
    }

    func completeAccountPurge() {
        lifecycleEvents.append("disconnect-all")
        do {
            lifecycleEvents.append("purge-work")
            try pendingPurgeWork?()
            afterPurgeWorkBeforeCompletion?()
            lifecycleEvents.append("complete")
            pendingPurgeCompletion?(.success(()))
        } catch {
            lifecycleEvents.append("complete")
            pendingPurgeCompletion?(.failure(error))
        }
    }
}
