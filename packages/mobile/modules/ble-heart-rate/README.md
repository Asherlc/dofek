# Bluetooth Heart-Rate Module

Local Expo iOS module for standard Bluetooth Low Energy heart-rate monitors. It
scans for the Bluetooth SIG [Heart Rate Service](https://www.bluetooth.com/specifications/specs/heart-rate-service-1-0/)
(`0x180D`), subscribes to Heart Rate Measurement (`0x2A37`), emits
device-attributed live beats-per-minute and R-R intervals, and buffers samples
for reliable upload.

The Dofek data path and server integration are documented in
[`docs/ble-heart-rate.md`](../../../../docs/ble-heart-rate.md).

## Platform setup

The Expo pod supports iOS 16.4 or later and is registered by
`expo-module.config.json`. A consuming app must provide
[`NSBluetoothAlwaysUsageDescription`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsbluetoothalwaysusagedescription);
Apple requires this purpose string when an app uses the Bluetooth interface.
To continue acting as a Bluetooth central in the background, enable the
[`bluetooth-central` background mode](https://developer.apple.com/documentation/bundleresources/information-property-list/uibackgroundmodes).
Dofek configures both in `packages/mobile/app.json`.

Core Bluetooth operations begin only after `CBCentralManager` reports
`poweredOn`, as required by Apple's
[`CBCentralManager` documentation](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager).

## Usage

```ts
import {
  addHeartRateListener,
  confirmSamplesDrain,
  disconnect,
  peekBufferedSamples,
  scanAndConnect,
} from "./modules/ble-heart-rate";

const subscription = addHeartRateListener((sample) => {
  console.log(sample.heartRateBpm, sample.rrIntervalsMs);
});

const device = await scanAndConnect();

try {
  const samples = await peekBufferedSamples();
  await upload(device.id, samples);
  confirmSamplesDrain(samples.length);
} finally {
  subscription.remove();
  disconnect();
}
```

Only call `confirmSamplesDrain` after a successful upload. A peek does not
remove samples, so a failed upload can retry the same page.

## Public API

- Connection: `isBluetoothAvailable`, `scanAndConnect`, `connect`,
  `getConnectionState`, and `disconnect`.
- Devices: `getDevices`, `forget`, and `addDeviceStateListener`. `getDevices`
  returns persisted app-managed monitor snapshots with their latest native
  measurement, per-device connection state, and buffered-sample count.
- Buffer: `getBufferedSampleCount`, `peekBufferedSamples`, and
  `confirmSamplesDrain`.
- Events: `addConnectionStateListener` and `addHeartRateListener`; remove each
  returned subscription when it is no longer needed.

`scanAndConnect` connects to the first advertising Heart Rate Service device.
`connect` accepts a peripheral UUID returned by an earlier connection and asks
Core Bluetooth for that known peripheral. The connection becomes ready only
after notification subscription succeeds. Connection events report
`connected` or `disconnected` with the peripheral ID and available device name
or error.

Live and buffered samples contain the captured `deviceId`, an ISO 8601 receipt
timestamp, `heartRateBpm`, and an `rrIntervalsMs` array that is empty when the
monitor reports none. The bounded native buffer retains up to 86,400 samples
and defaults to pages of 1,000.

`scanAndConnect` adds a monitor to Dofek's persisted app-managed list. Use
`addDeviceStateListener` to receive each updated device snapshot. Each monitor
has an independent native connection session: `disconnect(peripheralId)` stops
only that monitor, `forget(peripheralId)` removes it from the app-managed list,
and the existing zero-argument `disconnect()` stops every active monitor.

Connection promises reject with specific native codes: `BLUETOOTH_UNAVAILABLE`,
`INVALID_ID`, `NOT_FOUND`, `SCAN_TIMEOUT`, `CONNECT_TIMEOUT`, `NO_SERVICE`,
`NO_CHARACTERISTIC`, `NO_NOTIFY`, `DISCONNECTED`, `BUSY`, or
`DEVICE_NOT_REGISTERED` when `connect` receives an ID outside the persisted
app-managed list.

## Development

`Package.swift` builds the bridge-independent Swift library on macOS 13+ and
iOS 16+. It deliberately excludes the Expo bridge and podspec.

```sh
swift test
pnpm --dir ../.. typecheck
```

The Swift tests cover assigned UUIDs, measurement parsing, and bounded
peek/confirm buffering. TypeScript checking validates the Expo-facing surface;
an iOS development build is still required to validate the native bridge.
