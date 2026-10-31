# WHOOP MG Background Sensors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Retain additional WHOOP background sensor records and serve verified temperature and raw sensor inspection to both clients.

**Architecture:** Extend the native SQLite/background upload pipeline with a sensor-record stream. Keep original frames canonical in the existing metric stream and decode their new fields on the server. Project verified temperature into existing source selection without writing daily Postgres state.

**Tech Stack:** Swift/CoreBluetooth/SQLite, TypeScript/Zod/tRPC, Redpanda/ClickHouse, React and React Native.

**Spec:** [Approved design](../specs/2026-10-30-whoop-mg-sensors-design.md).

## Global Constraints

- ECG commands, ECG waveforms, a recording flow, new clinical interpretations and computed SpO2/respiratory values are outside this change.
- Keep raw bytes canonical; derived readings are query-time projections, not new Postgres daily metrics or duplicated decoded storage.
- Both web and mobile consume the same protected server contract.
- Unknown sample spacing stays unknown.
- No new dependencies or environment variables are anticipated.
- New protocol interpretation requires reproducible captures; see the [native guide](../../../packages/mobile/modules/whoop-ble/AGENTS.md).

## Review Focus

- Capture retry after process recreation preserves identity and original frame bytes.
- Historical measurement dates differ from upload dates; measurement filters use source time.
- Unmapped layouts remain raw, with no manufactured Celsius or channel identity.
  The exact capture-backed R18 signature is decoded with calibration unverified;
  its [retained capture](../../../packages/mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv)
  has unknown firmware/model identity, so identity metadata is not an allowlist.
- A failed sensor upload leaves IMU/realtime progress independent.
- Account erasure removes sensor records and late completions cannot affect a new owner.

## Task 1: Versioned record contract and server decoder

**Files:** `packages/providers-meta/src/whoop-sensors.ts`, its colocated test and package export; `packages/server/src/services/whoop-sensor-decoder.ts` and its colocated test.

**Interfaces:** Shared `whoopSensorRecordSchema` defines captureId, timestamp (reception), frameHex and deviceInfo. `decodeWhoopSensorRecord(record)` returns packet/layout, source timestamp, temperature or raw fields, and explicit evidence status. `whoopSensorSnapshotSchema` is the shared client response.

- [x] Write failing tests using complete R18 frames from the existing TSV: raw thermal word, source clock, complete-frame integrity and unknown layouts. Constructed malformed fixtures test CRC/length errors and count bounds only.
- [x] Run `pnpm exec vitest run --project unit packages/server/src/services/whoop-sensor-decoder.test.ts packages/providers-meta/src/whoop-sensors.test.ts`; expect missing decoder/schema failures.
- [x] Implement bounded record schemas and a small frame decoder. R18 uses the capture-backed thermal word and retains counters/status untransformed. Other layouts remain raw until their independent capture evidence is available. No optical wavelength assignments or physiological calculations.
- [x] Re-run the command; expect all cases passing. Review provenance before connecting ingestion.

## Task 2: Native preservation and durable sensor uploads

**Files:** Native `WhoopBleFrameParser.swift`, new `WhoopBleSensorRecord.swift`, `WhoopBleSampleStore.swift`, `WhoopBleBackgroundUploader.swift`, `WhoopBleModule+ConnectionManagerDelegate.swift`, connection discovery/delegate files and relevant colocated XCTest files; `index.ts` and diagnostics types.

**Interfaces:** `WhoopFrame.rawData` preserves each validated complete frame. `WhoopBleSensorRecord.serialize(frame:deviceInfo:receivedAt:)` creates one stable captureId per received record. `WhoopUploadStream.sensorRecords` routes to `whoopBleSync.pushSensorRecords`.

- [x] Add failing XCTest cases proving exact frame preservation through fragmentation and a reopened SQLite sensor reservation, acknowledgment isolation, account erasure, and independence from failed realtime/IMU delivery.
- [x] Run `swift test --package-path packages/mobile/modules/whoop-ble`; expect the new API/stream cases to fail.
- [x] Implement the additional stream using existing queue ownership and background scheduling. Bound sensor reservations by bytes as well as count. Keep device information optional when not yet observed, and read standard Device Information characteristics without changing persistent sensor settings.
- [x] Route new sensor records before discarding empty legacy extractions. Keep existing IMU/HR extraction intact. Do not capture excluded ECG layouts.
- [x] Re-run Swift tests and TypeScript bridge typechecks; review durable-write ordering before history acknowledgment. Expo application/bridge compilation is deferred pending Infisical authentication.

