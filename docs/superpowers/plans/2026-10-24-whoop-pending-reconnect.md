# WHOOP pending reconnect implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Dofek's connection timer from abandoning passive WHOOP reconnection before Bluetooth connects.

**Architecture:** Preserve automatic pending Core Bluetooth requests and their owning peripheral/state. Bound explicit caller waits as before and arm the existing discovery/subscription timeout once a passive connection succeeds.

**Tech Stack:** Swift, Core Bluetooth, XCTest, existing Expo module and Vitest application tests.

**Spec:** [Approved design](../specs/2026-10-24-whoop-pending-reconnect-design.md).

## Global Constraints

- Preserve the ten-second timeout value, alert policy, public Swift/Expo APIs, sample buffering, explicit cancellation and upload behavior.
- No dependencies or configuration are added.
- Continue on the existing isolated `strong-eagle` branch; no branch switching.
- Native changes need a new iOS build; physical background recovery remains a release verification requirement.

## Review Focus

- An automatic reconnect that takes longer than ten seconds must retain its peripheral and reconnect intent.
- Foreground find/retry must preserve a pending connection and accept its later connection callback.
- Explicit connect callers must still receive a bounded timeout and exactly one completion.
- Restored pending connections must accept a later callback; restored connected peripherals must retain bounded discovery.
- Stale callbacks, intentional cancellation and successful subscription must settle or cancel only the owning attempt.

### Task 1: Native reconnect lifecycle and regressions

**Files:**
- Modify: `packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionManager.swift`
- Modify: `packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionManager+CoreBluetooth.swift`
- Modify: `packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionManager+Discovery.swift`
- Create: `packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionManager+Handshake.swift` — timeout, completion and abort ownership extracted from the manager.
- Test: `packages/mobile/modules/whoop-ble/Tests/WhoopBleConnectionManagerTests.swift`
- Create: `packages/mobile/modules/whoop-ble/Tests/WhoopBleConnectionManager+HandshakeTests.swift` — corresponding handshake regressions, including the existing tests moved with their production responsibility.

**Interfaces:** Consume the existing `connect`, `findWhoop`, `retryConnection`, native callback handlers, and `startHandshakeTimeout`; preserve their public contracts.

- [x] Add regressions proving passive pending reconnect survives the configured deadline; explicit connect still cancels with `TIMEOUT`; discovery and subscriptions after connection remain bounded; stale timers cannot cancel a replacement attempt; explicit cancellation settles once. Review concrete foreground find/retry and restoration ownership paths and record the physical test boundary.
- [x] Run `swift test --package-path packages/mobile/modules/whoop-ble`; observe the new behavioral regression fail before implementation.
- [x] Apply the smallest lifecycle fix using existing completion ownership/state and timeout handling. Do not add a public policy flag or retry loop.
- [x] Run the complete Swift suite and strict SwiftLint over owned tracked Swift files; expect zero failures or violations.
- [x] Independent review checkpoint: verify approved behavior, timer ownership, stale callbacks and restoration against the complete native diff.

### Task 2: Documentation, app compatibility and delivery

**Files:**
- Modify: `packages/mobile/modules/whoop-ble/README.md`
- Modify: `docs/whoop-ble-protocol.md`
- Modify: `docs/production-incident-baseline.md`

**Interfaces:** Consume Task 1's unchanged public API and final native behavior.

- [x] Document pending automatic connections, bounded setup, diagnostic replay and native release verification with primary-source citations.
- [x] Run focused mobile sync/diagnostic tests, including the existing explicit-connection timeout upload fallback; expect all tests to pass.
- [ ] Run full repository lint, root/server/web/mobile/module TypeScript checks, and a signed iOS Simulator compile when available; report the physical-device validation boundary accurately.
- [ ] Final review checkpoint: independent whole-change review, address material findings with regression coverage.
- [ ] Commit and push the completed change on `strong-eagle`; report root cause, fix, validation and native build requirement.
