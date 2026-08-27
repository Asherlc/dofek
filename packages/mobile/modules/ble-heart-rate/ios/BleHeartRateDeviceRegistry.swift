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

struct BleHeartRateRegisteredDevice: Codable {
    let id: String
    var name: String?
    var lastMeasurementAt: Date?
    var lastHeartRateBpm: Int?
    var lastRrIntervalsMs: [Int]
}

enum BleHeartRateDeviceRegistryError: Error, Equatable, LocalizedError {
    case decodeFailed
    case encodeFailed
    case unavailable

    var errorDescription: String? {
        switch self {
        case .decodeFailed:
            "Could not load saved Bluetooth heart-rate monitors"
        case .encodeFailed:
            "Could not save Bluetooth heart-rate monitor state"
        case .unavailable:
            "Bluetooth heart-rate monitor state is unavailable"
        }
    }
}

struct BleHeartRateDeviceRegistryCodec {
    let decode: (Data) throws -> [BleHeartRateRegisteredDevice]
    let encode: ([BleHeartRateRegisteredDevice]) throws -> Data

    static let json = Self(
        decode: { data in
            try JSONDecoder().decode([BleHeartRateRegisteredDevice].self, from: data)
        },
        encode: { devices in
            try JSONEncoder().encode(devices)
        }
    )
}

/// Persists the standard monitors that Dofek has connected to, along with the
/// most recent measurement observed from each monitor.
final class BleHeartRateDeviceRegistry {
    private static let storageKey = "dofek_ble_heart_rate_devices_v1"

    private let defaults: UserDefaults
    private let codec: BleHeartRateDeviceRegistryCodec
    private let lock = NSLock()
    private var registeredDevices: [BleHeartRateRegisteredDevice]
    private var connectionStates: [String: String] = [:]

    init(
        defaults: UserDefaults = .standard,
        codec: BleHeartRateDeviceRegistryCodec = .json
    ) throws {
        self.defaults = defaults
        self.codec = codec
        if let data = defaults.data(forKey: Self.storageKey) {
            do {
                registeredDevices = try codec.decode(data)
            } catch {
                throw BleHeartRateDeviceRegistryError.decodeFailed
            }
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

    func contains(id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return registeredDevices.contains(where: { $0.id == id })
    }

    func register(_ device: BleHeartRateDevice) throws {
        lock.lock()
        defer { lock.unlock() }

        var updatedDevices = registeredDevices
        if let index = updatedDevices.firstIndex(where: { $0.id == device.id }) {
            if let name = device.name {
                updatedDevices[index].name = name
            }
        } else {
            updatedDevices.append(
                BleHeartRateRegisteredDevice(
                    id: device.id,
                    name: device.name,
                    lastMeasurementAt: nil,
                    lastHeartRateBpm: nil,
                    lastRrIntervalsMs: []
                )
            )
        }
        try persistLocked(updatedDevices)
    }

    func recordMeasurement(
        deviceId: String,
        heartRateBpm: Int,
        rrIntervalsMs: [Int],
        at timestamp: Date
    ) throws {
        lock.lock()
        defer { lock.unlock() }

        guard let index = registeredDevices.firstIndex(where: { $0.id == deviceId }) else {
            return
        }
        var updatedDevices = registeredDevices
        updatedDevices[index].lastMeasurementAt = timestamp
        updatedDevices[index].lastHeartRateBpm = heartRateBpm
        updatedDevices[index].lastRrIntervalsMs = rrIntervalsMs
        try persistLocked(updatedDevices)
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

    func remove(id: String) throws {
        lock.lock()
        defer { lock.unlock() }
        try persistLocked(registeredDevices.filter { $0.id != id })
        connectionStates.removeValue(forKey: id)
    }

    func clear() throws {
        lock.lock()
        defer { lock.unlock() }
        try persistLocked([])
        connectionStates.removeAll()
    }

    private func persistLocked(_ devices: [BleHeartRateRegisteredDevice]) throws {
        let data: Data
        do {
            data = try codec.encode(devices)
        } catch {
            throw BleHeartRateDeviceRegistryError.encodeFailed
        }
        defaults.set(data, forKey: Self.storageKey)
        registeredDevices = devices
    }
}
