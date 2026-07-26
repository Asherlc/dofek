# WhoopBLE

Unofficial Swift client for the reverse-engineered Bluetooth Low Energy
protocol used by WHOOP fitness straps.

WhoopBLE discovers bonded straps, manages CoreBluetooth connections and
reconnection, parses proprietary frames, and exposes typed realtime and IMU
samples through `AsyncStream`.

This project is not affiliated with, endorsed by, or supported by WHOOP. The
protocol is undocumented and may change without notice.

## Requirements

- Swift 5.9 or later
- iOS 16 or later, or macOS 13 or later
- A WHOOP strap already bonded with the operating system

On iOS, add `NSBluetoothAlwaysUsageDescription` to the app's `Info.plist`.
Apps that continue receiving data in the background must also enable the
`bluetooth-central` background mode. See Apple's
[Core Bluetooth background-processing guide](https://developer.apple.com/documentation/corebluetooth/core-bluetooth-background-processing-for-ios-apps)
and [`NSBluetoothAlwaysUsageDescription` documentation](https://developer.apple.com/documentation/bundleresources/information-property-list/nsbluetoothalwaysusagedescription).

## Installation

Add the repository in Xcode's package dependency UI, or declare it in
`Package.swift`:

```swift
dependencies: [
    .package(
        url: "https://github.com/Asherlc/whoop-ble-swift.git",
        from: "0.1.0"
    ),
]
```

Then add `WhoopBLE` to the target's dependencies and import it:

```swift
import WhoopBLE
```

Swift Package Manager resolves Git dependencies from semantic-version tags as
described in the
[SwiftPM package publishing guide](https://docs.swift.org/swiftpm/documentation/packagemanagerdocs/releasingpublishingapackage/).

## Usage

Subscribe before starting a stream so the first samples are not missed:

```swift
import WhoopBLE

let client = WhoopBleClient()

guard let strap = await client.discover() else {
    throw WhoopBleError.bluetoothUnavailable(state: client.bluetoothState)
}

try await client.connect(to: strap)

let sampleTask = Task {
    for await sample in client.realtimeSamples() {
        print(sample.rrIntervalMs, sample.quaternionW)
    }
}

try await client.startRealtimeStreaming()

// Later:
await client.stopStreaming()
client.disconnect()
sampleTask.cancel()
```

IMU streaming uses the same lifecycle:

```swift
let sampleTask = Task {
    for await sample in client.imuSamples() {
        print(sample.accelerometerX, sample.gyroscopeX)
    }
}

try await client.startImuStreaming()
```

## Public API

- `WhoopBleClient` — discovery, connection, state, streaming, and disconnection.
- `WhoopDevice` — a discovered strap's UUID and optional Bluetooth name.
- `WhoopRealtimeDataSample` — timestamp, R-R interval, orientation quaternion,
  and preserved optical bytes.
- `WhoopImuSample` — normalized accelerometer values in g and gyroscope values
  in radians per second.
- `WhoopBleClientState` — connection lifecycle state.
- `WhoopBleError` — actionable connection and streaming failures conforming to
  `LocalizedError`.

The frame parser, characteristic UUIDs, and raw command bytes intentionally
remain internal so applications depend on domain behavior rather than protocol
implementation details.

## Protocol and Stability

The protocol notes, known hardware UUIDs, frame layouts, commands, bonding
requirements, and capture provenance are in
[Documentation/WHOOP-BLE-Protocol.md](Documentation/WHOOP-BLE-Protocol.md).

WHOOP firmware or application updates can change this private protocol.
Applications should surface `WhoopBleError` messages and be prepared for
connection or parsing behavior to change between strap firmware releases.

## License and Contributions

WhoopBLE is available under the [MIT License](LICENSE). The canonical source is
maintained in the
[Dofek monorepo](https://github.com/Asherlc/dofek/tree/main/packages/mobile/modules/whoop-ble);
the [SwiftPM repository](https://github.com/Asherlc/whoop-ble-swift) is an
automated distribution mirror. Report issues and propose changes in the
[Dofek issue tracker](https://github.com/Asherlc/dofek/issues).
