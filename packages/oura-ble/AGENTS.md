# Oura BLE Agent Guide

> **Read the [README.md](./README.md) first** for package purpose, install, and
> public API status.

## Ownership boundaries

- `src/client.ts` defines the portable public contract: `OuraClient`, method
  signatures, stable typed result/event types, and paging tokens. Keep this
  module free of Expo/native dependencies.
- `src/index.ts` is the root portable entry point. It must not eagerly require
  Expo modules or native code.
- `src/expo.ts` is the Expo facade. It must lazily load the optional native
  module named `OuraBle` via `expo`'s exported `requireOptionalNativeModule`,
  throw an actionable error when unavailable, avoid exposing native secrets,
  and forward method parameters and native rejections unchanged.
- `native` owns the shared protocol session and local SQLite operations.
  `ios` owns Bluetooth, credential persistence, and the Expo bridge. Keep
  the ring's history cursor and each batch in the same SQLite transaction.
  Save a pending pairing before attempting to install its key on the ring.

## Contracts

- Discovery returns opaque peripheral identifiers.
- Pairing returns a new SDK pairing identifier, device information, and any
  requested measurement outcomes.
- History paging uses a store-local opaque continuation token.
- Events include ring identity, event type, ring-relative timestamp, capture
  time, decoded fields when available, and raw event body encoding documented as
  base64.

## Testing

- Add or update focused unit tests under `src/**/*.test.ts`.
- Run `pnpm exec vitest run --project unit packages/oura-ble`,
  `pnpm --filter @dofek/oura-ble typecheck`, and
  `pnpm --filter @dofek/oura-ble build`.
- Run `cargo +1.100.0 test --locked --lib` from `native`. Verify packaged
  native changes with a tarball install in an independent Expo app.
