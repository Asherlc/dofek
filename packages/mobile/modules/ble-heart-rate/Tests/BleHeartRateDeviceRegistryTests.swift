import Foundation
import XCTest
@testable import BleHeartRateLib

final class BleHeartRateDeviceRegistryTests: XCTestCase {
    private let date = Date(timeIntervalSince1970: 1_711_800_000)

    func testRegistersADeviceOnceAndPersistsItsName() {
        let registry = BleHeartRateDeviceRegistry(defaults: makeDefaults())
        registry.register(BleHeartRateDevice(id: "strap-a", name: "Polar H10"))
        registry.register(BleHeartRateDevice(id: "strap-a", name: nil))

        XCTAssertEqual(registry.devices.map(\.id), ["strap-a"])
        XCTAssertEqual(registry.devices.first?.name, "Polar H10")
    }

    func testRecordsOnlyTheMatchingDevicesLatestMeasurement() {
        let registry = BleHeartRateDeviceRegistry(defaults: makeDefaults())
        registry.register(BleHeartRateDevice(id: "strap-a", name: "Polar H10"))
        registry.register(BleHeartRateDevice(id: "strap-b", name: "Wahoo TICKR"))

        registry.recordMeasurement(deviceId: "strap-b", heartRateBpm: 141, rrIntervalsMs: [823], at: date)

        XCTAssertNil(registry.snapshot(id: "strap-a", bufferedSampleCount: 0)?.lastHeartRateBpm)
        XCTAssertEqual(registry.snapshot(id: "strap-b", bufferedSampleCount: 3)?.lastHeartRateBpm, 141)
    }

    func testForgetsOnlyTheRequestedDevice() {
        let registry = BleHeartRateDeviceRegistry(defaults: makeDefaults())
        registry.register(BleHeartRateDevice(id: "strap-a", name: "Polar H10"))
        registry.register(BleHeartRateDevice(id: "strap-b", name: "Wahoo TICKR"))
        registry.remove(id: "strap-a")

        XCTAssertEqual(registry.devices.map(\.id), ["strap-b"])
    }

    func testPersistsLatestMeasurementAcrossRegistryInstances() {
        let defaults = makeDefaults()
        let registry = BleHeartRateDeviceRegistry(defaults: defaults)
        registry.register(BleHeartRateDevice(id: "strap-a", name: "Polar H10"))
        registry.recordMeasurement(deviceId: "strap-a", heartRateBpm: 141, rrIntervalsMs: [823], at: date)

        let restoredRegistry = BleHeartRateDeviceRegistry(defaults: defaults)
        let snapshot = restoredRegistry.snapshot(id: "strap-a", bufferedSampleCount: 3)

        XCTAssertEqual(snapshot?.name, "Polar H10")
        XCTAssertEqual(snapshot?.lastMeasurementAt, date)
        XCTAssertEqual(snapshot?.lastHeartRateBpm, 141)
        XCTAssertEqual(snapshot?.lastRrIntervalsMs, [823])
    }

    private func makeDefaults() -> UserDefaults {
        let suiteName = "BleHeartRateDeviceRegistryTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }
}
