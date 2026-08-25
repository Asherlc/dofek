import Foundation
import XCTest
@testable import BleHeartRateLib

final class BleHeartRateDeviceRegistryTests: XCTestCase {
    private let date = Date(timeIntervalSince1970: 1_711_800_000)

    func testRegistersADeviceOnceAndPersistsItsName() throws {
        let registry = try BleHeartRateDeviceRegistry(defaults: makeDefaults())
        try registry.register(BleHeartRateDevice(id: "strap-a", name: "Polar H10"))
        try registry.register(BleHeartRateDevice(id: "strap-a", name: nil))

        XCTAssertEqual(registry.devices.map(\.id), ["strap-a"])
        XCTAssertEqual(registry.devices.first?.name, "Polar H10")
    }

    func testRecordsOnlyTheMatchingDevicesLatestMeasurement() throws {
        let registry = try BleHeartRateDeviceRegistry(defaults: makeDefaults())
        try registry.register(BleHeartRateDevice(id: "strap-a", name: "Polar H10"))
        try registry.register(BleHeartRateDevice(id: "strap-b", name: "Wahoo TICKR"))

        try registry.recordMeasurement(deviceId: "strap-b", heartRateBpm: 141, rrIntervalsMs: [823], at: date)

        XCTAssertNil(registry.snapshot(id: "strap-a", bufferedSampleCount: 0)?.lastHeartRateBpm)
        XCTAssertEqual(registry.snapshot(id: "strap-b", bufferedSampleCount: 3)?.lastHeartRateBpm, 141)
    }

    func testForgetsOnlyTheRequestedDevice() throws {
        let registry = try BleHeartRateDeviceRegistry(defaults: makeDefaults())
        try registry.register(BleHeartRateDevice(id: "strap-a", name: "Polar H10"))
        try registry.register(BleHeartRateDevice(id: "strap-b", name: "Wahoo TICKR"))
        try registry.remove(id: "strap-a")

        XCTAssertEqual(registry.devices.map(\.id), ["strap-b"])
    }

    func testPersistsLatestMeasurementAcrossRegistryInstances() throws {
        let defaults = makeDefaults()
        let registry = try BleHeartRateDeviceRegistry(defaults: defaults)
        try registry.register(BleHeartRateDevice(id: "strap-a", name: "Polar H10"))
        try registry.recordMeasurement(deviceId: "strap-a", heartRateBpm: 141, rrIntervalsMs: [823], at: date)

        let restoredRegistry = try BleHeartRateDeviceRegistry(defaults: defaults)
        let snapshot = restoredRegistry.snapshot(id: "strap-a", bufferedSampleCount: 3)

        XCTAssertEqual(snapshot?.name, "Polar H10")
        XCTAssertEqual(snapshot?.lastMeasurementAt, date)
        XCTAssertEqual(snapshot?.lastHeartRateBpm, 141)
        XCTAssertEqual(snapshot?.lastRrIntervalsMs, [823])
    }

    func testClearRemovesPersistedDevicesAndMeasurements() throws {
        let defaults = makeDefaults()
        let registry = try BleHeartRateDeviceRegistry(defaults: defaults)
        try registry.register(BleHeartRateDevice(id: "strap-a", name: "Polar H10"))
        try registry.recordMeasurement(deviceId: "strap-a", heartRateBpm: 141, rrIntervalsMs: [823], at: date)

        try registry.clear()

        XCTAssertTrue(registry.devices.isEmpty)
        XCTAssertTrue(try BleHeartRateDeviceRegistry(defaults: defaults).devices.isEmpty)
    }

    func testRejectsCorruptPersistedDeviceMetadata() {
        let defaults = makeDefaults()
        defaults.set(Data([0x00]), forKey: "dofek_ble_heart_rate_devices_v1")

        XCTAssertThrowsError(try BleHeartRateDeviceRegistry(defaults: defaults)) { error in
            XCTAssertEqual(error as? BleHeartRateDeviceRegistryError, .decodeFailed)
        }
    }

    func testLeavesRegistryUnchangedWhenMetadataPersistenceFails() throws {
        let codec = BleHeartRateDeviceRegistryCodec(
            decode: { data in try JSONDecoder().decode([BleHeartRateRegisteredDevice].self, from: data) },
            encode: { _ in throw TestPersistenceError.encodingFailed }
        )
        let registry = try BleHeartRateDeviceRegistry(defaults: makeDefaults(), codec: codec)

        XCTAssertThrowsError(
            try registry.register(BleHeartRateDevice(id: "strap-a", name: "Polar H10"))
        ) { error in
            XCTAssertEqual(error as? BleHeartRateDeviceRegistryError, .encodeFailed)
        }
        XCTAssertTrue(registry.devices.isEmpty)
    }

    private func makeDefaults() -> UserDefaults {
        let suiteName = "BleHeartRateDeviceRegistryTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }

    private enum TestPersistenceError: Error {
        case encodingFailed
    }
}
