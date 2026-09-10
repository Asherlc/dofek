# Zepp Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Dofek's Zepp health sync, connection UX, foreground raw-motion recorder, and Workout Extension reliable, explicit, and aligned with Zepp OS lifecycle constraints.

**Architecture:** The normal app owns continuous low-power health collection and an advanced foreground recorder; the Workout Extension owns automatic workout-focused raw IMU segments. Both raw-motion surfaces compose one shared controller. Health and workout delivery use durable watch and phone outboxes, stable event IDs, at-least-once delivery, serialized drains, and explicit acknowledgements. Authentication is modeled as a state machine, and one versioned transport contract preserves field-level validation errors end to end.

**Tech Stack:** TypeScript, Zepp OS API level 3+, ZML Side Service, `@zos/ble`, Drizzle/Postgres, Hono, Zod, Vitest, Zeus CLI and Zepp OS Simulator.

**Spec:** `docs/superpowers/specs/2026-09-04-zepp-reliability-design.md`

## Global Constraints

- Follow red-green-refactor for every behavioral change.
- Preserve raw overlapping sources and source attribution; deduplicate only in server read/query paths.
- Never acknowledge a watch item until the phone has durably persisted it, and never remove a phone item until the server acknowledges its stable event ID.
- Do not claim background BLE support until an App Service-to-Side Service probe succeeds in the simulator or on a physical watch.
- Use only documented Zepp lifecycle capabilities. Raw Accelerometer and Gyroscope callbacks remain foreground-only.
- Push every implementation commit to the existing remote branch; do not switch branches.
- Keep the unrelated untracked `paseo.json` untouched.

## Target File Map

| Area | Files |
| --- | --- |
| Versioned contract and errors | `packages/zepp/src/health-contract.ts`, `packages/zepp/src/zepp-fetch.ts`, `packages/server/src/routes/ingest-zos-health.ts` |
| Sensor normalization | `packages/zepp/src/health-collector.ts`, `packages/zepp/app-service/health_service.ts` |
| Connection UX | `packages/zepp/src/connection-state.ts`, both `setting/index.ts` files, `packages/zepp/app-side/index.ts` |
| Durable delivery | `packages/zepp/src/durable-outbox.ts`, `packages/zepp/src/sync-coordinator.ts`, `packages/zepp/src/background-health-storage.ts`, `packages/zepp/app-side/index.ts` |
| Background transport | `packages/zepp/src/health-ble-protocol.ts`, `packages/zepp/app-service/health_service.ts`, `packages/zepp/app-side/index.ts` |
| Shared raw motion | `packages/zepp/src/display-lease.ts`, `packages/zepp/src/imu-session-controller.ts`, `packages/zepp/page/index.ts`, `packages/zepp/workout-extension/data-widget/index.ts` |
| Documentation and validation | Zepp READMEs/AGENTS files, existing Zepp build and test commands, Zeus simulator profiles |

---

### Task 1: Preserve actionable health payload failures

**Files:**
- Create: `packages/zepp/src/health-contract.ts`
- Create: `packages/zepp/src/health-contract.test.ts`
- Modify: `packages/zepp/src/zepp-fetch.ts`
- Modify: `packages/zepp/src/zepp-fetch.test.ts`
- Modify: `packages/server/src/routes/ingest-zos-health.ts`
- Modify: `packages/server/src/routes/ingest-zos-health.test.ts`

- [ ] Add failing contract tests for a version-1 envelope, stable batch/event IDs, and structured `formErrors`/`fieldErrors`.
- [ ] Add a failing fetch test proving a 400 response such as `{ error: "Invalid payload", details: { fieldErrors: { restingHeartRate: ["Expected number"] } } }` becomes `Invalid payload: restingHeartRate: Expected number`.
- [ ] Run `rtk pnpm --filter @dofek/zepp test -- src/health-contract.test.ts src/zepp-fetch.test.ts` and confirm the intended failures.
- [ ] Implement dependency-free watch-safe TypeScript contract helpers:

