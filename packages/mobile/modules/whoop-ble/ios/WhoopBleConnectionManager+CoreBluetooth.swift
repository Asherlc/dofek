import CoreBluetooth

extension WhoopBleConnectionManager {
    // MARK: - Internal handlers (called by BleDelegate)

    func handleCentralManagerPoweredOn() {
        NSLog("[WhoopBLE] centralManager poweredOn")

        if let pending = pendingPoweredOnCompletion, let manager = centralManager {
            NSLog("[WhoopBLE] resolving pending findWhoop after poweredOn")
            pendingPoweredOnCompletion = nil
            performFind(manager: manager, completion: pending)
        }

        if connectedPeripheral == nil && pendingPoweredOnCompletion == nil && autoReconnect {
            NSLog("[WhoopBLE] no strap connected, starting background scan for WHOOP")
            centralManager?.scanForPeripherals(
                withServices: WhoopBleConstants.allServiceUUIDs,
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
            )
        }

        if let peripheral = connectedPeripheral, state == .idle {
            if peripheral.state == .connected {
                setState(.discoveringServices)
                peripheral.discoverServices(WhoopBleConstants.connectionServiceUUIDs)
                startHandshakeTimeout(for: peripheral)
            } else {
                setState(.connecting)
                recordConnectionEvent("connect_requested", reason: "powered_on_reconnect")
                peripheral.connect()
                startHandshakeTimeout(for: peripheral)
            }
        }
    }

    func handleRestoredPeripheral(_ peripheral: any WhoopBlePeripheralConnection) {
        setConnectedPeripheral(peripheral)
        peripheral.delegate = bleDelegate
        autoReconnect = true
        wasStreaming = true

        if peripheral.state == .connected {
            setState(.discoveringServices)
            peripheral.discoverServices(WhoopBleConstants.connectionServiceUUIDs)
            startHandshakeTimeout(for: peripheral)
        } else if peripheral.state == .connecting {
            setState(.connecting)
            startHandshakeTimeout(for: peripheral)
        }
    }

    func handlePeripheralDiscovered(_ peripheral: any WhoopBlePeripheralConnection) {
        if state == .scanning {
            centralManager?.stopScan()
            setState(.idle)

            let result: [String: Any?] = [
                "id": peripheral.identifier.uuidString,
                "name": peripheral.name,
            ]
            findCompletion?(result)
            findCompletion = nil
            return
        }

        if connectedPeripheral == nil && autoReconnect {
            NSLog("[WhoopBLE] background scan found WHOOP strap %@ (%@), auto-connecting",
                  peripheral.identifier.uuidString, peripheral.name ?? "unnamed")
            centralManager?.stopScan()
            setConnectedPeripheral(peripheral)
            peripheral.delegate = bleDelegate
            setState(.connecting)
            recordConnectionEvent("connect_requested", reason: "scan_reconnect")
            peripheral.connect()
            startHandshakeTimeout(for: peripheral)
        }
    }

    func handlePeripheralConnected(_ peripheral: any WhoopBlePeripheralConnection) {
        NSLog("[WhoopBLE] peripheral connected: %@ (state=%@)",
              peripheral.identifier.uuidString, state.rawValue)
        guard
            state == .connecting,
            connectedPeripheral?.notificationSource === peripheral.notificationSource
        else { return }

        setState(.discoveringServices)
        peripheral.discoverServices(WhoopBleConstants.connectionServiceUUIDs)
        if connectCompletion == nil {
            startHandshakeTimeout(for: peripheral)
        }
    }

    func handlePeripheralDisconnected(_ peripheral: any WhoopBlePeripheralConnection, error: Error?) {
        NSLog("[WhoopBLE] peripheral disconnected: %@ (wasState=%@, error=%@, autoReconnect=%@)",
              peripheral.identifier.uuidString, state.rawValue,
              error?.localizedDescription ?? "none", autoReconnect ? "true" : "false")
        guard connectedPeripheral?.notificationSource === peripheral.notificationSource else {
            NSLog("[WhoopBLE] ignoring stale disconnect for %@", peripheral.identifier.uuidString)
            return
        }

        handleDisconnection(peripheralId: peripheral.identifier.uuidString, error: error) {
            setConnectedPeripheral(peripheral)
            peripheral.delegate = bleDelegate
            peripheral.connect()
            startHandshakeTimeout(for: peripheral)
        }
    }

