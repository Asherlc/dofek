import CoreBluetooth

extension WhoopBleConnectionManager {
    private var canAcquireBattery: Bool {
        guard connectedPeripheral?.state == .connected else { return false }
        return state == .discoveringServices || state == .subscribing || state == .ready || state == .streaming
    }

    func handleBatteryLevelDiscovery(
        _ peripheral: any WhoopBlePeripheralConnection, service: CBService, error: Error?
    ) {
        guard canAcquireBattery, batteryLevelCharacteristic == nil else { return }
        if let error {
            recordConnectionEvent("battery_level_discovery_failed", error: error)
            return
        }
        guard let level = service.characteristics?.first(where: { $0.uuid == WhoopBleConstants.batteryLevelUUID })
        else { return }
        batteryLevelCharacteristic = level
        if level.properties.contains(.read) {
            peripheral.readValue(for: level)
        }
        if level.properties.contains(.notify) {
            peripheral.setNotifyValue(true, for: level)
        }
    }

    func handleBatteryEventDiscovery(
        _ peripheral: any WhoopBlePeripheralConnection, service: CBService, error: Error?
    ) {
        guard canAcquireBattery, batteryEventCharacteristic == nil else { return }
        if let error {
            recordConnectionEvent("battery_event_discovery_failed", error: error)
            return
        }
        let uuid = WhoopBleConstants.eventUUID(forService: service.uuid)
        guard let event = service.characteristics?.first(where: { $0.uuid == uuid }),
              event.properties.contains(.notify) || event.properties.contains(.indicate) else { return }
        batteryEventCharacteristic = event
        peripheral.setNotifyValue(true, for: event)
    }

    /// Consume known battery channels even when an old characteristic sends a late value.
    func handleBatteryValue(characteristic: CBCharacteristic, data: Data) -> Bool {
        if characteristic.uuid == WhoopBleConstants.batteryLevelUUID {
            if canAcquireBattery, characteristic === batteryLevelCharacteristic,
               data.count == 1, let level = data.first, level <= 100 {
                mergeBatteryUpdate(WhoopBleBatteryStatus(percentage: Double(level)))
            }
            return true
        }
        guard WhoopBleConstants.eventCharacteristicUUIDs.contains(characteristic.uuid) else { return false }
        if canAcquireBattery, characteristic === batteryEventCharacteristic {
            for frame in batteryEventParser.feed(data) {
                if let update = WhoopBleFrameParser.extractBatteryStatus(from: frame) {
                    mergeBatteryUpdate(update)
                }
            }
        }
        return true
    }

    private func mergeBatteryUpdate(_ update: WhoopBleBatteryStatus) {
        setBatteryStatus(WhoopBleBatteryStatus(
            percentage: update.percentage ?? batteryStatus.percentage,
            isCharging: update.isCharging ?? batteryStatus.isCharging
        ))
    }
}
