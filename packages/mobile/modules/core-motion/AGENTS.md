# Core Motion Agent Guide

Read [README.md](./README.md) first for the public API, platform behavior,
runtime requirements, and validation commands.

## Boundaries

- `index.ts` is the TypeScript public surface. Keep its return types, accepted
  date format, sample field names, and authorization strings aligned with
  `ios/CoreMotionModule.swift`.
- `src/CoreMotionModule.ts` only resolves the native Expo module. Sensor,
  authorization, query, and persistence behavior belongs in Swift.
- `ios/CoreMotionModule.swift` owns the `CMSensorRecorder` and
  `CMMotionActivityManager` boundary, background list iteration, ISO timestamp
  serialization, Expo errors, and the two `UserDefaults` markers.
- Recording/upload orchestration does not belong here. Keep batching, retry,
  cursor-advancement policy, tRPC calls, and app lifecycle handling in
  `packages/mobile/lib/inertial-measurement-unit-*.ts` or
  `packages/mobile/lib/background-accelerometer-sync.ts`.
- The shared sample contract is `InertialMeasurementUnitSample` from
  `@dofek/imu`. Core Motion supplies acceleration in g and no gyroscope fields;
  Apple defines the units in
  [`CMAcceleration`](https://developer.apple.com/documentation/coremotion/cmacceleration).

## Behavioral invariants

- Check `CMSensorRecorder.isAccelerometerRecordingAvailable()` before native
  recording or querying. Apple notes that Core Motion service availability
  varies by device in the
  [Core Motion overview](https://developer.apple.com/documentation/coremotion/).
- Keep the native maximum recording duration at Apple's documented 43,200
  seconds, the 50 Hz source cadence unchanged, and application queries within
  the three-day retention window. These limits come from
  [`recordAccelerometer(forDuration:)`](https://developer.apple.com/documentation/coremotion/cmsensorrecorder/recordaccelerometer%28forduration%3A%29).
- `isRecordingActive()` is a persisted “session was started” marker. It does
  not inspect current system recording state; do not use it as proof that
  samples are still being captured.
- Query ISO 8601 input at the native boundary and preserve fractional seconds
  in output. Keep large `CMSensorDataList` iteration off the main thread and
  settle the Expo promise on the main thread.
- Do not advance `lastSyncTimestamp` in this module. The sync layer owns the
  upload transaction boundary and updates the cursor only according to its
  tested policy.
- Keep `NSMotionUsageDescription` and the `ExpoCoreMotion` extra-pod path in
  `packages/mobile/app.json` aligned with this module. Apple requires the
  motion usage description before accessing motion services
  ([official reference](https://developer.apple.com/documentation/bundleresources/information-property-list/nsmotionusagedescription)).

## Test boundaries

From this directory:

```bash
swift test
```

`Package.swift` targets macOS and iOS, but the Expo/Core Motion implementation
is guarded by `#if os(iOS) && canImport(ExpoModulesCore)`. Consequently,
macOS `swift test` covers only platform-neutral code such as
`CoreMotionIsoDateParser`; it does not compile the native module definition.
Keep pure parsing logic outside the platform guard and add focused XCTest cases
for both accepted ISO forms and rejection behavior.

From `packages/mobile`:

```bash
pnpm typecheck
pnpm exec vitest run --project mobile \
  lib/inertial-measurement-unit-sync.test.ts \
  lib/inertial-measurement-unit-service.test.ts \
  lib/background-accelerometer-sync.test.ts
```

TypeScript contract changes require typechecking and relevant consumer tests.
Swift bridge changes additionally require an iOS development build; Expo
requires native code to be compiled into that build
([Expo development-build guide](https://docs.expo.dev/develop/development-builds/expo-go-to-dev-build/)).
Validate authorization, retained samples, and suspended/terminated recording on
a physical iPhone.
