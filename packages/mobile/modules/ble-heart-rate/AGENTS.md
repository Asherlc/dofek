# Bluetooth Heart-Rate Agent Guide

Read [README.md](./README.md) first for the supported platform, app
configuration, public API, and upload contract. Read
[`docs/ble-heart-rate.md`](../../../../docs/ble-heart-rate.md) for the wider
mobile-to-server data path.

## Ownership boundaries

- `index.ts` is the TypeScript public API. Keep its method signatures, device
  and sample types, event payloads, and nullability aligned with
  `ios/BleHeartRateModule.swift`.
- `src/BleHeartRateModule.ts` only loads the Expo module. Keep Bluetooth state,
  parsing, buffering, and bridge behavior in Swift.
- `BleHeartRateConnectionManager` owns the queue-confined Core Bluetooth state
  machine: scan, connect, service/characteristic discovery, notification
  readiness, timeout, and disconnect. Do not report readiness before
  `didUpdateNotificationStateFor` confirms notifications.
- Gate operations on `CBCentralManager.state == .poweredOn`; Apple requires the
  powered-on state before central-manager operations. See
  [`CBCentralManager`](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager).
- `BleHeartRateMeasurementParser` owns strict `0x2A37` decoding. Preserve
  little-endian parsing, optional-field offsets, all reported R-R intervals,
  and rejection of truncated packets.
- `BleHeartRateSampleBuffer` owns bounded, thread-safe, device-attributed
  storage. Preserve peek-then-confirm semantics across overflow; never remove
  upload data during a peek or before the caller confirms success.

## Platform and test boundaries

- Keep `NSBluetoothAlwaysUsageDescription` and the optional background-central
  capability in the consuming app, not this module. Use Apple's
  [`NSBluetoothAlwaysUsageDescription`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsbluetoothalwaysusagedescription)
  and [`UIBackgroundModes`](https://developer.apple.com/documentation/bundleresources/information-property-list/uibackgroundmodes)
  references when changing those requirements.
- `Package.swift` excludes `BleHeartRateModule.swift` and the podspec.
  `swift test` validates constants, parser behavior, connection-manager
  compilation, and buffering, but not the Expo bridge or hardware lifecycle.
- Add the failing XCTest first in the matching file under `Tests/`. TypeScript
  surface changes also require the mobile typecheck; bridge changes require an
  iOS development build and physical-device verification.

From this directory:

```sh
swift test
pnpm --dir ../.. typecheck
```
