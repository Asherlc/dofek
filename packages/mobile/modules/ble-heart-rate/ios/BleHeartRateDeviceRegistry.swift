import Foundation

struct BleHeartRateDeviceSnapshot: Codable {
    let id: String
    let name: String?
    let connectionState: String
    let lastMeasurementAt: Date?
    let lastHeartRateBpm: Int?
    let lastRrIntervalsMs: [Int]
    let bufferedSampleCount: Int
}

private struct BleHeartRateRegisteredDevice: Codable {
    let id: String
    var name: String?
    var lastMeasurementAt: Date?
    var lastHeartRateBpm: Int?
    var lastRrIntervalsMs: [Int]
}

/// Persists the standard monitors that Dofek has connected to, along with the
/// most recent measurement observed from each monitor.
final class BleHeartRateDeviceRegistry {
    private static let storageKey = "dofek_ble_heart_rate_devices_v1"

    private let defaults: UserDefaults
    private let lock = NSLock()
    private var registeredDevices: [BleHeartRateRegisteredDevice]
    private var connectionStates: [String: String] = [:]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.storageKey),
           let persistedDevices = try? JSONDecoder().decode([BleHeartRateRegisteredDevice].self, from: data)
        {
            registeredDevices = persistedDevices
        } else {
            registeredDevices = []
        }
    }

    var devices: [BleHeartRateDevice] {
        lock.lock()
        defer { lock.unlock() }
        return registeredDevices.map { device in
            BleHeartRateDevice(id: device.id, name: device.name)
        }
    }

    func register(_ device: BleHeartRateDevice) {
        lock.lock()
        defer { lock.unlock() }

        if let index = registeredDevices.firstIndex(where: { $0.id == device.id }) {
            if let name = device.name {
                registeredDevices[index].name = name
            }
        } else {
            registeredDevices.append(
                BleHeartRateRegisteredDevice(
                    id: device.id,
                    name: device.name,
                    lastMeasurementAt: nil,
                    lastHeartRateBpm: nil,
                    lastRrIntervalsMs: []
                )
            )
        }
        persistLocked()
    }

    func recordMeasurement(
        deviceId: String,
        heartRateBpm: Int,
        rrIntervalsMs: [Int],
        at timestamp: Date
    ) {
        lock.lock()
        defer { lock.unlock() }

        guard let index = registeredDevices.firstIndex(where: { $0.id == deviceId }) else {
            return
        }
        registeredDevices[index].lastMeasurementAt = timestamp
        registeredDevices[index].lastHeartRateBpm = heartRateBpm
        registeredDevices[index].lastRrIntervalsMs = rrIntervalsMs
        persistLocked()
    }

    func setConnectionState(_ state: String, for deviceId: String) {
        lock.lock()
        defer { lock.unlock() }
        guard registeredDevices.contains(where: { $0.id == deviceId }) else { return }
        connectionStates[deviceId] = state
    }

    func snapshot(id: String, bufferedSampleCount: Int) -> BleHeartRateDeviceSnapshot? {
        lock.lock()
        defer { lock.unlock() }
        guard let device = registeredDevices.first(where: { $0.id == id }) else {
            return nil
        }
        return BleHeartRateDeviceSnapshot(
            id: device.id,
            name: device.name,
            connectionState: connectionStates[id] ?? BleHeartRateConnectionState.idle.rawValue,
            lastMeasurementAt: device.lastMeasurementAt,
            lastHeartRateBpm: device.lastHeartRateBpm,
            lastRrIntervalsMs: device.lastRrIntervalsMs,
            bufferedSampleCount: bufferedSampleCount
        )
    }

    func remove(id: String) {
        lock.lock()
        defer { lock.unlock() }
        registeredDevices.removeAll { $0.id == id }
        connectionStates.removeValue(forKey: id)
        persistLocked()
    }

    private func persistLocked() {
        guard let data = try? JSONEncoder().encode(registeredDevices) else {
            return
        }
        defaults.set(data, forKey: Self.storageKey)
    }
}
