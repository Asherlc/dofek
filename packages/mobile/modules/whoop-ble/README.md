# @dofek/whoop-ble

Unofficial Expo iOS client for the reverse-engineered WHOOP strap Bluetooth Low
Energy protocol.

The package discovers bonded WHOOP straps, parses proprietary framed packets,
captures reported heart rate, real-time R-R intervals and inertial samples, and exposes connection
and orientation events through Expo Modules.

## Install

```sh
npx expo install @dofek/whoop-ble expo-modules-core
```

This package currently supports iOS 16.4 or later. It is not affiliated with,
endorsed by, or supported by WHOOP. The protocol is undocumented and may change
without notice.

Library development uses the same `expo-modules-core` version as the Dofek app.
Consumers supply the compatible runtime through their Expo SDK, following
Expo's [native library dependency guidance](https://docs.expo.dev/modules/existing-library/).

Protocol details and provenance are documented in
[`docs/whoop-ble-protocol.md`](../../../../docs/whoop-ble-protocol.md).
Native Swift applications can use the separately tagged
[WhoopBLE Swift package](https://github.com/Asherlc/whoop-ble-swift).

Buffered realtime samples expose `heartRateBpm` independently of `rrIntervalMs`.
WHOOP can report BPM when beat intervals are unavailable during movement; see
its [research FAQ, page 4](https://sensorlab.arizona.edu/sites/default/files/2023-05/WHOOP%20Unite%20Research%20FAQs_0.pdf#page=4).
Captured R18/R21 fractional clock words use 1/32768-second ticks, and buffer
timestamps use that scale; see the [capture-backed protocol reference](../../../../docs/whoop-ble-protocol.md).
Native changes require a new iOS build, following Expo's
[native development workflow](https://docs.expo.dev/workflow/customizing/).

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

`getDataPathStats()` also exposes `lastKnownDeviceId`, capture timestamps, and a typed `buffers`
snapshot: `bufferInstanceId`, `bufferCreatedAt`, `checkpointAt`, `imu`,
`realtime`, and `previousCheckpoint`. Each stream reports its count, true
minimum/maximum sample timestamps, received and confirmed counts, discard counts
for overflow/erasure/clear/legacy drains, and `lastConfirmedAt`. Notification and
parsed-sample timestamps use phone observation time; `lastValidHeartRateAt` uses
the device timestamp of the latest positive reported BPM whose clock is between
year 2000 and five minutes after phone observation time. See the
[TypeScript contract](index.ts) and
[native capture diagnostics](ios/WhoopBleCaptureDiagnostics.swift).

The [buffer](ios/WhoopBleSampleBuffer.swift) checkpoints bounded metadata during
capture at most once per 30 seconds, and when diagnostics or explicit discard
boundaries request a snapshot. A positive confirmation that empties a stream also
checkpoints the resulting queue state; releasing a peek with count zero retains
every sample. One previous checkpoint is available after a
new buffer instance starts. Samples remain in memory and are never restored
from that checkpoint; prior account ownership is unknown. It is last-observed
evidence, not an exact loss count or termination reason. Apple does not guarantee
a final [termination callback](https://developer.apple.com/documentation/uikit/uiapplicationdelegate/applicationwillterminate(_:)).
The expanded bridge requires a new native build; the Dofek app declares runtime
1.13 in [app.json](../../app.json). The
[diagnostic procedure](../../../../docs/whoop-ble-protocol.md#diagnosing-capture-upload-and-visibility)
describes correlation with upload and server events.

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
