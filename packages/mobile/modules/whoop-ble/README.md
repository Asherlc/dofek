# @dofek/whoop-ble

Unofficial Expo iOS client for the reverse-engineered WHOOP strap Bluetooth Low
Energy protocol.

The package discovers bonded WHOOP straps, parses proprietary framed packets,
captures real-time R-R intervals and inertial samples, and exposes connection
and orientation events through Expo Modules.

## Install

```sh
npx expo install @dofek/whoop-ble expo-modules-core
```

This package currently supports iOS 16.4 or later. It is not affiliated with,
endorsed by, or supported by WHOOP. The protocol is undocumented and may change
without notice.

Protocol details and provenance are documented in
[`docs/whoop-ble-protocol.md`](../../../../docs/whoop-ble-protocol.md).
Native Swift applications can use the separately tagged
[WhoopBLE Swift package](https://github.com/Asherlc/whoop-ble-swift).

This native module requires a development build; it does not run in Expo Go.
The consuming iOS app must provide `NSBluetoothAlwaysUsageDescription`.
Background capture additionally requires the `bluetooth-central` background
mode. See Expo's
[local app development guide](https://docs.expo.dev/guides/local-app-development/)
and Apple's
[`NSBluetoothAlwaysUsageDescription` documentation](https://developer.apple.com/documentation/bundleresources/information-property-list/nsbluetoothalwaysusagedescription).

## Usage

```ts
import {
  connect,
  findWhoop,
  peekBufferedRealtimeData,
  startRealtimeHr,
} from "@dofek/whoop-ble";

const device = await findWhoop();
if (device) {
  await connect(device.id);
  await startRealtimeHr();
  const samples = await peekBufferedRealtimeData();
}
```

The root module also exports connection-state diagnostics, IMU and optical
stream controls, orientation events, reconnect support, and peek-then-confirm
buffer drains. Use the peek/confirm pair when uploading samples so data is only
removed after the upload succeeds.

## Runtime, Stability, and Errors

- Node.js 22.14 or later is required by the package tooling.
- iOS 16.4 or later is required by the Expo pod.
- Connection and readiness failures reject with specific error codes and
  messages from the native module.
- WHOOP firmware updates may change the private protocol without notice.

## License and Contributions

Licensed under the [MIT License](LICENSE). Source is maintained in the
[Dofek repository](https://github.com/Asherlc/dofek/tree/main/packages/mobile/modules/whoop-ble).
Report issues or propose changes through
[GitHub](https://github.com/Asherlc/dofek/issues).
