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
    private let deviceRegistry = BleHeartRateDeviceRegistry()

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
            self.connectionManager.scanAndConnect { result in
                self.resolveConnect(result, promise: promise, registerDevice: true)
            }
        }

        AsyncFunction("connect") { (peripheralId: String, promise: Promise) in
            self.connectionManager.connect(peripheralId: peripheralId) { result in
                self.resolveConnect(result, promise: promise, registerDevice: false)
            }
        }

        Function("getDevices") { () -> [[String: Any]] in
            self.deviceRegistry.devices.compactMap { device in
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

        Function("disconnect") { (peripheralId: String?) throws in
            guard peripheralId == nil else {
                throw BleHeartRateModuleError.perDeviceActionsUnavailable
            }
            self.connectionManager.disconnect()
        }

        Function("forget") { (_: String) throws in
            throw BleHeartRateModuleError.perDeviceActionsUnavailable
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
            UserDefaults.standard.set(
                retainedCutoff,
                forKey: Self.deviceErasureCutoffKey
            )
            self.connectionManager.disconnect()
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
            if registerDevice {
                deviceRegistry.register(device)
                deviceRegistry.setConnectionState(
                    BleHeartRateConnectionState.ready.rawValue,
                    for: device.id
                )
                emitDeviceState(for: device.id)
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

    private func deviceSnapshotPayload(for deviceId: String) -> [String: Any]? {
        guard let snapshot = deviceRegistry.snapshot(
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

private enum BleHeartRateModuleError: LocalizedError {
    case perDeviceActionsUnavailable

    var errorDescription: String? {
        "Per-device Bluetooth actions are unavailable until multi-device connections are enabled"
    }
}

// MARK: - BleHeartRateConnectionManagerDelegate

extension BleHeartRateModule: BleHeartRateConnectionManagerDelegate {
    func connectionManagerDidBecomeReady(
        _ manager: BleHeartRateConnectionManager,
        device: BleHeartRateDevice
    ) {
        deviceRegistry.setConnectionState(BleHeartRateConnectionState.ready.rawValue, for: device.id)
        emitOnMainThread("onConnectionStateChanged", [
            "state": "connected",
            "peripheralId": device.id,
            "name": device.name,
        ])
        emitDeviceState(for: device.id)
    }

    func connectionManagerDidDisconnect(
        _ manager: BleHeartRateConnectionManager,
        peripheralId: String,
        error: Error?
    ) {
        deviceRegistry.setConnectionState(BleHeartRateConnectionState.idle.rawValue, for: peripheralId)
        emitOnMainThread("onConnectionStateChanged", [
            "state": "disconnected",
            "peripheralId": peripheralId,
            "error": error?.localizedDescription,
        ])
        emitDeviceState(for: peripheralId)
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
        deviceRegistry.recordMeasurement(
            deviceId: deviceId,
            heartRateBpm: measurement.heartRateBpm,
            rrIntervalsMs: measurement.rrIntervalsMs,
            at: timestamp
        )

        emitOnMainThread("onHeartRateMeasurement", [
            "timestamp": isoFormatter.string(from: timestamp),
            "heartRateBpm": measurement.heartRateBpm,
            "rrIntervalsMs": measurement.rrIntervalsMs,
        ])
        emitDeviceState(for: deviceId)
    }
}
