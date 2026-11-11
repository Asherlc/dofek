# Overview Loading Implementation Plan

Execute task by task with explicit review checkpoints.

**Goal:** Remove raw-log scanning from overview oxygen and temperature queries.

**Architecture:** A bounded incremental daily dbt model holds decoded typed samples.
Existing API grouping preserves caller timezones and source selection for both clients.

**Tech stack:** Existing ClickHouse, dbt, TypeScript, Vitest.

**Spec:** [Approved direction and design](../specs/2026-11-09-overview-loading-design.md).

## Global constraints

No new dependencies, client contracts, services, retries, timeouts or fallback reads.
Preserve corrections, tombstones, replay deduplication and per-device provenance.
Reuse existing source-day markers and bounded dbt execution; do not backfill in migrations.

## Review focus

- Caller timezone changes must retain accurate day boundaries.
- Delayed WHOOP frames belong to their measurement day.
- Deleting the final valid sample must clear its previous model output.
- Incremental progress must not skip older dirty days.
- Provider and device priorities remain query-time choices.

### Task 1: Daily model and executable regression

- [x] Add a real ClickHouse fixture for initial and incremental daily model builds.
- [x] Observe failure before implementing the model.
- [x] Implement `daily_health_sensor.sql` using existing day markers and bounded dirty keys.
- [x] Cover oxygen normalization, WHOOP decode, corrections, deletion, replay and foreign users.
- [x] Run focused integration tests and review the model.

### Task 2: Shared serving queries and scheduling

- [x] Replace oxygen and temperature raw reads with the daily model's typed samples.
- [x] Reuse a small shared SQL CTE; keep existing daily/source selection behavior.
- [x] Adapt existing integration fixtures to build current models explicitly.
- [x] Register the model in analytics execution and processing dataset contracts.
- [x] Run focused server integration and unit tests; review the actual diff.

### Task 3: Validation and closure

- [x] Run typechecks, analytics SQL/policy lint and relevant tests.
- [x] Obtain a fresh final review and address substantive findings.
- [x] Document bounded initialization, production evidence and remaining rollout risk.
- [x] Commit and push on the existing branch; do not switch branches or deploy without authorization.

## Verification and review record

The full unit/mobile tier passed 23,966 tests. Four focused database suites
passed 26 tests, including native initial/incremental dbt builds and a raw-read
regression over 100,000 unrelated sensor rows. Lint and root/server/web
typechecks passed. The broader router-SQL fixture reached an existing
activity-origin query memory limit before selected assertions; see the
[incident baseline](../../production-incident-baseline.md#2026-11-09--overview-oxygen-and-temperature-raw-scans-time-out).

Fresh review identified unbounded raw `FINAL` access, missing shared fixture
schema, and cold-start/cutover readiness. The fix uses an existing projection
to select complete replacement keys before `FINAL`; the raw-read test failed
at 100,063 rows and then passed below 50,000. Shared fixtures execute the
canonical schema/model, and schema-only migration 0111 plus the
[cutover gate](../../clickhouse-read-model-deploy-runbook.md#overview-oxygen-and-temperature-cutover)
address initialization. The user approved production preparation and merging.
Projection materialization completed, 45 missing historical health day markers
were bootstrapped, and 140 bounded model invocations initialized 4,474 days.
The source-to-target check returned zero missing and dirty days; the serving
smoke query took 51 ms. See [PR preparation evidence](https://github.com/Asherlc/dofek/pull/3247).
Processing success alone is deliberately not claimed as proof of an empty backlog.