## Task 3: Ingestion, raw-record reads and temperature source selection

**Files:** `packages/server/src/routers/whoop-ble-sync.ts`, `packages/server/src/repositories/whoop-ble-sync-repository.ts`, new `whoop-sensor-repository.ts`, colocated router/repository tests, executable integration tests, `daily-metrics-spo2-query.ts` and its integration coverage.

**Interfaces:** Protected `pushSensorRecords({deviceId,samples,telemetry})` returns `{inserted}` only after publication. Protected `sensorSnapshot` returns the shared snapshot. Repository uses captureId for stable retry identity; `sensor_record` metadata is the canonical storage.

- [x] Write failing router tests for raw-byte preservation, stable identity, provenance, rejected CRC/oversized inputs and publication failures.
- [x] Implement bounded schemas and repository publication through `writeMetricStreamRows`, with existing telemetry and Sentry reporting. Store reception `recordedAt` separately from raw device clock and source-time query projections.
- [x] Add real ClickHouse/Postgres integration fixtures for delayed R18 offload, provider ownership, tombstones and priority selection versus API temperature. New temperature is a read-only projection from retained records, not a second stored scalar.
- [x] Execute `pnpm test:integration` scoped to the new repository/source-selection integration files; expect passing engine behavior. Keep existing SpO2 resolution unchanged.

## Task 4: Both clients and docs

**Files:** New web `WhoopSensorDetails.tsx` and mobile `WhoopSensorDetails.tsx`, their tests/stories, existing provider detail pages, relevant READMEs and `docs/whoop-ble-protocol.md`.

**Interfaces:** Both details consume `whoopBleSync.sensorSnapshot` and render server-supplied labels/values. Mobile acquisition remains native; web has no remote capture controls.

- [x] Add failing component tests for temperature/provenance, raw-only records, empty capture, expanded optical/raw details, actionable errors and retained data on refetch.
- [x] Implement compact accessible details on both WHOOP BLE provider pages. Use disclosure controls and existing formatting/query-state conventions; no client metric calculations or invented waveform time axes.
- [x] Run affected unit/mobile tests and typechecks. Build stories, visually inspect both clients, and use a quick tunnel for every HTTP development server started.
- [x] Update protocol docs with exact capture provenance, new pipeline ownership and remaining optical/calibration boundaries; correct the claim that skin temperature is derived from optical data.

## Task 5: Whole-change verification and review

- [x] Run native Swift tests, affected TypeScript tests, owned-file lint, typechecks and Swift export checks; record the Expo app/bridge build prerequisite failure separately.
- [ ] Build the Expo iOS application/bridge after Infisical authentication. User explicitly deferred this check to finish available checks first.
- [x] Request one fresh whole-branch review, resolve important findings with a failing regression test first, then run the necessary checks again.
- [x] Commit and push the implementation automatically on the current branch. Do not switch branches, deploy or publish.
- [x] Report physical MG/overnight validation as pending unless performed. Document the next capture needed for any raw-only optical layouts.

## Working notes

Design approved by the user on 2026-10-30. Execute inline on the existing isolated branch; existing authorization covers implementation, commits and pushes. Interface review: native sensor records and server input share the same wire schema; client snapshot and repository output share a Zod contract. Capture-backed R18 interpretation is available; optical maps must remain raw-only unless further evidence is found.


Final review and validation: full unit/mobile suite 23,620 passed, 19 skipped;
standalone Swift 165 passed; real ClickHouse/Postgres suites 19 passed plus a
strengthened replay fixture 2 passed. Review fixes have 193 affected mobile tests
passing. Review found optional Device Information discovery could abort capture
and missing mobile queue status; both received regression tests and fixes.
R18 mapping remains capture-backed and calibration unverified, as approved;
unknown optical maps and physical MG availability remain unverified. See the
[decoder](../../../packages/server/src/services/whoop-sensor-decoder.ts) and
[original capture](../../../packages/mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv).

Root/server/web/mobile typechecks, Swift exports, Swiftlint, sandbox lint and
analytics SQL lint passed. SQLFluff retained its configured large-file skips.
The final required/optional characteristic error routing suite passed 7 tests.
