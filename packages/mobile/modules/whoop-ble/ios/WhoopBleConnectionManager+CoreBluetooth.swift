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
            } else {
                setState(.connecting)
                centralManager?.connect(peripheral, options: nil)
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

            bleQueue.asyncAfter(deadline: .now() + 10) { [weak self] in
                guard let self = self, self.state == .connecting,
                      self.connectedPeripheral?.identifier == peripheral.identifier else { return }
                NSLog("[WhoopBLE] auto-connect timeout for %@", peripheral.identifier.uuidString)
                self.centralManager?.cancelPeripheralConnection(peripheral)
            }
        }
    }

    func handlePeripheralConnected(_ peripheral: CBPeripheral) {
        NSLog("[WhoopBLE] peripheral connected: %@ (state=%@)",
              peripheral.identifier.uuidString, state.rawValue)
        guard state == .connecting else { return }

        setState(.discoveringServices)
        peripheral.discoverServices(WhoopBleConstants.allServiceUUIDs)
    }

    func handlePeripheralDisconnected(_ peripheral: CBPeripheral, error: Error?) {
        NSLog("[WhoopBLE] peripheral disconnected: %@ (wasState=%@, error=%@, autoReconnect=%@)",
              peripheral.identifier.uuidString, state.rawValue,
              error?.localizedDescription ?? "none", autoReconnect ? "true" : "false")

        wasStreaming = state == .streaming
        let shouldReconnect = autoReconnect
        let peripheralId = peripheral.identifier.uuidString

        cleanup()

        delegate?.connectionManagerDidDisconnect(self, peripheralId: peripheralId, error: error)

        connectCompletion?(.failure(.disconnected(error?.localizedDescription)))
        connectCompletion = nil

        if shouldReconnect {
            autoReconnect = true
            setState(.connecting)
            setConnectedPeripheral(peripheral)
            peripheral.delegate = bleDelegate
            centralManager?.connect(peripheral, options: nil)
        }
    }

    func handleServicesDiscovered(_ peripheral: CBPeripheral) {
        let serviceUUIDs = peripheral.services?.map { $0.uuid.uuidString } ?? []
        NSLog("[WhoopBLE] services discovered: %@", serviceUUIDs.joined(separator: ", "))
        guard state == .discoveringServices else { return }

        guard let service = peripheral.services?.first(where: { service in
            WhoopBleConstants.allServiceUUIDs.contains(service.uuid)
        }) else {
            NSLog("[WhoopBLE] NO WHOOP service found among discovered services")
            connectCompletion?(.failure(.serviceNotFound))
            connectCompletion = nil
            setState(.idle)
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
        guard state == .discoveringServices else { return }

        let cmdUUID = WhoopBleConstants.cmdToStrapUUID(forService: service.uuid)
        let cmdRespUUID = WhoopBleConstants.cmdFromStrapUUID(forService: service.uuid)
        let dataUUID = WhoopBleConstants.dataFromStrapUUID(forService: service.uuid)

        setDiscoveredCharacteristics(
            cmdCharacteristic: service.characteristics?.first { $0.uuid == cmdUUID },
            cmdResponseCharacteristic: service.characteristics?.first { $0.uuid == cmdRespUUID },
            dataCharacteristic: service.characteristics?.first { $0.uuid == dataUUID }
        )

        guard let cmdChar = cmdCharacteristic, let dataChar = dataCharacteristic else {
            NSLog("[WhoopBLE] missing characteristics: cmd=%@, data=%@",
                  cmdCharacteristic == nil ? "MISSING" : "found",
                  dataCharacteristic == nil ? "MISSING" : "found")
            connectCompletion?(.failure(.characteristicsNotFound))
            connectCompletion = nil
            setState(.idle)
            return
        }

        NSLog("[WhoopBLE] subscribing to DATA_FROM_STRAP + CMD_FROM_STRAP notifications")
        peripheral.setNotifyValue(true, for: dataChar)
        if let cmdRespChar = cmdResponseCharacteristic {
            peripheral.setNotifyValue(true, for: cmdRespChar)
        }

        setState(.ready)
        let previouslyStreaming = wasStreaming
        wasStreaming = false

        connectCompletion?(.success(true))
        connectCompletion = nil

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
