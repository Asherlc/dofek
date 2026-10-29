import CoreBluetooth
import ExpoModulesCore
import Foundation
import RNSentry

/// Expo native module that connects to a WHOOP strap via CoreBluetooth
/// and streams raw IMU (accelerometer + gyroscope) data.
///
/// This is the coordinator — it wires together the connection manager,
/// sample buffer, orientation processor, and data watchdog, and exposes
/// them as Expo functions/events to the JS layer.
public class WhoopBleModule: Module {
    private static let deviceErasureCutoffKey = "dofek_device_erasure_cutoff_v1"

    internal let connectionManager = WhoopBleConnectionManager()
    internal var captureFailure: String?
    internal var captureSuspended = false
    internal var uploader: WhoopBleBackgroundUploader {
        get throws { try WhoopBleUploadRuntime.shared() }
    }
    internal let orientationProcessor = WhoopBleOrientationProcessor()
    internal lazy var watchdog = WhoopBleDataWatchdog(queue: connectionManager.bleQueue)

    internal let frameParser = WhoopBleFrameParser()
    internal let cmdFrameParser = WhoopBleFrameParser()
    internal var lastKnownDeviceId: String?
    internal var lastKnownDeviceName: String?
    internal var deviceStatePublicationScheduled = false

    // MARK: - Diagnostic counters

    internal var dataNotificationCount: UInt64 = 0
    internal var cmdNotificationCount: UInt64 = 0
    internal var totalFramesParsed: UInt64 = 0
    internal var totalSamplesExtracted: UInt64 = 0
    internal var emptyExtractions: UInt64 = 0
    internal var packetTypeCounts: [UInt8: UInt64] = [:]
    internal var lastCommandResponse: String = "none"
    internal var captureDiagnostics = WhoopBleCaptureDiagnostics()