    /// Settle the disconnected session before reconnecting its peripheral.
    func handleDisconnection(
        peripheralId: String,
        error: Error?,
        reconnectPeripheral: () -> Void
    ) {
        recordConnectionEvent("disconnected", peripheralId: peripheralId, error: error)
        wasStreaming = wasStreaming || state == .streaming
        let shouldReconnect = autoReconnect
        let isRecoveryCancellation = state == .disconnecting && shouldReconnect

        cleanup()

        publishDisconnection(peripheralId: peripheralId, error: error)
        // Entering .disconnecting already settled the owner via finishConnect; only
        // waiters that joined during native cancellation remain, and those belong to
        // the automatic reconnect this disconnect precedes.
        if !isRecoveryCancellation {
            finishConnect(.failure(.disconnected(error?.localizedDescription)))
        }

        if shouldReconnect {
            autoReconnect = true
            setState(.connecting)
            recordConnectionEvent("connect_requested", peripheralId: peripheralId, reason: "automatic_reconnect")
            reconnectPeripheral()
        }
    }

    func publishDisconnection(peripheralId: String, error: Error?) {
        WhoopBleConnectionEvent.disconnected.post()
        delegate?.connectionManagerDidDisconnect(self, peripheralId: peripheralId, error: error)
    }

    func handleServicesDiscovered(_ peripheral: any WhoopBlePeripheralConnection) {
        let serviceUUIDs = peripheral.services?.map { $0.uuid.uuidString } ?? []
        NSLog("[WhoopBLE] services discovered: %@", serviceUUIDs.joined(separator: ", "))
        guard
            state == .discoveringServices,
            connectedPeripheral?.notificationSource === peripheral.notificationSource
        else { return }

        if let information = peripheral.services?.first(where: { $0.uuid == WhoopBleConstants.deviceInformationServiceUUID }) {
            peripheral.discoverCharacteristics(["2A24", "2A25", "2A26", "2A27"].map(CBUUID.init(string:)), for: information)
        }
        guard let service = peripheral.services?.first(where: { service in
            WhoopBleConstants.allServiceUUIDs.contains(service.uuid)
        }) else {
            NSLog("[WhoopBLE] NO WHOOP service found among discovered services")
            abortHandshake(for: peripheral, with: .serviceNotFound)
            return
        }

        whoopService = service
        let cmdUUID = WhoopBleConstants.cmdToStrapUUID(forService: service.uuid)
        let cmdRespUUID = WhoopBleConstants.cmdFromStrapUUID(forService: service.uuid)
        let dataUUID = WhoopBleConstants.dataFromStrapUUID(forService: service.uuid)
        peripheral.discoverCharacteristics([cmdUUID, cmdRespUUID, dataUUID], for: service)

        // Harvard's standard Battery Level characteristic reports a stub.
        if service.uuid != WhoopBleConstants.gen4ServiceUUID,
           let battery = peripheral.services?.first(where: { $0.uuid == WhoopBleConstants.batteryServiceUUID }) {
            batteryService = battery
            peripheral.discoverCharacteristics([WhoopBleConstants.batteryLevelUUID], for: battery)
        }
    }

