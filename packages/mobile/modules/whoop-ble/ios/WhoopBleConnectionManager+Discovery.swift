import CoreBluetooth

extension WhoopBleConnectionManager {
    @discardableResult
    func ensureCentralManager() -> CBCentralManager {
        if let existing = centralManager {
            return existing
        }

        let manager = CBCentralManager(
            delegate: bleDelegate,
            queue: bleQueue,
            options: [
                CBCentralManagerOptionShowPowerAlertKey: false,
                CBCentralManagerOptionRestoreIdentifierKey: Self.restoreIdentifier,
            ]
        )
        centralManager = manager
        return manager
    }

    func performFind(
        manager: CBCentralManager,
        completion: @escaping ([String: Any?]?) -> Void
    ) {
        NSLog("[WhoopBLE] performFind: checking already-connected peripherals")
        for serviceUUID in WhoopBleConstants.allServiceUUIDs {
            let connected = manager.retrieveConnectedPeripherals(withServices: [serviceUUID])
            if let peripheral = connected.first {
                NSLog("[WhoopBLE] performFind: found connected peripheral %@ (%@)",
                      peripheral.identifier.uuidString, peripheral.name ?? "unnamed")
                completion([
                    "id": peripheral.identifier.uuidString,
                    "name": peripheral.name,
                ])
                return
            }
        }

        NSLog("[WhoopBLE] performFind: no connected peripheral found, scanning for 5s")
        findCompletion = completion
        setState(.scanning)
        manager.scanForPeripherals(
            withServices: WhoopBleConstants.allServiceUUIDs,
            options: nil
        )

        bleQueue.asyncAfter(deadline: .now() + 5) {
            if self.state == .scanning {
                NSLog("[WhoopBLE] performFind: scan timed out, no WHOOP found")
                manager.stopScan()
                self.setState(.idle)
                self.findCompletion?(nil)
                self.findCompletion = nil
            }
        }
    }
}