    // swiftlint:disable:next function_body_length
    public func definition() -> ModuleDefinition {
        Name("WhoopBle")

        Events("onConnectionStateChanged", "onDeviceStateChanged", "onOrientation", "onCaptureError")

        OnCreate {
            self.connectionManager.delegate = self
            self.watchdog.delegate = self
            do { _ = try self.uploader } catch { self.failCapture(error) }
        }

        // MARK: - Availability

        Function("isBluetoothAvailable") { () -> Bool in
            self.connectionManager.isBluetoothAvailable
        }

        // MARK: - Discovery

        AsyncFunction("findWhoop") { (promise: Promise) in
            self.connectionManager.findWhoop { result in
                promise.resolve(result)
            }
        }

        // MARK: - Connection

        AsyncFunction("connect") { (peripheralId: String, promise: Promise) in
            self.connectionManager.connect(peripheralId: peripheralId) { result in
                switch result {
                case .success(let value):
                    self.emitDeviceState()
                    promise.resolve(value)
                case .failure(let error):
                    self.emitDeviceState()
                    let rejection = error.rejection
                    promise.reject(rejection.code, rejection.message)
                }
            }
        }

        // MARK: - IMU streaming

        AsyncFunction("startImuStreaming") { (promise: Promise) in
            self.connectionManager.bleQueue.async {
                if self.connectionManager.state == .streaming {
                    NSLog("[WhoopBLE] startImuStreaming: already streaming, returning success")
                    self.emitDeviceState()
                    promise.resolve(true)
                    return
                }

                guard self.connectionManager.startStreaming() else {
                    let state = self.connectionManager.state.rawValue
                    let peripheralStatus = self.connectionManager.connectedPeripheral == nil ? "nil" : "set"
                    let cmdCharStatus = self.connectionManager.cmdCharacteristic == nil ? "nil" : "set"
                    let detail = "state=\(state) peripheral=\(peripheralStatus) cmdChar=\(cmdCharStatus)"
                    NSLog("[WhoopBLE] startImuStreaming: NOT_READY (%@)", detail)
                    promise.reject("NOT_READY", "Not ready: \(detail)")
                    return
                }

                let commandData = WhoopBleFrameParser.buildCommandData(
                    command: WhoopBleConstants.commandToggleImuMode
                )
                NSLog("[WhoopBLE] startImuStreaming: sending TOGGLE_IMU_MODE (0x6A)")
                self.connectionManager.writeToStrap(commandData)

                self.watchdog.recordDataReceived()
                self.frameParser.reset()
                self.cmdFrameParser.reset()
                self.orientationProcessor.reset()

                NSLog("[WhoopBLE] startImuStreaming: now streaming")
                self.emitDeviceState()
                promise.resolve(true)
            }
        }

        AsyncFunction("stopImuStreaming") { (promise: Promise) in
            self.connectionManager.bleQueue.async {
                self.connectionManager.stopStreaming()
                if self.connectionManager.cmdCharacteristic != nil {
                    let commandData = WhoopBleFrameParser.buildCommandData(
                        command: WhoopBleConstants.commandStopRawData
                    )
                    self.connectionManager.writeToStrap(commandData)
                }

                self.emitDeviceState()
                promise.resolve(true)
            }
        }

        // MARK: - Diagnostics

        Function("getConnectionState") { () -> String in
            self.connectionManager.syncOnBleQueue {
                self.connectionManager.state.rawValue
            }
        }

        Function("getBluetoothState") { () -> String in
            self.connectionManager.syncOnBleQueue {
                self.connectionManager.bluetoothState
            }
        }

        Function("getBufferedSampleCount") { () -> Int in
            try self.uploader.sampleCount(stream: .imu)
        }

        Function("getDeviceSummary") { () -> [String: Any] in
            try self.deviceSummaryPayload()
        }

        Function("getDataPathStats") { () -> [String: Any] in
            try self.connectionManager.syncOnBleQueue {
                let packetTypeSummary = self.packetTypeCounts
                    .sorted(by: { $0.key < $1.key })
                    .map { String(format: "0x%02X:%llu", $0.key, $0.value) }
                    .joined(separator: ", ")

                var stats: [String: Any] = [
                    "dataNotificationCount": Int(self.dataNotificationCount),
                    "cmdNotificationCount": Int(self.cmdNotificationCount),
                    "totalFramesParsed": Int(self.totalFramesParsed),
                    "totalSamplesExtracted": Int(self.totalSamplesExtracted),
                    "emptyExtractions": Int(self.emptyExtractions),
                    "bufferOverflows": 0,
                    "packetTypes": packetTypeSummary,
                    "lastCommandResponse": self.lastCommandResponse,
                    "connectionState": self.connectionManager.state.rawValue,
                    "lastKnownDeviceId": self.lastKnownDeviceId ?? NSNull(),
                    "hasDataCharacteristic": self.connectionManager.hasDataCharacteristic,
                    "isNotifying": self.connectionManager.isNotifying,
                    "hasCmdCharacteristic": self.connectionManager.hasCmdCharacteristic,
                    "hasCmdResponseCharacteristic": self.connectionManager.hasCmdResponseCharacteristic,
                    "lastWriteError": self.connectionManager.lastWriteError ?? "none",
                    "realtimeBufferCount": try self.uploader.sampleCount(stream: .realtime),
                    "watchdogRetryCount": Int(self.watchdog.retryCount),
                    "malformedFrames": Int(self.frameParser.malformedFrameCount),
                    "malformedCmdFrames": Int(self.cmdFrameParser.malformedFrameCount),
                    "coalescedFrames": Int(self.frameParser.coalescedFrameCount),
                    "coalescedCmdFrames": Int(self.cmdFrameParser.coalescedFrameCount),
                    "buffers": try self.uploader.diagnostics(),
                    "connectionDiagnostics": self.connectionManager.connectionDiagnostics.payload,
                ]
                stats.merge(self.captureDiagnostics.payload) { _, captured in captured }
                return stats
            }
        }

        // MARK: - Realtime HR / Optical commands

        AsyncFunction("startRealtimeHr") { (promise: Promise) in
            self.connectionManager.bleQueue.async {
                guard self.connectionManager.cmdCharacteristic != nil else {
                    promise.resolve(false)
                    return
                }
                let commandData = WhoopBleFrameParser.buildCommandData(
                    command: WhoopBleConstants.commandToggleRealtimeHr
                )
                NSLog("[WhoopBLE] sending TOGGLE_REALTIME_HR (0x03)")
                self.connectionManager.writeToStrap(commandData)
                promise.resolve(true)
            }
        }

        AsyncFunction("startOpticalMode") { (promise: Promise) in
            self.connectionManager.bleQueue.async {
                guard self.connectionManager.cmdCharacteristic != nil else {
                    promise.resolve(false)
                    return
                }
                let commandData = WhoopBleFrameParser.buildCommandData(
                    command: WhoopBleConstants.commandToggleOpticalMode
                )
                NSLog("[WhoopBLE] sending TOGGLE_OPTICAL_MODE (0x6C)")
                self.connectionManager.writeToStrap(commandData)
                promise.resolve(true)
            }
        }

        // MARK: - Durable capture and native background delivery

        Function("configureUpload") { (context: [String: Any]) in
            guard let userId = context["userId"] as? String,
                  let serverURL = context["serverURL"] as? String,
                  let token = context["token"] as? String,
                  let headers = context["headers"] as? [String: String] else {
                throw WhoopUploadError(message: "WHOOP upload configuration is incomplete")
            }
            do {
                self.connectionManager.syncOnBleQueue { self.captureSuspended = true }
                try self.uploader.configure(userId: userId, serverURL: serverURL, token: token, headers: headers)
                self.connectionManager.syncOnBleQueue {
                    self.captureFailure = nil
                    self.captureSuspended = false
                }
            } catch {
                SentrySDK.capture(error: error)
                throw error
            }
        }

        Function("flushUploads") {
            do { try self.uploader.flush() } catch {
                SentrySDK.capture(error: error)
                throw error
            }
        }

        Function("disableUploads") {
            self.connectionManager.syncOnBleQueue {
                self.captureSuspended = true
                self.watchdog.stop()
            }
            self.connectionManager.disconnect()
            do { try self.uploader.disable() } catch {
                SentrySDK.capture(error: error)
                throw error
            }
        }

        // MARK: - Background reconnection

        AsyncFunction("retryConnection") { (promise: Promise) in
            self.connectionManager.retryConnection { success in
                promise.resolve(success)
            }
        }

        // MARK: - Disconnect

        Function("disconnect") { [self] in
            self.connectionManager.disconnect { [weak self] in
                self?.emitDeviceState()
            }
        }

        AsyncFunction("purgeAccountState") { [self] (cutoffString: String, promise: Promise) in
            guard let cutoff = self.parseIsoDate(cutoffString) else {
                promise.reject(
                    "WHOOP_BLE_INVALID_ERASURE_CUTOFF",
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

            self.connectionManager.bleQueue.async {
                self.captureSuspended = true
                self.watchdog.stop()
                do { try self.uploader.purge(cutoff: retainedCutoff) } catch {
                    SentrySDK.capture(error: error)
                    promise.reject("WHOOP_BLE_PURGE_FAILED", error.localizedDescription)
                    return
                }
                self.frameParser.reset()
                self.cmdFrameParser.reset()
                self.orientationProcessor.reset()
                self.dataNotificationCount = 0
                self.cmdNotificationCount = 0
                self.totalFramesParsed = 0
                self.totalSamplesExtracted = 0
                self.emptyExtractions = 0
                self.packetTypeCounts.removeAll()
                self.lastCommandResponse = "none"
                self.captureDiagnostics = WhoopBleCaptureDiagnostics()
                self.lastKnownDeviceId = nil
                self.lastKnownDeviceName = nil
                self.connectionManager.disconnect { [weak self] in
                    self?.connectionManager.connectionDiagnostics.clear()
                    self?.emitDeviceState()
                    promise.resolve(true)
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

    private func deviceSummaryPayload() throws -> [String: Any] {
        try connectionManager.syncOnBleQueue {
            let connectedPeripheral = connectionManager.connectedPeripheral
            let peripheralId = connectedPeripheral?.identifier.uuidString ?? lastKnownDeviceId
            let peripheralName = connectedPeripheral?.name ?? lastKnownDeviceName
            return [
                "id": (peripheralId as Any?) ?? NSNull(),
                "name": (peripheralName as Any?) ?? NSNull(),
                "connectionState": connectionManager.state.rawValue,
                "imuBufferedSamples": try uploader.sampleCount(stream: .imu),
                "realtimeBufferedSamples": try uploader.sampleCount(stream: .realtime),
            ]
        }
    }

    internal func emitDeviceState() {
        do {
            let payload = try deviceSummaryPayload()
            MainThreadEventEmitter.emit(payload) { [weak self] payload in
                self?.sendEvent("onDeviceStateChanged", payload)
            }
        } catch { failCapture(error) }
    }

    /// Buffer-count changes arrive at packet rate; publish them at a bounded cadence.
    /// Lifecycle transitions continue to call `emitDeviceState()` immediately.
    internal func scheduleDeviceStatePublication() {
        guard !deviceStatePublicationScheduled else { return }
        deviceStatePublicationScheduled = true
        connectionManager.bleQueue.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self else { return }
            self.deviceStatePublicationScheduled = false
            self.emitDeviceState()
        }
    }

    internal func failCapture(_ error: Error) {
        connectionManager.syncOnBleQueue {
            guard captureFailure == nil else { return }
            captureFailure = error.localizedDescription
            SentrySDK.capture(error: error)
            watchdog.stop()
            connectionManager.disconnect()
            MainThreadEventEmitter.emit(["message": error.localizedDescription]) { [weak self] payload in
                self?.sendEvent("onCaptureError", payload)
            }
        }
    }

    // MARK: - Activation commands

    /// Send the standard activation commands to the strap.
    /// Called on initial connect and by the watchdog on data silence.
    internal func sendActivationCommands(includeImu: Bool) {
        NSLog("[WhoopBLE] sending activation commands (includeImu=%@)", includeImu ? "true" : "false")
        connectionManager.writeToStrap(
            WhoopBleFrameParser.buildCommandData(command: WhoopBleConstants.commandToggleRealtimeHr)
        )
        connectionManager.writeToStrap(
            WhoopBleFrameParser.buildCommandData(command: WhoopBleConstants.commandToggleOpticalMode)
        )
        connectionManager.writeToStrap(
            WhoopBleFrameParser.buildCommandData(command: WhoopBleConstants.commandSendR10R11Realtime)
        )
        if includeImu {
            connectionManager.writeToStrap(
                WhoopBleFrameParser.buildCommandData(command: WhoopBleConstants.commandToggleImuMode)
            )
        }
    }
}
