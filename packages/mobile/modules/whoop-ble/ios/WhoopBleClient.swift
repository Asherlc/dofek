import CoreBluetooth
import Foundation

/// A WHOOP strap discovered over Bluetooth.
public struct WhoopDevice: Hashable, Sendable {
    public let id: UUID
    public let name: String?

    public init(id: UUID, name: String?) {
        self.id = id
        self.name = name
    }
}

/// The current WHOOP connection lifecycle state.
public enum WhoopBleClientState: String, Sendable {
    case idle
    case scanning
    case connecting
    case discoveringServices
    case subscribing
    case ready
    case streaming

    init(_ state: ConnectionState) {
        switch state {
        case .idle:
            self = .idle
        case .scanning:
            self = .scanning
        case .connecting:
            self = .connecting
        case .discoveringServices:
            self = .discoveringServices
        case .subscribing:
            self = .subscribing
        case .ready:
            self = .ready
        case .streaming:
            self = .streaming
        }
    }
}

/// Errors reported by the native WHOOP BLE client.
public enum WhoopBleError: Error, LocalizedError, Sendable {
    case bluetoothUnavailable(state: String)
    case deviceNotFound(id: UUID)
    case connectionTimedOut
    case serviceDiscoveryFailed(String)
    case characteristicDiscoveryFailed(String)
    case serviceNotFound
    case characteristicsNotFound
    case notificationSubscriptionFailed(String)
    case disconnected(String?)
    case notReady(state: WhoopBleClientState)
    case connectionFailed(String)

    public var errorDescription: String? {
        switch self {
        case .bluetoothUnavailable(let state):
            "Bluetooth is not available (current state: \(state))."
        case .deviceNotFound(let id):
            "The WHOOP strap \(id.uuidString) is no longer available."
        case .connectionTimedOut:
            "The WHOOP strap connection timed out."
        case .serviceDiscoveryFailed(let detail):
            "WHOOP service discovery failed: \(detail)"
        case .characteristicDiscoveryFailed(let detail):
            "WHOOP characteristic discovery failed: \(detail)"
        case .serviceNotFound:
            "The connected device does not expose a supported WHOOP service."
        case .characteristicsNotFound:
            "The WHOOP strap is missing required command or data characteristics."
        case .notificationSubscriptionFailed(let detail):
            "WHOOP notification subscription failed: \(detail)"
        case .disconnected(let detail):
            detail.map { "The WHOOP strap disconnected: \($0)" }
                ?? "The WHOOP strap disconnected."
        case .notReady(let state):
            "The WHOOP strap is not ready to stream (current state: \(state.rawValue))."
        case .connectionFailed(let detail):
            "The WHOOP strap connection failed: \(detail)"
        }
    }

    public var recoverySuggestion: String? {
        switch self {
        case .bluetoothUnavailable:
            "Turn on Bluetooth and grant this app Bluetooth access, then try again."
        case .deviceNotFound:
            "Keep the strap nearby and connected to your iPhone, discover it again, then reconnect."
        case .connectionTimedOut, .disconnected, .connectionFailed:
            "Keep the strap nearby, verify Bluetooth is on, then reconnect."
        case .serviceDiscoveryFailed, .characteristicDiscoveryFailed:
            "Disconnect the strap, reconnect it, and try again."
        case .serviceNotFound, .characteristicsNotFound:
            "Verify that the selected device is a supported WHOOP strap and its firmware is current."
        case .notificationSubscriptionFailed:
            "Disconnect the strap, reconnect it, and start streaming again."
        case .notReady:
            "Wait for the connection to become ready, then start streaming again."
        }
    }
}

/// Native Swift interface to the reverse-engineered WHOOP BLE protocol.
///
/// Subscribe to the sample streams before starting the corresponding stream so
/// no samples are missed.
public final class WhoopBleClient: @unchecked Sendable {
    private let connectionManager: WhoopBleConnectionManager
    private let frameParser = WhoopBleFrameParser()
    private let commandFrameParser = WhoopBleFrameParser()
    private lazy var watchdog = WhoopBleDataWatchdog(queue: connectionManager.bleQueue)

    private var realtimeContinuations:
        [UUID: AsyncStream<WhoopRealtimeDataSample>.Continuation] = [:]
    private var imuContinuations:
        [UUID: AsyncStream<WhoopImuSample>.Continuation] = [:]
    private var isRealtimeStreaming = false
    private var isImuStreaming = false

    public init() {
        connectionManager = WhoopBleConnectionManager()
        connectionManager.delegate = self
        watchdog.delegate = self
    }

    deinit {
        connectionManager.syncOnBleQueue {
            watchdog.stop()
            realtimeContinuations.values.forEach { $0.finish() }
            imuContinuations.values.forEach { $0.finish() }
        }
    }

