# Watch Motion Module

Local Expo iOS module that coordinates Dofek's Apple Watch companion and
durably receives accelerometer and altitude files through WatchConnectivity.

Apple documents WatchConnectivity as the framework for transferring data
between an iOS app and its paired watchOS app:
<https://developer.apple.com/documentation/watchconnectivity>.

## Responsibilities

- Report Watch support, pairing, reachability, and companion-app installation.
- Request a Watch sync or a new recording session.
- Persist transferred files under Application Support before the JavaScript
  module attaches.
- List, parse, and explicitly delete pending accelerometer or altitude files.
- Reject unsafe file names and validate altitude samples at the TypeScript
  boundary.

The receiver uses a process-owned `WCSessionDelegate`. A received file is moved
into the pending inbox, or copied if the move fails, before an event is sent to
JavaScript. Files remain pending until the caller uploads them successfully and
calls `deleteWatchFile()`.

## TypeScript API

`index.ts` exports:

- `isWatchSupported()`
- `isWatchPaired()`
- `isWatchAppInstalled()`
- `getWatchSyncStatus()`
- `requestWatchSync()`
- `requestWatchRecording()`
- `getPendingWatchFileNames()`
- `getPendingWatchAltitudeFileNames()`
- `readWatchFile()`
- `readWatchAltitudeFile()`
- `deleteWatchFile()`

This is a local Expo module and requires an iOS development build; Expo explains
the native-module development-build requirement in its
[local app development guide](https://docs.expo.dev/guides/local-app-development/).

## Source Layout

```text
index.ts                   Typed public bridge and filename validation
schemas.ts                 Runtime altitude-sample schema
src/WatchMotionModule.ts   Expo module declaration
ios/WatchMotionModule.swift
ios/WatchFileInbox.swift   Durable inbox and process-owned receiver
ios/SampleFileParser.swift Compressed JSON sample parser
Tests/                     Swift parser and receiver tests
```

## Validation

From the repository root:

```bash
pnpm exec vitest run packages/mobile/modules/watch-motion/index.test.ts \
  --project mobile
swift test --package-path packages/mobile/modules/watch-motion
```

The Simulator cannot prove Watch pairing, reachability, background delivery, or
physical-sensor behavior. Exercise those paths on paired hardware.
