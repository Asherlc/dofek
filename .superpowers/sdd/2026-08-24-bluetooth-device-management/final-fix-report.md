# Bluetooth device management final fix report

## Status

Complete. The final review's six findings are addressed on `ios-bluetooth-device-list`.

## Fail-first evidence

- The focused mobile test run initially failed 8 tests across the catalog, detail route, and list UI because the WHOOP summary event, streaming controls, and provider headings did not exist.
- The heart-rate Swift test target initially failed to compile because `BleHeartRateDeviceCoordinator.purgeAccountState` did not exist.
- After the first purge implementation passed, a stricter race test used a queued sample newer than the erasure cutoff and failed with one retained sample. Clearing the buffer inside the serialized purge boundary made the regression test pass.

## Fixes

1. **Serialized heart-rate account purge.** `BleHeartRateConnectionManager` now provides a BLE-queue purge boundary that drains preceding work, cancels scanning and connections, removes native sessions, and only then performs account-owned storage cleanup. The coordinator closes its measurement gate, clears buffered samples, advances the erasure cutoff, and clears the device registry within that boundary. The Expo promise resolves only after the boundary completes. Mobile account purge remains sequential and is now tested to wait for native BLE cleanup before clearing the session.
2. **Complete WHOOP catalog refreshes.** The WHOOP module emits a complete device summary snapshot after connection transitions, stream start/stop, buffer mutations, manual disconnect completion, and account purge. The catalog subscribes to that snapshot contract, so connection state and diagnostic counts refresh without polling.
3. **WHOOP detail controls.** Connected WHOOP detail screens expose start/stop IMU streaming actions. Native errors are reported to telemetry and their specific messages remain visible to the user.
4. **Explicit heart-rate list membership event.** The native heart-rate module emits `onDeviceListChanged` after successful add, forget, and purge operations. The shared catalog subscribes to it, so Settings and recording consumers both remove forgotten devices promptly.
5. **Coordinator lifecycle coverage.** Swift tests now exercise the real coordinator, registry, event sink, sample buffer, and connection-manager boundary for independent multi-device disconnect and timeout-like transitions, plus the account-erasure race.
6. **Provider list sections.** The device list now renders accessible `WHOOP` and `Heart-rate monitors` section headers while preserving device-row actions and diagnostics.

## Verification

- `swift test` in `packages/mobile/modules/ble-heart-rate`: 43 tests passed.
- `swift test` in `packages/mobile/modules/whoop-ble`: 119 tests passed.
- Focused mobile regression suite: 5 files, 37 tests passed.
- `pnpm test:mobile`: passed.
- `pnpm typecheck` in `packages/mobile`: passed (`TypeScript: No errors found`).
- `pnpm lint` in `packages/mobile`: passed (Biome, handled-error telemetry policy, and Expo Router route hygiene).
- `xcrun swiftc -frontend -parse` over all changed Swift bridge/manager files: passed.
- `git diff --check`: passed.

## Remaining release-gate concern

The Expo Swift bridge files are excluded from their standalone SwiftPM test targets, so they were syntax-parsed while the underlying managers/coordinators were compiled and tested. A generated iOS build plus physical-device acceptance with two simultaneous heart-rate monitors and a WHOOP strap remains the release gate for Core Bluetooth behavior.

## Retrospective

- Went well: fail-first tests exposed both the visible stale-state gaps and the subtler post-cutoff sample-retention race.
- Required investigation: the account purge needed one serialized native boundary spanning session teardown and storage erasure; separate disconnect and clear calls could not prove ordering.
- Useful next-time context: WHOOP detail identity intentionally retains the last known device ID across manual disconnect so the existing detail route can reconnect; account purge clears that identity.
- Suggested guideline improvement: add a mobile Bluetooth runbook stating that every native mutation affecting a catalog field must emit a complete snapshot, and that account erasure must serialize producer shutdown before storage deletion.
- Suggested skills for similar work: `superpowers:test-driven-development`, `superpowers:systematic-debugging`, and `ios-simulator-audit` for the simulator portion of release acceptance. A dedicated physical-BLE acceptance skill/runbook would close the remaining tooling gap.