    public var state: WhoopBleClientState {
        connectionManager.syncOnBleQueue {
            WhoopBleClientState(connectionManager.state)
        }
    }

    public var bluetoothState: String {
        connectionManager.syncOnBleQueue {
            connectionManager.bluetoothState
        }
    }

    public var isBluetoothAvailable: Bool {
        connectionManager.syncOnBleQueue {
            connectionManager.isBluetoothAvailable
        }
    }

    /// Finds a connected or nearby WHOOP strap.
    public func discover() async -> WhoopDevice? {
        await withCheckedContinuation { continuation in
            connectionManager.findWhoop { result in
                guard
                    let identifier = result?["id"] as? String,
                    let id = UUID(uuidString: identifier)
                else {
                    continuation.resume(returning: nil)
                    return
                }

                continuation.resume(returning: WhoopDevice(
                    id: id,
                    name: result?["name"] as? String
                ))
            }
        }
    }

    /// Connects to a device returned by ``discover()``.
    public func connect(to device: WhoopDevice) async throws {
        try await withCheckedThrowingContinuation { continuation in
            connectionManager.connect(peripheralId: device.id.uuidString) { result in
                switch result {
                case .success:
                    continuation.resume()
                case .failure(let error):
                    continuation.resume(throwing: Self.publicError(from: error))
                }
            }
        }
    }

    /// Disconnects and disables automatic reconnection.
    public func disconnect() {
        connectionManager.syncOnBleQueue {
            isRealtimeStreaming = false
            isImuStreaming = false
            watchdog.stop()
            frameParser.reset()
            commandFrameParser.reset()
        }
        connectionManager.disconnect()
    }

    /// Returns a stream of parsed realtime heart-beat, orientation, and optical samples.
    public func realtimeSamples() -> AsyncStream<WhoopRealtimeDataSample> {
        let id = UUID()
        return AsyncStream { [weak self] continuation in
            guard let self else {
                continuation.finish()
                return
            }
            continuation.onTermination = { [weak self] _ in
                self?.connectionManager.bleQueue.async { [weak self] in
                    self?.realtimeContinuations.removeValue(forKey: id)
                }
            }
            connectionManager.syncOnBleQueue {
                self.realtimeContinuations[id] = continuation
            }
        }
    }

    /// Returns a stream of parsed accelerometer and gyroscope samples.
    public func imuSamples() -> AsyncStream<WhoopImuSample> {
        let id = UUID()
        return AsyncStream { [weak self] continuation in
            guard let self else {
                continuation.finish()
                return
            }
            continuation.onTermination = { [weak self] _ in
                self?.connectionManager.bleQueue.async { [weak self] in
                    self?.imuContinuations.removeValue(forKey: id)
                }
            }
            connectionManager.syncOnBleQueue {
                self.imuContinuations[id] = continuation
            }
        }
    }

    /// Starts WHOOP realtime heart-beat, orientation, and optical notifications.
    public func startRealtimeStreaming() async throws {
        try await performOnBleQueue { [self] in
            guard self.connectionManager.cmdCharacteristic != nil else {
                throw WhoopBleError.notReady(
                    state: WhoopBleClientState(self.connectionManager.state)
                )
            }
            guard !self.isRealtimeStreaming else { return }

            self.sendActivationCommands(includeImu: false)
            self.isRealtimeStreaming = true
            self.watchdog.start()
        }
    }

    /// Starts WHOOP accelerometer and gyroscope notifications.
    public func startImuStreaming() async throws {
        try await performOnBleQueue { [self] in
            guard self.connectionManager.cmdCharacteristic != nil else {
                throw WhoopBleError.notReady(
                    state: WhoopBleClientState(self.connectionManager.state)
                )
            }
            guard !self.isImuStreaming else { return }
            guard self.connectionManager.startStreaming() else {
                throw WhoopBleError.notReady(
                    state: WhoopBleClientState(self.connectionManager.state)
                )
            }

            if !self.isRealtimeStreaming {
                self.sendActivationCommands(includeImu: false)
                self.isRealtimeStreaming = true
            }
            self.connectionManager.writeToStrap(
                WhoopBleFrameParser.buildCommandData(
                    command: WhoopBleConstants.commandToggleImuMode
                )
            )
            self.isImuStreaming = true
            self.frameParser.reset()
            self.commandFrameParser.reset()
            self.watchdog.start()
        }
    }

