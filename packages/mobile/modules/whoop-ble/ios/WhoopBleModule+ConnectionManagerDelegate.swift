import CoreBluetooth
import Foundation

// MARK: - WhoopBleConnectionManagerDelegate

extension WhoopBleModule: WhoopBleConnectionManagerDelegate {
    func connectionManagerDidSelectPeripheral(_: WhoopBleConnectionManager) {
        frameParser.reset()
        cmdFrameParser.reset()
        managedHistoryPeripheralId = nil
        historyOffload.reset()
    }

    func connectionManagerDidBecomeReady(
        _ manager: WhoopBleConnectionManager,
        peripheral: any WhoopBlePeripheralConnection,
        cmdCharacteristic: CBCharacteristic,
        wasStreaming: Bool
    ) {
        let service = cmdCharacteristic.service?.uuid
        let supportsManagedHistory = manager.hasCmdResponseCharacteristic && (
            service == WhoopBleConstants.maverickServiceUUID || service == WhoopBleConstants.puffinServiceUUID
        )
        publishReadyConnection(
            peripheralId: peripheral.identifier.uuidString,
            peripheralName: peripheral.name,
            wasStreaming: wasStreaming,
            supportsManagedHistory: supportsManagedHistory
        )
    }

    /// Publish and activate notification readiness on the connection manager's BLE queue.
    func publishReadyConnection(
        peripheralId: String, peripheralName: String?, wasStreaming: Bool, supportsManagedHistory: Bool = false
    ) {
        guard !captureSuspended, captureFailure == nil else {
            connectionManager.disconnect()
            return
        }
        lastKnownDeviceId = peripheralId
        lastKnownDeviceName = peripheralName
        lastKnownHistorySupported = supportsManagedHistory
        if supportsManagedHistory, let identifier = UUID(uuidString: peripheralId) {
            do {
                if try uploader.isManagedHistoryEnabled(for: identifier) { managedHistoryPeripheralId = identifier }
            } catch {
                failCapture(error)
                return
            }
        }
        emitDeviceState()
        guard !captureSuspended, captureFailure == nil else { return }
        MainThreadEventEmitter.emit([
            "state": "connected",
            "peripheralId": peripheralId,
        ]) { [weak self] payload in
            self?.sendEvent("onConnectionStateChanged", payload)
        }
        sendActivationCommands(includeImu: false)
        watchdog.start()

        WhoopBleStreamRestorer.restoreIfNeeded(
            wasStreaming: wasStreaming,
            startStreaming: connectionManager.startStreaming,
            activateImu: { [self] in
                connectionManager.writeToStrap(
                    WhoopBleFrameParser.buildCommandData(
                        command: WhoopBleConstants.commandToggleImuMode
                    )
                )
            },
            emitDeviceState: { [self] in
                emitDeviceState()
            }
        )
        if wasStreaming {
            startManagedHistoryIfEnabled()
        }
    }

    func connectionManagerDidDisconnect(
        _ manager: WhoopBleConnectionManager,
        peripheralId: String,
        error: Error?
    ) {
        watchdog.stop()
        stopManagedHistory()
        frameParser.reset()
        cmdFrameParser.reset()

        MainThreadEventEmitter.emit([
            "state": "disconnected",
            "peripheralId": peripheralId,
            "error": error?.localizedDescription,
        ]) { [weak self] payload in
            self?.sendEvent("onConnectionStateChanged", payload)
        }
        emitDeviceState()
    }