```ts
export interface HealthEnvelopeV1<T> {
  version: 1;
  batchId: string;
  source: { connectionType: "zepp" | "zepp-workout"; installId: string };
  events: Array<{ eventId: string; payload: T }>;
}

export interface ValidationIssue {
  path: string;
  message: string;
}
```

- [ ] Extend `zepp-fetch` error extraction without changing successful response behavior.
- [ ] Make the server return and safely log structured validation issues, including route, batch ID when parseable, issue paths, and counts; never log tokens or full health payloads.
- [ ] Run the focused Zepp and server route unit tests until green.
- [ ] Commit and push: `fix(zepp): preserve health payload diagnostics`.

### Task 2: Normalize Zepp sentinel and non-finite sensor values

**Files:**
- Modify: `packages/zepp/src/health-collector.ts`
- Modify: `packages/zepp/src/health-collector.test.ts`
- Modify: `packages/zepp/page/index.ts`
- Modify: `packages/zepp/app-service/imu_service.ts` (renamed in Task 4)

- [ ] Add failing public-interface tests with Zepp sentinel values, `NaN`, infinity, negative counts/durations, invalid timestamps, and mixed valid/invalid arrays.
- [ ] Assert invalid optional readings are omitted while valid siblings survive, and unexpected sensor exceptions call the injected telemetry reporter.
- [ ] Run `rtk pnpm --filter @dofek/zepp test -- src/health-collector.test.ts` and confirm failures.
- [ ] Implement small domain normalizers (`finiteNumber`, `nonNegativeNumber`, `validTimestamp`) inside the collector module; keep them private and test through `collectHealthData`.
- [ ] Replace silent sensor catches with `captureException(error, { sensor, operation })` supplied by each runtime entry point.
- [ ] Re-run focused tests and the existing health-upload tests.
- [ ] Commit and push: `fix(zepp): normalize health sensor readings`.

### Task 3: Model connection status and correct settings actions

**Files:**
- Create: `packages/zepp/src/connection-state.ts`
- Create: `packages/zepp/src/connection-state.test.ts`
- Modify: `packages/zepp/setting/index.ts`
- Modify: `packages/zepp/setting/index.test.ts`
- Modify: `packages/zepp/workout-extension/setting/index.ts`
- Modify: `packages/zepp/workout-extension/setting/index.test.ts`
- Modify: `packages/zepp/app-side/index.ts`

- [ ] Write failing state-machine tests for `disconnected`, `pairing`, `checking`, `connected`, `disconnecting`, and `error`.
- [ ] Write failing settings-render tests: pairing/login are visible only while disconnected/error; check, sync, and disconnect are visible only after verified connection; reconnect requires disconnect.
- [ ] Run both settings suites and confirm failure.
- [ ] Implement one pure `deriveConnectionActions(state)` model shared by both packages.
- [ ] Change Side Service initialization to verify stored credentials and publish `checking` then `connected` or actionable `error`; token presence alone must never mean connected.
- [ ] On authentication failure, clear the invalid token and publish disconnected/error state. Report unexpected failures to telemetry.
- [ ] Run focused connection and settings tests.
- [ ] Commit and push: `fix(zepp): align connection state and settings actions`.

### Task 4: Separate the continuous Health Service from raw motion recording

**Files:**
- Create: `packages/zepp/src/health-service-control.ts`
- Create: `packages/zepp/src/health-service-control.test.ts`
- Rename: `packages/zepp/app-service/imu_service.ts` to `packages/zepp/app-service/health_service.ts`
- Modify: `packages/zepp/page/index.ts`
- Modify: `packages/zepp/app.json`
- Modify: `packages/zepp/src/storage-keys.ts`
- Modify: `packages/zepp/src/storage-keys.test.ts`
- Modify: `packages/zepp/build.ts`