    /// Stops active realtime and IMU streams while keeping the strap connected.
    public func stopStreaming() async {
        await withCheckedContinuation { continuation in
            connectionManager.bleQueue.async { [self] in
                if connectionManager.cmdCharacteristic != nil {
                    if isImuStreaming {
                        connectionManager.writeToStrap(
                            WhoopBleFrameParser.buildCommandData(
                                command: WhoopBleConstants.commandStopRawData
                            )
                        )
                    }
                    if isRealtimeStreaming {
                        connectionManager.writeToStrap(
                            WhoopBleFrameParser.buildCommandData(
                                command: WhoopBleConstants.commandToggleRealtimeHr
                            )
                        )
                        connectionManager.writeToStrap(
                            WhoopBleFrameParser.buildCommandData(
                                command: WhoopBleConstants.commandToggleOpticalMode
                            )
                        )
                    }
                }

                isRealtimeStreaming = false
                isImuStreaming = false
                connectionManager.stopStreaming()
                watchdog.stop()
                frameParser.reset()
                commandFrameParser.reset()
                continuation.resume()
            }
        }
    }

    private func performOnBleQueue(
        _ operation: @escaping @Sendable () throws -> Void
    ) async throws {
        try await withCheckedThrowingContinuation { continuation in
            connectionManager.bleQueue.async {
                do {
                    try operation()
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func sendActivationCommands(includeImu: Bool) {
        connectionManager.writeToStrap(
            WhoopBleFrameParser.buildCommandData(
                command: WhoopBleConstants.commandToggleRealtimeHr
            )
        )
        connectionManager.writeToStrap(
            WhoopBleFrameParser.buildCommandData(
                command: WhoopBleConstants.commandToggleOpticalMode
            )
        )
        connectionManager.writeToStrap(
            WhoopBleFrameParser.buildCommandData(
                command: WhoopBleConstants.commandSendR10R11Realtime
            )
        )
        if includeImu {
            connectionManager.writeToStrap(
                WhoopBleFrameParser.buildCommandData(
                    command: WhoopBleConstants.commandToggleImuMode
                )
            )
        }
    }

    private static func publicError(from error: WhoopBleConnectionError) -> WhoopBleError {
        switch error {
        case .invalidPeripheralId(let identifier):
            .connectionFailed("The device identifier \(identifier) is invalid.")
        case .peripheralNotFound(let identifier):
            UUID(uuidString: identifier).map { .deviceNotFound(id: $0) }
                ?? .connectionFailed("The device identifier \(identifier) is invalid.")
        case .timeout:
            .connectionTimedOut
        case .serviceDiscoveryFailed(let detail):
            .serviceDiscoveryFailed(detail)
        case .characteristicDiscoveryFailed(let detail):
            .characteristicDiscoveryFailed(detail)
        case .serviceNotFound:
            .serviceNotFound
        case .characteristicsNotFound:
            .characteristicsNotFound
        case .notificationSubscriptionFailed(let detail):
            .notificationSubscriptionFailed(detail)
        case .disconnected(let detail):
            .disconnected(detail)
        }
    }
}

extension WhoopBleClient: WhoopBleConnectionManagerDelegate {
    func connectionManagerDidBecomeReady(
        _ manager: WhoopBleConnectionManager,
        peripheral _: CBPeripheral,
        cmdCharacteristic _: CBCharacteristic,
        wasStreaming: Bool
    ) {
        if wasStreaming || isImuStreaming {
            sendActivationCommands(includeImu: true)
            _ = manager.startStreaming()
            isRealtimeStreaming = true
            isImuStreaming = true
            watchdog.start()
        } else if isRealtimeStreaming {
            sendActivationCommands(includeImu: false)
            watchdog.start()
        }
    }

    func connectionManagerDidDisconnect(
        _: WhoopBleConnectionManager,
        peripheralId _: String,
        error _: Error?
    ) {
        watchdog.stop()
        frameParser.reset()
        commandFrameParser.reset()
    }

    func connectionManager(
        _: WhoopBleConnectionManager,
        didReceiveData data: Data
    ) {
        watchdog.recordDataReceived()

        for frame in frameParser.feed(data) {
            if isImuStreaming {
                for sample in WhoopBleFrameParser.extractImuSamples(from: frame) {
                    for continuation in imuContinuations.values {
                        continuation.yield(sample)
                    }
                }
            }

            if isRealtimeStreaming,
               let sample = WhoopBleFrameParser.extractRealtimeData(from: frame) {
                for continuation in realtimeContinuations.values {
                    continuation.yield(sample)
                }
            }
        }
    }

    func connectionManager(
        _: WhoopBleConnectionManager,
        didReceiveCommandResponse data: Data
    ) {
        _ = commandFrameParser.feed(data)
    }
}

extension WhoopBleClient: WhoopBleDataWatchdogDelegate {
    func watchdogDidDetectSilence(_: WhoopBleDataWatchdog, retryCount _: UInt64) {
        guard connectionManager.cmdCharacteristic != nil else {
            watchdog.stop()
            return
        }
        sendActivationCommands(includeImu: isImuStreaming)
    }
}
