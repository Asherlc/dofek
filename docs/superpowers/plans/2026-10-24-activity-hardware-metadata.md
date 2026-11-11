# Activity Hardware Metadata Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans, with tests first and explicit review checkpoints.

**Goal:** Retain provider-reported activity hardware and show it consistently on web/iOS.

**Architecture:** Bounded FIT device-message streaming into raw activity observations; existing API raw payloads remain canonical. A server normalization/repository boundary supplies shared hardware contracts and enriches display labels without changing metric selection.

**Tech Stack:** Existing C++ FIT SDK, TypeScript, Drizzle/Postgres, tRPC, React/React Native, Vitest, CMake/CTest.

**Spec:** `docs/superpowers/specs/2026-10-24-activity-hardware-metadata-design.md`

## Global Constraints

- Implement web and iOS together; add no dependencies.
- Preserve source IDs/order/defaults/priorities, `source_name`, stream `device_id`, and measurement classifications.
- Preserve all raw hardware messages; consolidate only at read time. Do not guess per-sample sensor attribution.
- Keep FIT protocol bounded to 250 messages/512 KiB with acknowledgement backpressure.
- Preserve ownership, access windows and activity visibility; report unexpected errors through existing telemetry.
- Stay on the current branch; root commits and automatically pushes completed changes.

## Review Focus

- Repeated device messages with partial later fields retain identity and expose the latest reported details.
- Ambiguous, missing, coarse, and unsupported hardware fields never become a guessed exact device.
- Reimport is idempotent and cannot associate observations with another user's activity.
- Labels change while source IDs/order/default selections and numeric results remain unchanged.
- Both clients handle no metadata, partial metadata, errors, and accessible disclosure.

### Task 1: Native FIT protocol and TypeScript adapter

**Ownership:** `native/fit-decoder/**`, `src/fit/stream-decoder.ts`, its tests and `src/fit/README.md` only.

**Produces:** Metadata `fileId: Record<string,unknown> | null`; protocol `devices` with raw `device_info` messages; required `FitStreamConsumer.onDeviceInfoBatch(messages: Record<string,unknown>[]): Promise<void>`. End count includes device messages. Update direct consumer fixtures for new required callback only, coordinating with Task 2 for import-job tests.

- [x] Write native/adapter failing tests, verify RED, implement bounded device streaming and file ID retention, verify GREEN.
- [x] Build with presets, run CTest and targeted adapter tests; update protocol docs and self-review.

### Task 2: Canonical raw observations and provider ingestion

**Ownership:** `src/db/schema/activity.ts`, new `src/db/activity-device-observations.ts` and integration tests, forward Drizzle migration/journal, FIT import job/tests, Polar provider parsing/persistence/tests. Task 3 owns the shared response schema and package export.

**Consumes:** Task 1 callback and metadata. **Produces:** `fitness.activity_device_observation(activity_id, sequence, message_type, raw)` and a bounded append/replacement writer. Preserve raw FIT messages, with sequence unique per activity; retain Polar model/ID in activity raw without rewriting sourceName.

- [x] Write real database and import/provider failing tests, observe RED, implement schema/writer and staged FIT device replay, verify GREEN.
- [x] Validate migration with schema-aware tooling, ensure cascade/ownership/reimport behavior, and self-review.

### Task 3: Shared hardware view, activity API and web/iOS presentation

**Ownership:** shared `packages/providers-meta/src/activity-hardware.ts` and package export; server hardware models/repositories/contracts, activity router/repository, activity metric-source labeling and relevant tests; both activity detail pages and new hardware panel/components/tests/stories.

**Consumes:** Raw observation table from Task 2, existing activity raw/provider/sourceName data and raw sample `device_name` from Task 4. **Produces:** Zod-validated shared hardware response, owned `activity.hardware`, source display labels and both detail sections. Agree the shared schema with Task 2 before editing the same package files.

- [x] Write failing provider normalization/API/integration/UI tests and observe RED.
- [x] Normalize FIT using existing official SDK profile plus actual provider fields (Strava, Polar, Peloton, HealthKit, Ride with GPS, Zepp); keep limitations explicit. Add ownership-safe query and source-label enrichment without source-selection changes.
- [x] Implement concise web/iOS hardware disclosure with states and stories; verify GREEN and self-review.

### Task 4: Native capture metadata

**Ownership:** HealthKit native bridge/TypeScript types and server HealthKit sync payload processing; standard BLE HR upload client/server/writer and source metadata tests. Do not edit Task 3's common source-label query while it is active.

**Produces:** Optional HealthKit `device` raw facts (name/model/manufacturer/hardware/firmware/software/identifiers where available) on workout payloads; BLE upload `deviceName` retained as metric metadata key `device_name` while existing device UUID/source identity remains unchanged.

- [x] Write focused failing tests first, retain the available raw facts through bridge/upload/server, verify GREEN.
- [x] Validate native changes with appropriate build tests and self-review.

### Task 5: Independent review and completion

- [x] Review code/spec compliance independently, fix material findings with regression tests.
- [x] Run focused native/unit/mobile/integration suites and required type/lint/build/size checks.
- [x] Inspect both platforms' representative stories; every HTTP development server must keep its quick tunnel running.
- [x] Update active FIT/provider/UI documentation with source citations, coverage and historical-data limits.
- [x] Commit and push the completed implementation on the existing branch.

## Verification record

- Independent reviews approved ingestion/protocol and API/native/UI after regression tests fixed conflicting device identities and distinguished FIT file creators from recorders.
- Final affected TypeScript/mobile suites: 541 tests in 17 files. Final Postgres/ClickHouse suites: 39 tests in five files. The migration formatting follow-up also reran all four observation integration tests successfully.
- Native validation: three FIT CTests and 145 HealthKit/BLE Swift tests passed. The signed iOS Simulator Debug app compiled successfully and passed deep/strict code-sign verification. Physical sensor capture was not exercised.
- Root and package typechecks, repository sandbox lint, SQLFluff, Drizzle migration check, web production build, bundle size limits and diff whitespace checks passed.
- Browser interaction/visual checks covered recorder/sensors, partial data, empty data and cached-error states on both web and mobile stories. Native disclosure state was covered by component tests.
- The original FIT-retention paths were audited and documented; no archival policy, production configuration or historical data was changed. Newly captured metadata requires a new sync/reimport where the original payload did not already contain it.

## Retrospective

Parallel protocol/storage/presentation/native ownership kept the shared contracts explicit. Independent review found two meaningful attribution edge cases, both now covered by regression tests. Local Docker network exhaustion and an unrelated broad ClickHouse bootstrap required investigation; the incident record preserves the evidence and focused fixture approach.

For the next ingestion task, use the integration-tests-ready and test-driven-development workflows. Proposed documentation improvement: add a minimal raw-stream/scalar-sample fixture recipe to `docs/testing.md`, and agree a single original-file retention policy before extending archive behavior.