    func handleCharacteristicsDiscovered(
        _ peripheral: any WhoopBlePeripheralConnection, service: CBService, error: Error? = nil
    ) {
        guard connectedPeripheral?.notificationSource === peripheral.notificationSource else { return }
        if service === batteryService {
            handleBatteryLevelDiscovery(peripheral, service: service, error: error)
            return
        }
        if service === whoopService, state != .discoveringServices {
            handleBatteryEventDiscovery(peripheral, service: service, error: error)
            return
        }
        let isDeviceInformation = service.uuid == WhoopBleConstants.deviceInformationServiceUUID
        guard service === whoopService || isDeviceInformation else { return }
        if let error {
            NSLog("[WhoopBLE] characteristic discovery error: %@", error.localizedDescription)
            handleCharacteristicDiscoveryError(serviceUUID: service.uuid, error: error) {
                peripheral.cancelConnection()
            }
            return
        }
        if isDeviceInformation {
            for characteristic in service.characteristics ?? [] where characteristic.properties.contains(.read) {
                peripheral.readValue(for: characteristic)
            }
            return
        }
        let charUUIDs = service.characteristics?.map { $0.uuid.uuidString } ?? []
        NSLog("[WhoopBLE] characteristics discovered for service %@: %@",
              service.uuid.uuidString, charUUIDs.joined(separator: ", "))
        guard state == .discoveringServices else { return }

        let cmdUUID = WhoopBleConstants.cmdToStrapUUID(forService: service.uuid)
        let cmdRespUUID = WhoopBleConstants.cmdFromStrapUUID(forService: service.uuid)
        let dataUUID = WhoopBleConstants.dataFromStrapUUID(forService: service.uuid)

        setDiscoveredCharacteristics(
            cmdCharacteristic: service.characteristics?.first { $0.uuid == cmdUUID },
            cmdResponseCharacteristic: service.characteristics?.first { $0.uuid == cmdRespUUID },
            dataCharacteristic: service.characteristics?.first { $0.uuid == dataUUID }
        )

        guard cmdCharacteristic != nil, let dataChar = dataCharacteristic else {
            NSLog("[WhoopBLE] missing characteristics: cmd=%@, data=%@",
                  cmdCharacteristic == nil ? "MISSING" : "found",
                  dataCharacteristic == nil ? "MISSING" : "found")
            abortHandshake(for: peripheral, with: .characteristicsNotFound)
            return
        }

        NSLog("[WhoopBLE] subscribing to DATA_FROM_STRAP + CMD_FROM_STRAP notifications")
        notificationSubscriptionTracker = WhoopBleNotificationSubscriptionTracker(
            peripheral: peripheral.notificationSource,
            dataCharacteristic: dataChar,
            commandResponseCharacteristic: cmdResponseCharacteristic
        )
        setState(.subscribing)
        peripheral.setNotifyValue(true, for: dataChar)
        if let cmdRespChar = cmdResponseCharacteristic {
            peripheral.setNotifyValue(true, for: cmdRespChar)
        }
        // A separate request keeps optional event discovery failures out of the handshake.
        peripheral.discoverCharacteristics([WhoopBleConstants.eventUUID(forService: service.uuid)], for: service)
    }

    func handleNotificationStateUpdated(
        _ peripheral: any WhoopBlePeripheralConnection,
        characteristic: CBCharacteristic,
        error: Error?
    ) {
        if characteristic === batteryLevelCharacteristic || characteristic === batteryEventCharacteristic {
            guard connectedPeripheral?.notificationSource === peripheral.notificationSource else { return }
            if let error {
                recordConnectionEvent("battery_subscription_failed", error: error)
            }
            return
        }
        guard state == .subscribing, var tracker = notificationSubscriptionTracker else {
            return
        }

        let update = tracker.recordNotificationState(
            peripheral: peripheral.notificationSource,
            characteristic: characteristic,
            isNotifying: characteristic.isNotifying,
            hasError: error != nil
        )
        notificationSubscriptionTracker = tracker

        let detail = error?.localizedDescription
            ?? "Notifications are not active for \(characteristic.uuid.uuidString)"
        let previouslyStreaming = settleNotificationSubscriptionUpdate(
            update,
            failureDetail: detail,
            underlyingError: error,
            cancelPeripheral: {
                peripheral.cancelConnection()
            }
        )

        if update == .failed {
            NSLog("[WhoopBLE] notification subscription failed on %@: %@",
                  characteristic.uuid.uuidString, detail)
        }

        guard
            let previouslyStreaming,
            let cmdChar = cmdCharacteristic
        else {
            return
        }

        delegate?.connectionManagerDidBecomeReady(
            self, peripheral: peripheral, cmdCharacteristic: cmdChar,
            wasStreaming: previouslyStreaming
        )
    }

    /// Route a BLE notification to the appropriate delegate callback.
    func handleNotification(from peripheral: AnyObject, characteristic: CBCharacteristic, data: Data) {
        guard connectedPeripheral?.notificationSource === peripheral else { return }
        if handleBatteryValue(characteristic: characteristic, data: data) { return }
        if recordDeviceInformation(uuid: characteristic.uuid.uuidString, data: data) { return }
        if characteristic.uuid == cmdResponseCharacteristic?.uuid {
            delegate?.connectionManager(self, didReceiveCommandResponse: data)
        } else {
            delegate?.connectionManager(self, didReceiveData: data)
        }
    }
}
