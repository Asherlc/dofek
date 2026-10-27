import CoreBluetooth
import Foundation

// MARK: - CBCentralManagerDelegate

extension BleHeartRateConnectionManager: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            if pendingScan {
                startScan(central)
            }
            let pendingIds = Array(pendingBluetoothConnects)
            pendingBluetoothConnects.removeAll()
            for id in pendingIds {
                guard let session = sessions[id] else { continue }
                performConnect(id: id, session: session, manager: central)
            }
            return
        case .unknown, .resetting:
            return
        default:
            break
        }

        if pendingScan || scanState != .idle {
            cancelScan(with: .bluetoothUnavailable)
        }

        for id in Array(sessions.keys) {
            guard let session = sessions[id] else { continue }
            let wasReady = session.state == .ready
            markDisconnected(session)
            completeConnect(id: id, with: .failure(.bluetoothUnavailable))
            pendingBluetoothConnects.remove(id)
            sessions.removeValue(forKey: id)
            peripherals.removeValue(forKey: id)
            if wasReady {
                delegate?.connectionManagerDidDisconnect(
                    self,
                    peripheralId: id.uuidString,
                    error: nil
                )
            }
        }
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard scanState == .scanning else { return }
        let id = peripheral.identifier
        guard sessions[id] == nil, peripherals[id] == nil else { return }
        guard let completion = takeScanCompletion(manager: central) else { return }

        let session = BleHeartRatePeripheralSession(id: id.uuidString)
        sessions[id] = session
        connectCompletions[id] = completion
        beginConnecting(to: peripheral, session: session, manager: central)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard
            isManaged(peripheral),
            let session = sessions[peripheral.identifier],
            session.state == .connecting
        else { return }
        setState(.discoveringServices, for: session)
        peripheral.discoverServices([BleHeartRateConstants.heartRateServiceUUID])
    }

    func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        let id = peripheral.identifier
        guard isManaged(peripheral), let session = sessions[id] else { return }
        markDisconnected(session)
        completeConnect(id: id, with: .failure(.disconnected(error?.localizedDescription)))
        sessions.removeValue(forKey: id)
        peripherals.removeValue(forKey: id)
    }

    func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        let id = peripheral.identifier
        guard isManaged(peripheral), let session = sessions[id] else { return }
        markDisconnected(session)
        completeConnect(
            id: id,
            with: .failure(.disconnected(error?.localizedDescription))
        )
        sessions.removeValue(forKey: id)
        peripherals.removeValue(forKey: id)
        delegate?.connectionManagerDidDisconnect(
            self,
            peripheralId: id.uuidString,
            error: error
        )
    }
}
