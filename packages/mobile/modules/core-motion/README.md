# Core Motion Module

<!-- cspell:ignore COREMOTION -->

Local iOS Expo module that records raw iPhone accelerometer samples with
Apple's `CMSensorRecorder`, queries them by time range, and exposes a small
TypeScript API to the Dofek mobile app.

The module targets iOS 16.4 or newer and has no Android or web implementation.
Because it contains custom native code, use a development or production build;
Expo Go cannot load native libraries that are not bundled into Expo Go. See
Expo's [custom native code guide](https://docs.expo.dev/workflow/customizing/).

## Platform behavior

Apple's sensor recorder captures at 50 Hz for at most 43,200 seconds
(12 hours), continues while the app is suspended or terminated, and retains
recorded data for up to three days. See
[`recordAccelerometer(forDuration:)`](https://developer.apple.com/documentation/coremotion/cmsensorrecorder/recordaccelerometer%28forduration%3A%29).
Returned `x`, `y`, and `z` values are acceleration in g, as defined by
[`CMAcceleration`](https://developer.apple.com/documentation/coremotion/cmacceleration).

Motion access requires an `NSMotionUsageDescription`; the mobile app declares
it in `packages/mobile/app.json`. Apple documents this requirement in the
[Core Motion overview](https://developer.apple.com/documentation/coremotion/).
Availability still varies by device, so callers must check
`isAccelerometerRecordingAvailable()` before recording or querying.

## API

| Function | Behavior |
|---|---|
| `isAccelerometerRecordingAvailable()` | Reports whether `CMSensorRecorder` is available. |
| `getMotionAuthorizationStatus()` | Returns `authorized`, `denied`, `restricted`, or `notDetermined`. |
| `requestMotionPermission()` | Triggers authorization through a short motion-activity query and returns the resulting status. |
| `startRecording(durationSeconds)` | Starts recording; durations above 12 hours are clamped. |
| `isRecordingActive()` | Reports whether this app has previously started a session, not whether Apple is currently recording. |
| `queryRecordedData(fromDate, toDate)` | Returns ISO-timestamped `{ x, y, z }` samples for the requested interval. |
| `getLastSyncTimestamp()` / `setLastSyncTimestamp()` | Reads or writes the app's persisted upload cursor. |

`queryRecordedData()` accepts ISO 8601 timestamps with or without fractional
seconds. It rejects malformed dates with `COREMOTION_INVALID_DATE` and returns
an empty array when recording is unavailable or Apple has no retained samples
for the interval.

## Usage

```ts
import {
  getMotionAuthorizationStatus,
  isAccelerometerRecordingAvailable,
  queryRecordedData,
  requestMotionPermission,
  startRecording,
} from "../modules/core-motion";

if (isAccelerometerRecordingAvailable()) {
  const status =
    getMotionAuthorizationStatus() === "notDetermined"
      ? await requestMotionPermission()
      : getMotionAuthorizationStatus();

  if (status === "authorized") {
    await startRecording(12 * 60 * 60);
    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - 60 * 60 * 1000);
    const samples = await queryRecordedData(
      startedAt.toISOString(),
      endedAt.toISOString(),
    );
  }
}
```

Application-level recording, upload batching, retry behavior, and sync-cursor
advancement live in `packages/mobile/lib/inertial-measurement-unit-*.ts` and
`packages/mobile/lib/background-accelerometer-sync.ts`; this module only owns
the native sensor boundary and local cursor storage.

## Development and validation

From `packages/mobile`:

```bash
pnpm typecheck
pnpm ios:device
```

Native changes require rebuilding the iOS app. Expo documents that native-code
changes require a new native build in its
[development-build workflow](https://docs.expo.dev/develop/development-builds/expo-go-to-dev-build/).
Use a physical iPhone to validate availability, authorization, sampling, and
background recording; a Simulator build does not prove those hardware paths.

The platform-neutral ISO date parser has focused Swift tests:

```bash
cd packages/mobile/modules/core-motion
swift test
```

These tests run on macOS and do not compile or exercise the iOS Expo bridge.
