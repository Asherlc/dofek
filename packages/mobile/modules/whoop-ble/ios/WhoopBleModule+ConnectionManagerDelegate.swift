import CoreBluetooth
import Foundation

// MARK: - WhoopBleConnectionManagerDelegate

extension WhoopBleModule: WhoopBleConnectionManagerDelegate {
    func connectionManagerDidBecomeReady(
        _ manager: WhoopBleConnectionManager,
        peripheral: any WhoopBlePeripheralConnection,
        cmdCharacteristic: CBCharacteristic,
        wasStreaming: Bool
    ) {
        publishReadyConnection(
            peripheralId: peripheral.identifier.uuidString,
            peripheralName: peripheral.name,
            wasStreaming: wasStreaming
        )
    }

    /// Publish and activate notification readiness on the connection manager's BLE queue.
    func publishReadyConnection(peripheralId: String, peripheralName: String?, wasStreaming: Bool) {
        guard !captureSuspended, captureFailure == nil else {
            connectionManager.disconnect()
            return
        }
        lastKnownDeviceId = peripheralId
        lastKnownDeviceName = peripheralName
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
            frameParser.reset()
            cmdFrameParser.reset()
        }
    }

    func connectionManagerDidDisconnect(
        _ manager: WhoopBleConnectionManager,
        peripheralId: String,
        error: Error?
    ) {
        watchdog.stop()
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
        guard !captureSuspended, captureFailure == nil else { return }
        guard let deviceId = manager.connectedPeripheral?.identifier.uuidString else { return }

        dataNotificationCount += 1
        captureDiagnostics.recordNotification()
        watchdog.recordDataReceived()

        let frames = frameParser.feed(data)
        totalFramesParsed += UInt64(frames.count)

        var newImuSamples: [WhoopImuSample] = []
        var newRealtimeData: [WhoopRealtimeDataSample] = []
        var newSensorRecords: [[String: Any]] = []
        var deviceInfo = manager.deviceInfo
        if let name = manager.connectedPeripheral?.name, !name.isEmpty { deviceInfo["name"] = String(name.prefix(200)) }

        for frame in frames {
            if let record = WhoopBleSensorRecord.serialize(frame: frame, deviceInfo: deviceInfo) {
                newSensorRecords.append(record)
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

        if newImuSamples.isEmpty && newRealtimeData.isEmpty && newSensorRecords.isEmpty {
            emptyExtractions += 1
            return
        }

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
