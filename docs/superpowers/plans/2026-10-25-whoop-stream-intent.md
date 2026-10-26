# WHOOP streaming intent implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Keep the test, review, and build checkpoints below explicit.

**Goal:** Preserve requested motion capture across automatic reconnect failures and honor explicit cancellation during recovery.

**Architecture:** Keep intent in the existing native connection manager. Unexpected disconnects retain it; Stop and Disconnect clear it. The Expo stop handler must apply the state change even without a connected command characteristic.

**Tech stack:** Swift, XCTest, Expo Modules, existing iOS build tooling.

**Spec:** The user approved this narrow correction after the [incident investigation](../../production-incident-baseline.md#2026-10-25--whoop-bluetooth-reconnection-failed-while-the-strap-was-nearby). The [manager](../../../packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionManager.swift), [disconnect transition](../../../packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionManager+CoreBluetooth.swift), and [Expo bridge](../../../packages/mobile/modules/whoop-ble/ios/WhoopBleModule.swift) define the existing contract.

## Global constraints

- Work on the existing isolated branch; no branch switching.
- Keep existing retry, timeout, pairing, notification, upload, and public API behavior.
- Do not clear intent in shared cleanup: unexpected recovery uses that path.
- No dependencies, abstractions, or test-only production APIs.
- Native-only correction; no web equivalent exists for the iOS BLE transport.
- This correction does not claim to explain native encryption timeouts or the separate upload stall.

## Review focus

- Repeated failures before readiness must still restore requested capture.
- Stop while connecting, discovering, or subscribing must prevent restoration.
- Intentional disconnect must prevent later restoration.
- An already stopped session must remain stopped after another link failure.
- Existing connected Stop and normal first connection must preserve their behavior.

## Task 1: Correct the native intent lifecycle

**Modify:** `packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionManager.swift`, `WhoopBleConnectionManager+CoreBluetooth.swift`, and `WhoopBleModule.swift`.

**Tests:** Extend the existing connection-manager tests and the corresponding native source tests; use the temporary diagnostic reproductions as evidence, not copied test scaffolding.

**Interfaces:** Existing `handleDisconnection`, `stopStreaming`, `disconnect`, notification readiness, and Expo `stopImuStreaming` signatures stay unchanged.

- [x] Write regressions proving the review-focus cases through actual state transitions and readiness restoration. A failed automatic reconnect must still yield `streaming`; explicit Stop or Disconnect during recovery must yield `ready` after a later successful connection. Assert restored IMU activation where the existing test seam permits it.
- [x] Run the focused XCTest cases against unchanged production source and retain the expected failures.
- [x] Preserve pending `wasStreaming` on unexpected failures; clear it unconditionally on explicit Stop and Disconnect. Let the Expo stop handler always cancel intent while issuing the stop command only when the existing characteristic permits it.
- [x] Run the full WHOOP Swift suite and strict native lint, then obtain independent task review for specification and code quality. Root validates a signed iOS Simulator build to compile the Expo bridge; physical Bluetooth behavior remains a separate check. SwiftPM's exclusion of the Expo bridge is documented in the [module guide](../../../packages/mobile/modules/whoop-ble/AGENTS.md).
- [x] Update the incident record with exact validation, obtain final review, commit, and push the correction.

## Review checkpoints

Preflight: one atomic task, no shared-interface conflicts. The approved cancellation semantics include Stop during pending reconnect; preserving stale intent there would leave the same defect reachable through the public Swift client and Expo bridge. Task review checks the native diff before the iOS build result and final review close the change.

Completed checkpoints: three regressions failed before the fix and passed afterward; all 161 native and 1,795 mobile tests passed. Repository lint, required typechecks, spelling, and strict lint of 146 tracked Swift files passed. Both independent reviews passed. The signed Release Simulator build and deep/strict signature verification passed; physical WHOOP recovery and the original transport failures remain outside this correction's validation.