- [ ] Add failing lifecycle tests proving launch/setup starts the Health Service after permission, start-recording does not control it, and permission denial returns an actionable status.
- [ ] Implement `ensureHealthServiceRunning({ queryPermission, requestPermission, startService })` as a pure dependency-injected orchestration function.
- [ ] Rename the service and storage constant to describe low-power health collection. Update existing static manifests directly and validate through the build rather than adding static-config tests.
- [ ] Call the health-service controller during normal app initialization and after setup. Remove the unsupported `setWakeUpRelaunch(true)` anchor assumption and the background-service coupling from recorder start/stop.
- [ ] Run service-control, session-control, storage-key, and build tests.
- [ ] Commit and push: `refactor(zepp): separate health service from recorder`.

### Task 5: Add a durable, idempotent watch outbox

**Files:**
- Create: `packages/zepp/src/durable-outbox.ts`
- Create: `packages/zepp/src/durable-outbox.test.ts`
- Modify: `packages/zepp/src/background-health-storage.ts`
- Modify: `packages/zepp/src/background-health-storage.test.ts`
- Modify: `packages/zepp/src/background-health.ts`
- Modify: `packages/zepp/src/background-health.test.ts`

- [ ] Add failing tests for append-once by event ID, ordered batching, acknowledgement, retry attempt recording, invalid-event quarantine with issue paths, corrupt-file failure, and restart recovery.
- [ ] Implement the canonical immutable entry model:

```ts
export interface OutboxEntry<T> {
  eventId: string;
  createdAt: string;
  payload: T;
  attempts: number;
  lastError?: string;
}

export interface DurableOutbox<T> {
  pending: OutboxEntry<T>[];
  quarantine: Array<OutboxEntry<T> & { issues: ValidationIssue[] }>;
}
```

- [ ] Migrate background-health storage to the outbox helper with stable IDs derived from install ID, source channel, and source timestamp; preserve any existing buffered records via one deterministic read migration.
- [ ] Keep collection append-only; validation can quarantine one event without discarding its valid siblings.
- [ ] Run outbox and background-health suites.
- [ ] Commit and push: `feat(zepp): persist health events in watch outbox`.

### Task 6: Add the durable phone outbox and serialized drains

**Files:**
- Create: `packages/zepp/src/sync-coordinator.ts`
- Create: `packages/zepp/src/sync-coordinator.test.ts`
- Create: `packages/zepp/src/phone-health-outbox.ts`
- Create: `packages/zepp/src/phone-health-outbox.test.ts`
- Modify: `packages/zepp/app-side/index.ts`
- Modify: `packages/zepp/src/health-upload.ts`
- Modify: `packages/zepp/src/health-upload.test.ts`

- [ ] Add failing tests proving overlapping background, on-init, on-connect, and manual triggers coalesce into one drain with one queued rerun.
- [ ] Add failing Settings Storage tests proving received watch items are persisted before acknowledgement and survive Side Service restart.
- [ ] Implement `SyncCoordinator.requestDrain(reason)` with a single in-flight promise and dirty-bit rerun; propagate terminal failures to telemetry and connection status.
- [ ] Change `health.upload` handling to persist the phone outbox transactionally, then acknowledge watch event IDs, then request a server drain.
- [ ] Remove phone entries only from server-returned accepted IDs. Retain retryable failures with attempt/error metadata; quarantine field-invalid entries.
- [ ] Wire drain triggers to Side Service init, successful connection verification, watch/App Service receipt, and manual sync.
- [ ] Run focused outbox/coordinator/upload suites.
- [ ] Commit and push: `feat(zepp): serialize durable health delivery`.

### Task 7: Make the server acknowledgement and idempotency contract executable

**Files:**
- Create: `packages/server/src/repositories/zepp-health-ingest-repository.ts`
- Create: `packages/server/src/repositories/zepp-health-ingest-repository.integration.test.ts`
- Modify: `packages/server/src/routes/ingest-zos-health.ts`
- Modify: `packages/server/src/routes/ingest-zos-health.test.ts`
- Modify: `packages/server/src/routes/ingest-zos-health.integration.test.ts`

