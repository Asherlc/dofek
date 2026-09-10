import Foundation

protocol BleHeartRateConnectionManaging: AnyObject {
    var delegate: BleHeartRateConnectionManagerDelegate? { get set }

    func scanAndConnect(
        completion: @escaping (Result<BleHeartRateDevice, BleHeartRateConnectionError>) -> Void
    )
    func connect(
        peripheralId: String,
        completion: @escaping (Result<BleHeartRateDevice, BleHeartRateConnectionError>) -> Void
    )
    func disconnect(peripheralId: String)
    func disconnectAll()
    func performAccountPurge(
        work: @escaping () throws -> Void,
        completion: @escaping (Result<Void, Error>) -> Void
    )
}

extension BleHeartRateConnectionManager: BleHeartRateConnectionManaging {}

enum BleHeartRateDeviceCoordinatorError: Error {
    case connection(BleHeartRateConnectionError)
    case registry(Error)
    case unmanagedDevice(String)
}

enum BleHeartRateConnectionEvent {
    case connected(BleHeartRateDevice)
    case disconnected(peripheralId: String, error: Error?)
}

/// Enforces the app-managed-device boundary between Core Bluetooth and the
/// Expo bridge, and orders persistence before externally visible connection
/// events.
final class BleHeartRateDeviceCoordinator: BleHeartRateConnectionManagerDelegate {
    private let connectionManager: BleHeartRateConnectionManaging
    private let deviceRegistry: BleHeartRateDeviceRegistry
    private let sampleBuffer: BleHeartRateSampleBuffer
    private let onConnectionEvent: (BleHeartRateConnectionEvent) -> Void
    private let onDeviceStateChanged: (BleHeartRateDeviceSnapshot) -> Void
    private let onHeartRateMeasurement: (BleHeartRateSample) -> Void
    private let onRegistryError: (String, Error) -> Void
    private let measurementGateLock = NSLock()
    private var acceptsMeasurements = true

    init(
        connectionManager: BleHeartRateConnectionManaging,
        deviceRegistry: BleHeartRateDeviceRegistry,
        sampleBuffer: BleHeartRateSampleBuffer,
        onConnectionEvent: @escaping (BleHeartRateConnectionEvent) -> Void,
        onDeviceStateChanged: @escaping (BleHeartRateDeviceSnapshot) -> Void,
        onHeartRateMeasurement: @escaping (BleHeartRateSample) -> Void,
        onRegistryError: @escaping (String, Error) -> Void
    ) {
        self.connectionManager = connectionManager
        self.deviceRegistry = deviceRegistry
        self.sampleBuffer = sampleBuffer
        self.onConnectionEvent = onConnectionEvent
        self.onDeviceStateChanged = onDeviceStateChanged
        self.onHeartRateMeasurement = onHeartRateMeasurement
        self.onRegistryError = onRegistryError
        connectionManager.delegate = self
    }

    func scanAndConnect(
        completion: @escaping (Result<BleHeartRateDevice, BleHeartRateDeviceCoordinatorError>) -> Void
    ) {
        setAcceptsMeasurements(true)
        connectionManager.scanAndConnect { [self] result in
            switch result {
            case .success(let device):
                do {
                    try deviceRegistry.register(device)
                } catch {
                    connectionManager.disconnect(peripheralId: device.id)
                    completion(.failure(.registry(error)))
                    return
                }
                deviceRegistry.setConnectionState(
                    BleHeartRateConnectionState.ready.rawValue,
                    for: device.id
                )
                emitDeviceState(for: device.id)
                completion(.success(device))
                onConnectionEvent(.connected(device))
            case .failure(let error):
                completion(.failure(.connection(error)))
            }
        }
    }

    func connect(
        peripheralId: String,
        completion: @escaping (Result<BleHeartRateDevice, BleHeartRateDeviceCoordinatorError>) -> Void
    ) {
        guard UUID(uuidString: peripheralId) != nil else {
            completion(.failure(.connection(.invalidPeripheralId(peripheralId))))
            return
        }
        guard deviceRegistry.contains(id: peripheralId) else {
            completion(.failure(.unmanagedDevice(peripheralId)))
            return
        }
        setAcceptsMeasurements(true)
        connectionManager.connect(peripheralId: peripheralId) { [self] result in
            switch result {
            case .success(let device):
                completion(.success(device))
                onConnectionEvent(.connected(device))
            case .failure(let error):
                completion(.failure(.connection(error)))
            }
        }
    }

    func purgeAccountState(
        cutoff: Date,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        connectionManager.performAccountPurge(
            work: { [self] in
                setAcceptsMeasurements(false)
                sampleBuffer.clearAll()
                sampleBuffer.advanceErasureCutoff(to: cutoff)
                try deviceRegistry.clear()
            },
            completion: completion
        )
    }

    func connectionManager(
        _ manager: BleHeartRateConnectionManager,
        didChangeState state: BleHeartRateConnectionState,
        for peripheralId: String
    ) {
        deviceRegistry.setConnectionState(state.rawValue, for: peripheralId)
        emitDeviceState(for: peripheralId)
    }

    func connectionManagerDidDisconnect(
        _ manager: BleHeartRateConnectionManager,
        peripheralId: String,
        error: Error?
    ) {
        onConnectionEvent(.disconnected(peripheralId: peripheralId, error: error))
    }

    func connectionManager(
        _ manager: BleHeartRateConnectionManager,
        didReceiveMeasurement measurement: BleHeartRateMeasurement,
        from deviceId: String,
        at timestamp: Date
    ) {
        guard isAcceptingMeasurements else { return }
        guard deviceRegistry.contains(id: deviceId) else {
            connectionManager.disconnect(peripheralId: deviceId)
            return
        }

        let sample = BleHeartRateSample(
            deviceId: deviceId,
            timestamp: timestamp,
            heartRateBpm: measurement.heartRateBpm,
            rrIntervalsMs: measurement.rrIntervalsMs
        )
        sampleBuffer.append(sample)
        do {
            try deviceRegistry.recordMeasurement(
                deviceId: deviceId,
                heartRateBpm: measurement.heartRateBpm,
                rrIntervalsMs: measurement.rrIntervalsMs,
                at: timestamp
            )
        } catch {
            onRegistryError(deviceId, error)
            return
        }

        onHeartRateMeasurement(sample)
        emitDeviceState(for: deviceId)
    }

    private func emitDeviceState(for deviceId: String) {
        guard let snapshot = deviceRegistry.snapshot(
            id: deviceId,
            bufferedSampleCount: sampleBuffer.sampleCount(for: deviceId)
        ) else { return }
        onDeviceStateChanged(snapshot)
    }

    private var isAcceptingMeasurements: Bool {
        measurementGateLock.lock()
        defer { measurementGateLock.unlock() }
        return acceptsMeasurements
    }

    private func setAcceptsMeasurements(_ accepts: Bool) {
        measurementGateLock.lock()
        acceptsMeasurements = accepts
        measurementGateLock.unlock()
    }
}
