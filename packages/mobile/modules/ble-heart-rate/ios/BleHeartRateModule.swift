import ExpoModulesCore
import Foundation

/// Expo native module that connects to a standard Bluetooth heart-rate monitor
/// (Heart Rate Service 0x180D) and streams beats-per-minute + R-R intervals.
///
/// It wires the connection manager and sample buffer together and exposes them
/// as Expo functions/events to the JS layer. Live measurements are emitted for
/// the UI; every measurement is also buffered for batched upload.
public class BleHeartRateModule: Module {
    private static let deviceErasureCutoffKey = "dofek_device_erasure_cutoff_v1"
    private let connectionManager = BleHeartRateConnectionManager()
    private let sampleBuffer = BleHeartRateSampleBuffer()
    private var deviceRegistry: BleHeartRateDeviceRegistry?
    private var deviceRegistryError: BleHeartRateDeviceRegistryError?
    private var deviceCoordinator: BleHeartRateDeviceCoordinator?

    private let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    public func definition() -> ModuleDefinition {
        Name("BleHeartRate")

        Events(
            "onConnectionStateChanged",
            "onDeviceStateChanged",
            "onDeviceListChanged",
            "onHeartRateMeasurement"
        )

        OnCreate {
            switch Result(catching: { try BleHeartRateDeviceRegistry() }) {
            case .success(let registry):
                self.deviceRegistry = registry
                self.deviceCoordinator = BleHeartRateDeviceCoordinator(
                    connectionManager: self.connectionManager,
                    deviceRegistry: registry,
                    sampleBuffer: self.sampleBuffer,
                    onConnectionEvent: { [weak self] event in
                        self?.emitConnectionEvent(event)
                    },
                    onDeviceStateChanged: { [weak self] snapshot in
                        self?.emitDeviceState(snapshot)
                    },
                    onHeartRateMeasurement: { [weak self] sample in
                        self?.emitHeartRateMeasurement(sample)
                    },
                    onRegistryError: { [weak self] deviceId, error in
                        self?.emitRegistryError(deviceId: deviceId, error: error)
                    }
                )
            case .failure(let error):
                self.deviceRegistryError = error as? BleHeartRateDeviceRegistryError ?? .unavailable
            }
            if let cutoff = UserDefaults.standard.object(
                forKey: Self.deviceErasureCutoffKey
            ) as? Date {
                self.sampleBuffer.advanceErasureCutoff(to: cutoff)
            }
        }

        Function("isBluetoothAvailable") { () -> Bool in
            self.connectionManager.isBluetoothAvailable
        }

        AsyncFunction("scanAndConnect") { (promise: Promise) in
            guard let coordinator = self.deviceCoordinatorOrReject(promise) else { return }
            coordinator.scanAndConnect { result in
                self.resolveConnect(result, promise: promise)
                if case .success = result {
                    self.emitDeviceListChanged()
                }
            }
        }

        AsyncFunction("connect") { (peripheralId: String, promise: Promise) in
            guard let coordinator = self.deviceCoordinatorOrReject(promise) else { return }
            coordinator.connect(peripheralId: peripheralId) { result in
                self.resolveConnect(result, promise: promise)
            }
        }

        Function("getDevices") { () throws -> [[String: Any]] in
            try self.requireDeviceRegistry().devices.compactMap { device in
                self.deviceSnapshotPayload(for: device.id)
            }
        }

        Function("getConnectionState") { () -> String in
            self.connectionManager.currentStateValue
        }

        Function("getBufferedSampleCount") { () -> Int in
            self.sampleBuffer.sampleCount
        }

        AsyncFunction("peekBufferedSamples") { (maxCount: Int?, promise: Promise) in
            promise.resolve(self.sampleBuffer.peekSamples(maxCount: maxCount ?? 1000))
        }

        Function("confirmSamplesDrain") { (count: Int) in
            self.sampleBuffer.confirmDrain(count: count)
        }

        Function("disconnect") { (peripheralId: String?) in
            if let peripheralId {
                self.connectionManager.disconnect(peripheralId: peripheralId)
            } else {
                self.connectionManager.disconnectAll()
            }
        }

        Function("forget") { (peripheralId: String) throws in
            try self.requireDeviceRegistry().remove(id: peripheralId)
            self.connectionManager.disconnect(peripheralId: peripheralId)
            self.emitDeviceListChanged()
        }

        AsyncFunction("purgeAccountState") { (cutoffString: String, promise: Promise) in
            guard let cutoff = self.parseIsoDate(cutoffString) else {
                promise.reject(
                    "BLE_HEART_RATE_INVALID_ERASURE_CUTOFF",
                    "Invalid device erasure cutoff"
                )
                return
            }
            let retainedCutoff =
                (UserDefaults.standard.object(forKey: Self.deviceErasureCutoffKey) as? Date)
                .map { max($0, cutoff) } ?? cutoff
            guard let coordinator = self.deviceCoordinatorOrReject(promise) else { return }
            UserDefaults.standard.set(
                retainedCutoff,
                forKey: Self.deviceErasureCutoffKey
            )
            coordinator.purgeAccountState(cutoff: retainedCutoff) { result in
                switch result {
                case .success:
                    self.emitDeviceListChanged()
                    promise.resolve(true)
                case .failure(let error):
                    self.rejectRegistryError(error, promise: promise)
                }
            }
        }
    }

    private func parseIsoDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = formatter.date(from: value) {
            return parsed
        }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    private func resolveConnect(
        _ result: Result<BleHeartRateDevice, BleHeartRateDeviceCoordinatorError>,
        promise: Promise
    ) {
        switch result {
        case .success(let device):
            // Bridge a nil name to an explicit null so JS sees `name: null`.
            var payload: [String: Any] = ["id": device.id]
            payload["name"] = device.name.map { $0 as Any } ?? NSNull()
            promise.resolve(payload)
        case .failure(let error):
            rejectCoordinatorError(error, promise: promise)
        }
    }

