# @dofek/oura-ble

Pair and sync an Oura Ring over Bluetooth from an iPhone. The root export
provides a platform-independent TypeScript contract. The `/expo` export
implements it for iOS using CoreBluetooth and the open-source
[`open_oura`](https://github.com/Th0rgal/open_oura/tree/4f7957d3304c4084f0e1e703f3d84606bf10b781)
Rust libraries.

## Requirements

- An iOS 16.4+ development or production build with Expo modules, using Expo 58 and
  React Native 0.88 as the compatibility baseline. The package ships an ARM64
  iOS device library and a universal iOS simulator library. Pairing and sync
  require an iPhone with Bluetooth.
- A new or factory-reset ring. Upstream demonstrated pairing and sync with
  a Gen 3 Horizon. This package is experimental and its own physical-ring
  verification is pending. [Upstream hardware test](https://github.com/Th0rgal/open_health/pull/3)

Install the package and rebuild the app so Expo can link its CocoaPods module.
Add an `NSBluetoothAlwaysUsageDescription` string to the app's
`expo.ios.infoPlist` configuration, or to `Info.plist` in a native React
Native host. [Expo autolinking](https://docs.expo.dev/modules/autolinking/) ·
[Apple Bluetooth usage description](https://developer.apple.com/documentation/bundleresources/information-property-list/nsbluetoothalwaysusagedescription)

```sh
pnpm add @dofek/oura-ble
```

## Pair and sync

If the ring is already paired, sync any data you want to keep in the Oura app
before choosing whether to reset it. A factory reset erases data and
credentials stored on the ring. Place the ring on its charger when preparing
it for setup. [Oura factory reset instructions](https://support.ouraring.com/hc/en-us/articles/360025446854-Factory-Reset-an-Oura-Product)

```ts
import { createExpoOuraClient } from "@dofek/oura-ble/expo";

const oura = createExpoOuraClient();
const nearbyRings = await oura.discoverRings();

// Show nearbyRings in your UI and have the user select a ring.
async function pairAndSync(selectedPeripheralId: string) {
  const pairing = await oura.pairRing(selectedPeripheralId, {
    requestedMeasurements: ["heart_rate", "spo2"],
  });
  const sync = await oura.syncRing(pairing.ringId);
  const firstPage = await oura.readEvents(pairing.ringId);
  return { pairing, sync, firstPage };
}
```

- `pairRing` creates a key on the iPhone and stores it in the Keychain.
  Retry pairing for the same ring after a disconnect to recover a key that
  the ring may already have installed. Save the returned `ringId` for later
  syncs. The `measurementOutcomes` entries report whether the ring accepted
  each requested setting. Omit `requestedMeasurements` to leave those
  settings alone. [Upstream measurement commands](https://github.com/Th0rgal/open_oura/blob/4f7957d3304c4084f0e1e703f3d84606bf10b781/crates/README.md#commands)
- `syncRing` runs in the foreground and returns the count of newly stored
  records. It commits each complete batch with the ring cursor and resumes
  from the saved checkpoint. `warnings` reports ring preparation issues
  such as unavailable sleep processing or missing clock anchors. Await each
  operation before starting another.
- `readEvents` uses `{ pageToken: previousPage.nextPageToken }` to continue
  reading until `nextPageToken` is `null`. Each event contains a raw tag and
  base64 payload, a millisecond ring timestamp, and the host capture time.
  Ring-supplied clock anchors are included in the stream when available.
  Consumers can use those to resolve observation times. Decoded fields depend
  on the event type.
- `forgetRing` deletes the application's copy of the events, sync cursor,
  and pairing credentials. When the ring confirms that it has been factory-reset,
  discovery and pairing create a new ring ID. The old ID retains its local history
  until explicitly forgotten.

## Build from source

Building the native artifact requires an Apple silicon Mac with Xcode,
Rust 1.100.0 and its `aarch64-apple-ios`, `aarch64-apple-ios-sim`, and
`x86_64-apple-ios` targets,
and `cargo-about` 0.9.3 installed with the `cli` feature.
Run `pnpm --filter @dofek/oura-ble build:ios` before packing. The tarball
includes the generated UniFFI bindings, XCFramework, and third-party
licenses. The Rust dependency versions and native sources are in
[`native`](https://github.com/Asherlc/dofek/tree/main/packages/oura-ble/native).
[Upstream build](https://github.com/Th0rgal/open_health/blob/main/apps/ios/build-xcframework.sh) ·
[cargo-about](https://embarkstudios.github.io/cargo-about/)

Run `swift test --package-path packages/oura-ble` from the repository root
to exercise the Swift transport and pairing code on macOS. The native mutation
runner uses the same SwiftPM target. To verify the Expo bridge, install the
packed tarball in an Expo app and build it with CocoaPods.
