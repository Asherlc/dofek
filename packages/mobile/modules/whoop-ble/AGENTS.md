# WHOOP BLE Agent Guide

Read [README.md](./README.md) first for the supported platforms, installation
requirements, public usage, and stability caveats. Treat
[docs/whoop-ble-protocol.md](../../../../docs/whoop-ble-protocol.md) as the
canonical protocol and provenance reference.

## Ownership boundaries

- `index.ts` is the TypeScript public API. Keep its exported types, method
  signatures, event payloads, and native-to-TypeScript field mapping aligned
  with `ios/WhoopBleModule.swift`.
- `src/WhoopBleModule.ts` only loads the Expo native module. Protocol parsing,
  connection state, buffering, watchdog behavior, and orientation processing
  belong in Swift.
- `ios/WhoopBleModule.swift` is the Expo bridge. `Package.swift` deliberately
  excludes it from the standalone Swift package, so `swift test` does not
  compile or validate this bridge.
- `ios/WhoopBleClient.swift` is the public SwiftPM interface. Keep Expo types
  out of it and preserve its async stream and error contracts.
- `WhoopBleConnectionManager*` owns CoreBluetooth discovery, connection,
  characteristic subscription, reconnection, and queue-confined state.
  `WhoopBleFrameParser*` owns framing, CRC, packet decoding, and command
  construction. Do not duplicate either responsibility in the bridge or
  TypeScript.
- `WhoopBleSampleStore` owns the canonical transactional SQLite queue, persisted
  account/server generation, immutable reservations, and erasure cutoff. Remove
  rows only by the exact acknowledged batch identity; SQLite defines its
  [transaction boundaries](https://sqlite.org/isolation.html).
- `WhoopBleUploadRuntime` owns Dofek-only bootstrap and Sentry reporting; keep
  it and the URLSession adapter excluded from the standalone SwiftPM target.
  `WhoopBleBackgroundUploader` owns native scheduling, credentials in memory,
  and task reconciliation. `WhoopURLSessionTransport` and the app-delegate
  subscriber implement Apple's [background transfer lifecycle](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background).
  Keep stream progress independent and cancel captured retired identities.
- Sign-out/account changes clear account counters and reservations. The device
  erasure cutoff survives those changes. Tests must reopen real SQLite storage
  and exercise late completion, failure, and owner-change ordering.

## Protocol changes

The WHOOP protocol is private and reverse-engineered. Do not infer new offsets,
packet types, scaling, commands, or model compatibility from a single malformed
packet. Require reproducible capture evidence, add the smallest parser fixture
that proves the behavior, and update the canonical protocol document in the
same change.

Keep raw optical bytes intact when their meaning is unknown. Preserve
per-device attribution and timestamp semantics across Swift dictionaries and
TypeScript types. Event delivery that crosses the Expo bridge must remain on
the main thread; BLE state and parser work must remain serialized on the BLE
queue.

## Testing boundaries

From this directory:

```bash
pnpm typecheck
swift test
```

- Add or update XCTest coverage for frame/CRC parsing, command bytes,
  connection transitions, notification readiness, watchdog retries, buffer
  drains, orientation math, and public Swift API behavior as applicable.
- Use `Tests/fixtures/` for captured protocol evidence. Keep fixtures minimal
  and document their provenance in the protocol reference.
- `swift test` exercises the standalone SwiftPM target on macOS; it neither
  loads the Expo runtime nor proves real CoreBluetooth behavior on a WHOOP
  strap.
- TypeScript API changes require `pnpm typecheck`. Expo bridge changes also
  require an iOS development build because the bridge is excluded from
  SwiftPM. Hardware streaming, bonding, background delivery, and firmware
  compatibility require a physical-device check.
- JavaScript authentication and foreground connection ownership belong in
  `packages/mobile/lib/background-whoop-ble-sync.ts` and its colocated tests.
  Durable queue scheduling belongs to the native uploader. Do not restore
  JavaScript network drains or competing queue consumers; see the
  [delivery design](../../../../docs/superpowers/specs/2026-10-28-whoop-durable-upload-design.md).