- [ ] Write failing route tests for the v1 envelope, partial field validation, `{ acceptedEventIds, rejected }` response, and actionable errors.
- [ ] Write a real Postgres integration test that submits the same event IDs twice and proves canonical rows are unchanged on replay.
- [ ] Run `rtk pnpm --filter @dofek/server test -- src/routes/ingest-zos-health.test.ts` and the focused integration command from `docs/testing.md` to establish red.
- [ ] Move persistence behind a Zepp ingest repository and map every event to existing deterministic external IDs/upserts. Do not add duplicate storage solely for idempotency.
- [ ] Return acknowledgements only after the database transaction commits.
- [ ] Run route unit and real-database integration tests until green.
- [ ] Commit and push: `feat(server): acknowledge idempotent zepp health events`.

### Task 8: Prove and add App Service background BLE delivery

**Files:**
- Create: `packages/zepp/src/health-ble-protocol.ts`
- Create: `packages/zepp/src/health-ble-protocol.test.ts`
- Modify: `packages/zepp/app-service/health_service.ts`
- Modify: `packages/zepp/app-side/index.ts`
- Modify: `packages/zepp/src/env.d.ts`

- [ ] Add failing protocol tests for versioned `health.batch`, `health.ack`, duplicate receipt, reconnect replay, malformed frame rejection, and bounded frame size.
- [ ] Implement dependency-free binary/text frame encode/decode helpers with explicit message IDs and event IDs.
- [ ] Add an instrumented lifecycle probe using documented `@zos/ble` App Service support and Side Service peer socket. Capture start, connection, send, receipt, ack, disconnect, and retry events without sensitive payloads.
- [ ] Run the normal-app simulator with the display/page closed and verify the probe crosses App Service → Side Service. If the simulator cannot exercise the transport, record that limitation and run the same checklist on the paired T-Rex 3 before claiming background delivery.
- [ ] Only after the probe succeeds, send bounded watch-outbox batches and remove them on matching phone ACKs. On reconnect, replay pending items; duplicate phone receipt remains harmless.
- [ ] Run protocol tests plus app build and exercise disconnect/reconnect in simulator.
- [ ] Commit and push: `feat(zepp): deliver background health over acknowledged ble`.

### Task 9: Refactor one shared raw-motion session controller

**Files:**
- Create: `packages/zepp/src/display-lease.ts`
- Create: `packages/zepp/src/display-lease.test.ts`
- Create: `packages/zepp/src/imu-session-controller.ts`
- Create: `packages/zepp/src/imu-session-controller.test.ts`
- Modify: `packages/zepp/src/imu-collector.ts`
- Modify: `packages/zepp/page/index.ts`

- [ ] Add failing tests for acquire/release pairing around `pauseDropWristScreenOff()` and `resetDropWristScreenOff()`, including start failure, repeated stop, page destroy, and write failure.
- [ ] Add failing controller tests for accelerometer plus automatic supported gyroscope, accelerometer-only fallback, session metadata, flush/finalize, and exactly-once transfer request.
- [ ] Implement a composed `ImuSessionController` using the existing collector, binary formatter, and session-file writer. Treat gyroscope as a capability, not a user preference.
- [ ] Refactor the advanced normal-app recorder onto the controller. Remove the gyro toggle and unsupported background/always-on wording; display explicit `Foreground recorder — keep this screen open` status.
- [ ] Ensure all stop/destroy/error paths release the display lease.
- [ ] Run all IMU/session/display tests and the normal app build.
- [ ] Commit and push: `refactor(zepp): share foreground imu session controller`.

### Task 10: Add automatic workout-focused IMU segments