    private func rejectCoordinatorError(
        _ error: BleHeartRateDeviceCoordinatorError,
        promise: Promise
    ) {
        switch error {
        case .registry(let error):
            rejectRegistryError(error, promise: promise)
        case .unmanagedDevice(let identifier):
            promise.reject(
                "DEVICE_NOT_REGISTERED",
                "Heart-rate monitor is not app-managed: \(identifier)"
            )
        case .connection(let error):
            switch error {
            case .bluetoothUnavailable:
                promise.reject("BLUETOOTH_UNAVAILABLE", "Bluetooth is not available")
            case .invalidPeripheralId(let identifier):
                promise.reject("INVALID_ID", "Invalid peripheral ID: \(identifier)")
            case .peripheralNotFound(let identifier):
                promise.reject("NOT_FOUND", "Heart-rate monitor not found: \(identifier)")
            case .scanTimeout:
                promise.reject("SCAN_TIMEOUT", "No heart-rate monitor found")
            case .connectTimeout:
                promise.reject("CONNECT_TIMEOUT", "Connection timed out")
            case .serviceNotFound:
                promise.reject("NO_SERVICE", "Heart Rate Service not found")
            case .characteristicNotFound:
                promise.reject("NO_CHARACTERISTIC", "Heart Rate Measurement characteristic not found")
            case .notificationSubscriptionFailed:
                promise.reject("NO_NOTIFY", "Could not subscribe to heart-rate notifications")
            case .disconnected(let message):
                promise.reject("DISCONNECTED", message ?? "Monitor disconnected")
            case .busy:
                promise.reject("BUSY", "A connection attempt is already in progress")
            }
        }
    }

    private func requireDeviceRegistry() throws -> BleHeartRateDeviceRegistry {
        guard let deviceRegistry else {
            throw deviceRegistryError ?? .unavailable
        }
        return deviceRegistry
    }

    private func deviceRegistryOrReject(_ promise: Promise) -> BleHeartRateDeviceRegistry? {
        do {
            return try requireDeviceRegistry()
        } catch {
            rejectRegistryError(error, promise: promise)
            return nil
        }
    }

    private func deviceCoordinatorOrReject(_ promise: Promise) -> BleHeartRateDeviceCoordinator? {
        guard let deviceCoordinator else {
            rejectRegistryError(deviceRegistryError ?? .unavailable, promise: promise)
            return nil
        }
        return deviceCoordinator
    }

    private func rejectRegistryError(_ error: Error, promise: Promise) {
        promise.reject(
            "BLE_HEART_RATE_REGISTRY_PERSISTENCE_FAILED",
            error.localizedDescription
        )
    }

    private func deviceSnapshotPayload(for deviceId: String) -> [String: Any]? {
        guard let snapshot = deviceRegistry?.snapshot(
            id: deviceId,
            bufferedSampleCount: sampleBuffer.sampleCount(for: deviceId)
        ) else {
            return nil
        }
        return deviceSnapshotPayload(snapshot)
    }

    private func deviceSnapshotPayload(_ snapshot: BleHeartRateDeviceSnapshot) -> [String: Any] {
        return [
            "id": snapshot.id,
            "name": snapshot.name ?? NSNull(),
            "connectionState": snapshot.connectionState,
            "lastMeasurementAt": snapshot.lastMeasurementAt.map(isoFormatter.string) ?? NSNull(),
            "lastHeartRateBpm": snapshot.lastHeartRateBpm ?? NSNull(),
            "lastRrIntervalsMs": snapshot.lastRrIntervalsMs,
            "bufferedSampleCount": snapshot.bufferedSampleCount,
        ]
    }

    private func emitDeviceState(_ snapshot: BleHeartRateDeviceSnapshot) {
        let payload = deviceSnapshotPayload(snapshot)
        emitOnMainThread("onDeviceStateChanged", payload.mapValues { Optional($0) })
    }

    private func emitDeviceListChanged() {
        emitOnMainThread("onDeviceListChanged", [:])
    }

    private func emitConnectionEvent(_ event: BleHeartRateConnectionEvent) {
        switch event {
        case .connected(let device):
            emitOnMainThread("onConnectionStateChanged", [
                "state": "connected",
                "peripheralId": device.id,
                "name": device.name,
            ])
        case .disconnected(let peripheralId, let error):
            emitOnMainThread("onConnectionStateChanged", [
                "state": "disconnected",
                "peripheralId": peripheralId,
                "error": error?.localizedDescription,
            ])
        }
    }

    private func emitHeartRateMeasurement(_ sample: BleHeartRateSample) {
        emitOnMainThread("onHeartRateMeasurement", [
            "deviceId": sample.deviceId,
            "timestamp": isoFormatter.string(from: sample.timestamp),
            "heartRateBpm": sample.heartRateBpm,
            "rrIntervalsMs": sample.rrIntervalsMs,
        ])
    }

    private func emitRegistryError(deviceId: String, error: Error) {
        emitOnMainThread("onConnectionStateChanged", [
            "state": "error",
            "peripheralId": deviceId,
            "error": error.localizedDescription,
        ])
    }

    private func emitOnMainThread(_ event: String, _ payload: [String: Any?]) {
        let bridgePayload = payload.compactMapValues { $0 }
        if Thread.isMainThread {
            sendEvent(event, bridgePayload)
        } else {
            DispatchQueue.main.async { [weak self] in
                self?.sendEvent(event, bridgePayload)
            }
        }
    }
}