    func connectionManager(
        _ manager: WhoopBleConnectionManager,
        didReceiveData data: Data
    ) {
        guard !captureSuspended, captureFailure == nil else {
            // A restored link can deliver data before the outbox is ready.
            // It may already have a history transfer we couldn't observe.
            historyOffload.stop()
            return
        }
        guard let deviceId = manager.connectedPeripheral?.identifier.uuidString else { return }

        dataNotificationCount += 1
        captureDiagnostics.recordNotification()
        watchdog.recordDataReceived()

        let malformedBeforeFeed = frameParser.malformedFrameCount
        let frames = frameParser.feed(data)
        if frameParser.malformedFrameCount != malformedBeforeFeed { stopManagedHistory() }
        totalFramesParsed += UInt64(frames.count)

        var newImuSamples: [WhoopImuSample] = []
        var newRealtimeData: [WhoopRealtimeDataSample] = []
        var newSensorRecords: [[String: Any]] = []
        var retainedR18Frames = IndexSet()
        var deviceInfo = manager.deviceInfo
        if let name = manager.connectedPeripheral?.name, !name.isEmpty { deviceInfo["name"] = String(name.prefix(200)) }

        for (index, frame) in frames.enumerated() {
            if let record = WhoopBleSensorRecord.serialize(frame: frame, deviceInfo: deviceInfo) {
                newSensorRecords.append(record)
                if WhoopBleSensorRecord.hasCapturedR18Layout(frame) { retainedR18Frames.insert(index) }
            }
            packetTypeCounts[frame.packetType, default: 0] += 1

            let count = packetTypeCounts[frame.packetType] ?? 0
            if count == 1 {
                NSLog(
                    "[WhoopBLE] first packet of type 0x%02X (record=%d, payload=%d bytes)",
                    frame.packetType,
                    frame.recordType,
                    frame.payload.count
                )
            }

            let samples = WhoopBleFrameParser.extractImuSamples(from: frame)
            newImuSamples.append(contentsOf: samples)

            if let realtimeData = WhoopBleFrameParser.extractRealtimeData(from: frame) {
                newRealtimeData.append(realtimeData)
            }
        }
        captureDiagnostics.recordParsed(
            imuCount: newImuSamples.count,
            realtimeSamples: newRealtimeData
        )

        let hasSamples = !newImuSamples.isEmpty || !newRealtimeData.isEmpty || !newSensorRecords.isEmpty
        if hasSamples {
            totalSamplesExtracted += UInt64(newImuSamples.count)
            publishOrientation(newImuSamples)
            do {
                try uploader.append(deviceId: deviceId, samplesByStream: [
                    .sensorRecords: newSensorRecords,
                    .realtime: WhoopBleSampleSerializer.realtime(newRealtimeData),
                    .imu: WhoopBleSampleSerializer.imu(newImuSamples),
                ])
            } catch {
                failCapture(error)
                return
            }
            scheduleDeviceStatePublication()
        } else {
            emptyExtractions += 1
        }

        for (index, frame) in frames.enumerated() {
            historyOffload.receiveCommittedFrame(
                frame, historicalRecordRetained: retainedR18Frames.contains(index), send: sendHistoryCommand
            )
        }
        startManagedHistoryIfEnabled()
    }

    private func publishOrientation(_ samples: [WhoopImuSample]) {
        orientationProcessor.processSamples(samples) { [weak self] quaternion, euler in
            MainThreadEventEmitter.emit([
                "w": quaternion.w,
                "x": quaternion.x,
                "y": quaternion.y,
                "z": quaternion.z,
                "roll": euler.roll,
                "pitch": euler.pitch,
                "yaw": euler.yaw,
            ]) { payload in
                self?.sendEvent("onOrientation", payload)
            }
        }
    }

    func connectionManager(
        _ manager: WhoopBleConnectionManager,
        didReceiveCommandResponse data: Data
    ) {
        cmdNotificationCount += 1

        let frames = cmdFrameParser.feed(data)
        for frame in frames {
            if !captureSuspended, captureFailure == nil {
                historyOffload.receiveCommandResponse(frame, send: sendHistoryCommand)
            } else {
                historyOffload.stop()
            }
            let responseHex = String(format: "0x%02X", frame.packetType)

            if frame.payload.count >= 3 {
                let commandByte = frame.payload[frame.payload.startIndex + 2]
                let commandHex = String(format: "0x%02X", commandByte)

                if frame.payload.count >= 5 {
                    let statusByte = frame.payload[frame.payload.startIndex + 3]
                    let statusHex = String(format: "0x%02X", statusByte)
                    lastCommandResponse = "\(responseHex) cmd=\(commandHex) status=\(statusHex)"
                    NSLog(
                        "[WhoopBLE] command response: type=%@ cmd=%@ status=%@ payload=%d bytes",
                        responseHex,
                        commandHex,
                        statusHex,
                        frame.payload.count
                    )
                } else {
                    lastCommandResponse = "\(responseHex) cmd=\(commandHex)"
                    NSLog(
                        "[WhoopBLE] command response: type=%@ cmd=%@ payload=%d bytes",
                        responseHex,
                        commandHex,
                        frame.payload.count
                    )
                }
            } else {
                lastCommandResponse = "\(responseHex) (\(frame.payload.count) bytes)"
                NSLog(
                    "[WhoopBLE] command response: type=%@ payload=%d bytes",
                    responseHex,
                    frame.payload.count
                )
            }
        }
        startManagedHistoryIfEnabled()
    }
}

// MARK: - WhoopBleDataWatchdogDelegate

extension WhoopBleModule: WhoopBleDataWatchdogDelegate {
    func watchdogDidDetectSilence(_ watchdog: WhoopBleDataWatchdog, retryCount: UInt64) {
        guard connectionManager.state == .ready || connectionManager.state == .streaming else {
            watchdog.stop()
            return
        }
        guard connectionManager.cmdCharacteristic != nil else {
            watchdog.stop()
            return
        }
        sendActivationCommands(includeImu: connectionManager.state == .streaming)
    }
}
