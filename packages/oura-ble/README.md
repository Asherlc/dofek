# @dofek/oura-ble

Portable TypeScript contract and Expo client for pairing with an Oura Ring and
retrieving recorded events over Bluetooth.

This package currently defines the public client contract and an iOS-oriented
Expo native-module facade. The root entry point is portable and has no native
dependency. The `@dofek/oura-ble/expo` entry point loads the optional Expo
native module named `OuraBle` lazily via `expo`'s exported
`requireOptionalNativeModule`.

## Install

```sh
npm install @dofek/oura-ble
```

Expo/React Native consumers use this package from an app that already depends on
`expo` (Expo 58+). No separate `expo-modules-core` dependency is required in the
host app.

## API

The portable contract exports `OuraClient` types and method contracts:

- `discoverRings()` returns opaque peripheral identifiers.
- `pairRing(peripheralId, options?)` returns a new SDK pairing identifier,
  device information, and any requested measurement outcomes.
- `syncRing(ringId)` syncs recorded history for an already-paired ring.
- `readEvents(ringId, options?)` returns recorded events and a store-local
  opaque continuation token for paging.
- `forgetRing(ringId)` removes this app's local data and pairing credentials for
  the ring.

Events are stable typed JavaScript values and include ring identity, event type,
ring-relative timestamp, capture time, decoded fields when available, and the
raw event body encoded as a base64 string.

## Status

Native iOS implementation is provided in later work. Using the Expo client
without an available `OuraBle` native module produces an actionable error.
