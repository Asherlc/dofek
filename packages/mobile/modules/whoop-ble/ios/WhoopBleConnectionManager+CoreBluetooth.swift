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
                peripheral.discoverServices(WhoopBleConstants.allServiceUUIDs)
                startHandshakeTimeout(for: peripheral)
            } else {
                setState(.connecting)
                centralManager?.connect(peripheral, options: nil)
                startHandshakeTimeout(for: peripheral)
            }
        }
    }

    func handleRestoredPeripheral(_ peripheral: CBPeripheral) {
        setConnectedPeripheral(peripheral)
        peripheral.delegate = bleDelegate
        autoReconnect = true
        wasStreaming = true

        if peripheral.state == .connected {
            setState(.discoveringServices)
            peripheral.discoverServices(WhoopBleConstants.allServiceUUIDs)
            startHandshakeTimeout(for: peripheral)
        }
    }

    func handlePeripheralDiscovered(_ peripheral: CBPeripheral) {
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
            centralManager?.connect(peripheral, options: nil)
            startHandshakeTimeout(for: peripheral)
        }
    }

    func handlePeripheralConnected(_ peripheral: CBPeripheral) {
        NSLog("[WhoopBLE] peripheral connected: %@ (state=%@)",
              peripheral.identifier.uuidString, state.rawValue)
        guard
            state == .connecting,
            connectedPeripheral?.identifier == peripheral.identifier
        else { return }

        setState(.discoveringServices)
        peripheral.discoverServices(WhoopBleConstants.allServiceUUIDs)
    }

    func handlePeripheralDisconnected(_ peripheral: CBPeripheral, error: Error?) {
        NSLog("[WhoopBLE] peripheral disconnected: %@ (wasState=%@, error=%@, autoReconnect=%@)",
              peripheral.identifier.uuidString, state.rawValue,
              error?.localizedDescription ?? "none", autoReconnect ? "true" : "false")
        guard connectedPeripheral?.identifier == peripheral.identifier else {
            NSLog("[WhoopBLE] ignoring stale disconnect for %@", peripheral.identifier.uuidString)
            return
        }

        wasStreaming = state == .streaming
        let shouldReconnect = autoReconnect
        let peripheralId = peripheral.identifier.uuidString

        cleanup()

        delegate?.connectionManagerDidDisconnect(self, peripheralId: peripheralId, error: error)

        finishConnect(.failure(.disconnected(error?.localizedDescription)))

        if shouldReconnect {
            autoReconnect = true
            setState(.connecting)
            setConnectedPeripheral(peripheral)
            peripheral.delegate = bleDelegate
            centralManager?.connect(peripheral, options: nil)
            startHandshakeTimeout(for: peripheral)
        }
    }

    func handleServicesDiscovered(_ peripheral: CBPeripheral) {
        let serviceUUIDs = peripheral.services?.map { $0.uuid.uuidString } ?? []
        NSLog("[WhoopBLE] services discovered: %@", serviceUUIDs.joined(separator: ", "))
        guard
            state == .discoveringServices,
            connectedPeripheral?.identifier == peripheral.identifier
        else { return }

        guard let service = peripheral.services?.first(where: { service in
            WhoopBleConstants.allServiceUUIDs.contains(service.uuid)
        }) else {
            NSLog("[WhoopBLE] NO WHOOP service found among discovered services")
            abortHandshake(for: peripheral, with: .serviceNotFound)
            return
        }

        let cmdUUID = WhoopBleConstants.cmdToStrapUUID(forService: service.uuid)
        let cmdRespUUID = WhoopBleConstants.cmdFromStrapUUID(forService: service.uuid)
        let dataUUID = WhoopBleConstants.dataFromStrapUUID(forService: service.uuid)
        peripheral.discoverCharacteristics([cmdUUID, cmdRespUUID, dataUUID], for: service)
    }

    func handleCharacteristicsDiscovered(_ peripheral: CBPeripheral, service: CBService) {
        let charUUIDs = service.characteristics?.map { $0.uuid.uuidString } ?? []
        NSLog("[WhoopBLE] characteristics discovered for service %@: %@",
              service.uuid.uuidString, charUUIDs.joined(separator: ", "))
        guard
            state == .discoveringServices,
            connectedPeripheral?.identifier == peripheral.identifier
        else { return }

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
            peripheral: peripheral,
            dataCharacteristic: dataChar,
            commandResponseCharacteristic: cmdResponseCharacteristic
        )
        setState(.subscribing)
        peripheral.setNotifyValue(true, for: dataChar)
        if let cmdRespChar = cmdResponseCharacteristic {
            peripheral.setNotifyValue(true, for: cmdRespChar)
        }
    }

    func handleNotificationStateUpdated(
        _ peripheral: CBPeripheral,
        characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard state == .subscribing, var tracker = notificationSubscriptionTracker else {
            return
        }

        let update = tracker.recordNotificationState(
            peripheral: peripheral,
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
            cancelPeripheral: { [weak self, weak peripheral] in
                guard let peripheral else { return }
                self?.centralManager?.cancelPeripheralConnection(peripheral)
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
    func handleNotification(from characteristic: CBCharacteristic, data: Data) {
        if characteristic.uuid == cmdResponseCharacteristic?.uuid {
            delegate?.connectionManager(self, didReceiveCommandResponse: data)
        } else {
            delegate?.connectionManager(self, didReceiveData: data)
        }
    }
}
