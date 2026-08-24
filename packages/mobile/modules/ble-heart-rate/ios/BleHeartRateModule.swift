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

    private let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    public func definition() -> ModuleDefinition {
        Name("BleHeartRate")

        Events("onConnectionStateChanged", "onDeviceStateChanged", "onHeartRateMeasurement")

        OnCreate {
            self.connectionManager.delegate = self
            switch Result(catching: { try BleHeartRateDeviceRegistry() }) {
            case .success(let registry):
                self.deviceRegistry = registry
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
            guard self.deviceRegistryOrReject(promise) != nil else { return }
            self.connectionManager.scanAndConnect { result in
                self.resolveConnect(
                    result,
                    promise: promise,
                    registerDevice: true
                )
            }
        }

        AsyncFunction("connect") { (peripheralId: String, promise: Promise) in
            guard self.deviceRegistryOrReject(promise) != nil else { return }
            self.connectionManager.connect(peripheralId: peripheralId) { result in
                self.resolveConnect(
                    result,
                    promise: promise,
                    registerDevice: false
                )
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
            guard let registry = self.deviceRegistryOrReject(promise) else { return }
            do {
                try registry.clear()
            } catch {
                self.rejectRegistryError(error, promise: promise)
                return
            }
            UserDefaults.standard.set(
                retainedCutoff,
                forKey: Self.deviceErasureCutoffKey
            )
            self.connectionManager.disconnectAll()
            self.sampleBuffer.advanceErasureCutoff(to: retainedCutoff)
            promise.resolve(true)
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
        _ result: Result<BleHeartRateDevice, BleHeartRateConnectionError>,
        promise: Promise,
        registerDevice: Bool
    ) {
        switch result {
        case .success(let device):
            guard let registry = deviceRegistryOrReject(promise) else { return }
            do {
                if registerDevice {
                    try registry.register(device)
                    registry.setConnectionState(
                        BleHeartRateConnectionState.ready.rawValue,
                        for: device.id
                    )
                    emitDeviceState(for: device.id)
                }
            } catch {
                rejectRegistryError(error, promise: promise)
                return
            }
            // Bridge a nil name to an explicit null so JS sees `name: null`.
            var payload: [String: Any] = ["id": device.id]
            payload["name"] = device.name.map { $0 as Any } ?? NSNull()
            promise.resolve(payload)
        case .failure(let error):
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

    private func emitDeviceState(for deviceId: String) {
        guard let payload = deviceSnapshotPayload(for: deviceId) else { return }
        emitOnMainThread("onDeviceStateChanged", payload.mapValues { Optional($0) })
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

// MARK: - BleHeartRateConnectionManagerDelegate

extension BleHeartRateModule: BleHeartRateConnectionManagerDelegate {
    func connectionManager(
        _ manager: BleHeartRateConnectionManager,
        didChangeState state: BleHeartRateConnectionState,
        for peripheralId: String
    ) {
        deviceRegistry?.setConnectionState(state.rawValue, for: peripheralId)
        emitDeviceState(for: peripheralId)
    }

    func connectionManagerDidBecomeReady(
        _ manager: BleHeartRateConnectionManager,
        device: BleHeartRateDevice
    ) {
        emitOnMainThread("onConnectionStateChanged", [
            "state": "connected",
            "peripheralId": device.id,
            "name": device.name,
        ])
    }

    func connectionManagerDidDisconnect(
        _ manager: BleHeartRateConnectionManager,
        peripheralId: String,
        error: Error?
    ) {
        emitOnMainThread("onConnectionStateChanged", [
            "state": "disconnected",
            "peripheralId": peripheralId,
            "error": error?.localizedDescription,
        ])
    }

    func connectionManager(
        _ manager: BleHeartRateConnectionManager,
        didReceiveMeasurement measurement: BleHeartRateMeasurement,
        from deviceId: String,
        at timestamp: Date
    ) {
        sampleBuffer.append(
            BleHeartRateSample(
                deviceId: deviceId,
                timestamp: timestamp,
                heartRateBpm: measurement.heartRateBpm,
                rrIntervalsMs: measurement.rrIntervalsMs
            )
        )
        do {
            try deviceRegistry?.recordMeasurement(
                deviceId: deviceId,
                heartRateBpm: measurement.heartRateBpm,
                rrIntervalsMs: measurement.rrIntervalsMs,
                at: timestamp
            )
        } catch {
            emitOnMainThread("onConnectionStateChanged", [
                "state": "error",
                "peripheralId": deviceId,
                "error": error.localizedDescription,
            ])
            return
        }

        emitOnMainThread("onHeartRateMeasurement", [
            "deviceId": deviceId,
            "timestamp": isoFormatter.string(from: timestamp),
            "heartRateBpm": measurement.heartRateBpm,
            "rrIntervalsMs": measurement.rrIntervalsMs,
        ])
        emitDeviceState(for: deviceId)
    }
}
