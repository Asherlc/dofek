# WHOOP Native Connection Diagnostics Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement and review this plan. Steps use checkbox syntax for tracking.

**Goal:** Preserve the native evidence needed to explain recurrent background Bluetooth disconnections and failed recovery.

**Architecture:** Add a bounded native connection-event journal beside the existing capture diagnostics. Read it through `getDataPathStats()` and replay its flat metadata through the existing mobile logger. Existing [capture diagnostics](../../../packages/mobile/modules/whoop-ble/README.md) establish the native checkpoint and JavaScript reporting pattern.

**Tech Stack:** Existing Swift/Foundation, CoreBluetooth, Expo Modules, TypeScript, Zod, XCTest and Vitest; no new dependencies.

**Spec:** The user approved native diagnostic logging in this conversation after two observed disconnects; the [incident record](../../production-incident-baseline.md#2026-10-24--recurrent-whoop-bluetooth-disconnect-alerts) supplies the evidence and missing context. This is the short design for that approved scope.

## Global Constraints

- Preserve existing reconnect, timeout, notification and sensor behavior.
- Retain at most 64 native metadata events, with stable IDs, native timestamps, native session identity and process identity. Persist rare connection lifecycle events with Foundation UserDefaults, matching the existing native checkpoint storage.
- Capture NSError domain/code/description, connection stage, central-manager state, reconnect intent and handshake failures before JavaScript delivery. Include restoration and native-session start events.
- Reads are nondestructive. Repeated JavaScript snapshots report only unseen retained event IDs; event IDs remain stable across restart replay.
- No sensor values, packet payloads or credentials belong in this history. Explicitly mark historical account provenance unknown and clear history during existing account erasure.
- Swift owns native connection state. The bridge and TypeScript schemas agree on a required journal payload; use the existing runtime fingerprint/new native build workflow rather than an old-binary fallback.
- No web UI or server changes are needed for native Bluetooth diagnostics. All event attributes sent to the existing logger are flat primitives.

## Review Focus

- Native events recorded while JavaScript is unavailable remain readable after native journal recreation.
- An application handshake timeout is distinguishable from a CoreBluetooth NSError disconnect.
- A new event after the first snapshot is logged once; repeated reads do not consume or duplicate history in one JavaScript diagnostics lifetime.
- Account erasure does not leave prior device identifiers in the persisted journal or repopulate them through queued callbacks.
- Instrumentation observes existing connection behavior without adding reconnect attempts, timers or cancellation changes.

### Task 1: Native journal, connection instrumentation and telemetry bridge

**Files:** Create `packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionDiagnostics.swift` and its focused XCTest file. Modify native connection-manager/delegate files, the Expo stats/erasure bridge, `modules/whoop-ble/index.ts` and its tests, and `lib/whoop-ble-diagnostics.ts` with its tests/test helper.

**Interfaces:** The connection manager owns a required diagnostics instance. A nondestructive `connectionDiagnostics` payload in `getDataPathStats()` contains the bounded event history and overflow count. Each event has a stable ID, occurrence timestamp, native session ID, process ID, event name, connection/central state, reconnect intent, and optional peripheral/error/reason fields. Report events as `native_connection_event` using the existing logger.

- [x] Write failing native journal, manager-event, schema and logging tests. Run the focused suites and confirm failures demonstrate missing diagnostic behavior.
- [x] Implement the smallest native metadata journal and record lifecycle events at existing execution points. Keep native-to-JavaScript callbacks on their existing queues.
- [x] Expose and validate the payload; log unseen events with explicit native occurrence time and unknown account provenance. Update shared fixtures.
- [x] Run SwiftPM and relevant mobile/module Vitest suites; resolve failures without weakening policy.
- [x] Review the complete change against the global constraints and review focus, using an independent agent. Record the review outcome and any corrections in the working ledger.

### Task 2: Documentation, validation and delivery

- [x] Document journal semantics, diagnostic queries and the new native-build requirement in the module README/protocol runbook, citing the source implementation and [Expo native development guidance](https://docs.expo.dev/workflow/customizing/).
- [x] Update the incident record to distinguish instrumentation delivered from incident resolution.
- [x] Validate the Expo bridge with an iOS build where local signing/dependencies allow it; explicitly report any blocker and physical-device validation boundary.
- [x] Run repository lint, root/server/web/mobile/module typechecks, and unit/mobile suites before pushing.
- [x] Commit the reviewed change on the existing branch and push it automatically. Do not merge or publish a release.
