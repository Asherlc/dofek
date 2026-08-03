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

    private let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    public func definition() -> ModuleDefinition {
        Name("BleHeartRate")

        Events("onConnectionStateChanged", "onHeartRateMeasurement")

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
                self.resolveConnect(result, promise: promise)
            }
        }

        AsyncFunction("connect") { (peripheralId: String, promise: Promise) in
            self.connectionManager.connect(peripheralId: peripheralId) { result in
                self.resolveConnect(result, promise: promise)
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

        Function("disconnect") {
            self.connectionManager.disconnect()
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
        promise: Promise
    ) {
        switch result {
        case .success(let device):
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

        emitOnMainThread("onHeartRateMeasurement", [
            "timestamp": isoFormatter.string(from: timestamp),
            "heartRateBpm": measurement.heartRateBpm,
            "rrIntervalsMs": measurement.rrIntervalsMs,
        ])
    }
}