**Files:**
- Modify: `packages/zepp/workout-extension/data-widget/index.ts`
- Modify: `packages/zepp/src/workout-extension-data-widget.test.ts`
- Modify: `packages/zepp/src/workout-live.ts`
- Modify: `packages/zepp/src/workout-live.test.ts`
- Modify: `packages/zepp/src/session-file.ts`
- Modify: `packages/zepp/src/session-file.test.ts`

- [ ] Add failing lifecycle tests: focus/resume starts a segment, pause finalizes/transfers it, resume creates the next segment, destroy is idempotent, and repeated callbacks never create two collectors.
- [ ] Assert the extension still reports sport data and heart rate while raw IMU is active, and transfers include workout/source/segment metadata.
- [ ] Compose the same `ImuSessionController` into the data widget. Do not fork sensor, file, gyro, or display code.
- [ ] Make capability failure visible while preserving sport/heart-rate upload; report unexpected failures to telemetry.
- [ ] Run the workout lifecycle and build suites.
- [ ] Commit and push: `feat(zepp): record focused workout imu segments`.

### Task 11: Align documentation and approval assets

**Files:**
- Modify: `packages/zepp/README.md`
- Modify: `packages/zepp/workout-extension/README.md`
- Modify: `packages/zepp/AGENTS.md`
- Modify: `packages/zepp/workout-extension/AGENTS.md`
- Modify: `packages/zepp/store-screenshots/*` only if the current approval image remains noncompliant

- [ ] Document the exact ownership split: App Service low-power health, normal foreground advanced recorder, focused Workout Extension segments, and phone/server delivery triggers.
- [ ] Cite Zepp's official App Service restrictions, Workout Extension lifecycle, BLE, messaging, and display APIs for every third-party behavior claim.
- [ ] Remove claims that raw IMU/gyroscope continue after the Device App page exits.
- [ ] Verify every directory containing `AGENTS.md` still has `CLAUDE.md` and `GEMINI.md` symlinked to it.
- [ ] Validate preview images against Zepp's current app image rules and regenerate only if needed.
- [ ] Run `rtk git diff --check` and relevant markdown/link checks.
- [ ] Commit and push: `docs(zepp): align lifecycle and delivery guidance`.

### Task 12: Simulator and full verification

**Files:**
- Modify only behavior exposed as broken by the validation below, with a new failing regression test before each fix.

- [ ] Run `rtk pnpm --filter @dofek/zepp test`.
- [ ] Run `rtk pnpm --filter @dofek/zepp lint` and `rtk pnpm --filter @dofek/zepp typecheck`.
- [ ] Run `rtk pnpm --filter @dofek/zepp build` and `rtk pnpm --filter @dofek/zepp build:workout-extension`.
- [ ] Run focused server unit and real-database integration tests, then `rtk pnpm test:changed:all`.
- [ ] Start Zeus preview/dev only with its matching Paseo quick tunnel for the server lifetime; report only the emitted `https://…trycloudflare.com` URL.
- [ ] Exercise round and square simulator profiles for normal and workout packages: disconnected setup, pairing, verified connection, manual sync, structured invalid-payload error, retry recovery, duplicate/coalesced triggers, foreground recorder start/stop/destroy, gyro capability fallback, display lease cleanup, focus/pause/resume workout segments, and normal sport/HR rendering.
- [ ] Record simulator limitations and complete a physical T-Rex 3 checklist for real sensors, permission flow, background App Service BLE, phone disconnect/reconnect, app termination/relaunch, gyro availability, and battery observation.
- [ ] Inspect `rtk git status --short`, preserve `paseo.json`, review the complete diff, and run `rtk git diff --check`.
- [ ] Commit any regression fixes separately and push every commit.

## Completion Evidence

Completion requires: the original invalid payload reproducer now identifies the exact field or succeeds; credential actions match verified state; Health Service starts independently; all three health sync triggers converge on one durable serialized pipeline; advanced and workout raw IMU share one controller; display lease always resets; simulator checks pass to the platform's capability boundary; and any background BLE claim is backed by an observed acknowledged delivery on simulator or physical T-Rex 3.
