# Peloton Origin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkboxes for tracking.

**Goal:** Display native Peloton as the workout origin with parallel WHOOP recordings retained.
**Architecture:** Extend the existing PostgreSQL and dbt origin rules; keep clients consuming the shared server result.
**Tech Stack:** PostgreSQL SQL, ClickHouse dbt SQL, Vitest real-engine integration tests.
**Spec:** [Approved direction and implementation constraints](../specs/2026-10-27-peloton-origin-design.md).

## Global Constraints

Native recognition requires normalized `platform=home_bike` and `deviceType` in `bike`, `home_bike_plus`. Explicit normalized Strava `Peloton Bike` labels establish export attribution. Preserve independent WHOOP recordings, conflict/cycle checks, and ambiguity for multiple initiators. No provider-priority fallback, new dependencies, raw-data writes, branch switching, or production operations. PostgreSQL and ClickHouse must agree.

## Review Focus

Tests must cover WHOOP-imported Peloton copies, missing/null native fields, contradictory metadata, multiple native initiators or Apple Watch competition, and exact independent transfer branches.

### Task 1: Correct both origin resolvers

**Files:** Modify `src/test-fixtures/activity-origin.json`, `src/db/activity-origin.integration.test.ts`, `src/db/activity-origin-read-model.integration.test.ts`, `drizzle/_views/00_activity_origin.sql`, `analytics/macros/activity_origin.sql`; create `drizzle/0169_peloton_activity_origin.sql` and register it in `drizzle/meta/_journal.json`. Update the existing database/analytics README origin sections if needed.

**Interfaces:** Existing resolver inputs and outputs remain unchanged. Shared fixtures feed both real-engine suites. The migration replaces only the origin function.

- [x] Add shared fixtures and view/evidence assertions: native Bike/Bike+ wins alongside WHOOP; Strava is a Peloton child; WHOOP remains the parent of its Health copy; incomplete, conflicting and ambiguous initiation remains unresolved.
- [x] Run `pnpm test:integration -- src/db/activity-origin.integration.test.ts src/db/activity-origin-read-model.integration.test.ts --maxWorkers 1 --no-file-parallelism`; capture expected failures before changing implementation.
- [x] Extend both resolvers and add/register the forward-only function migration.
- [x] Rerun the same integration suites; review spec compliance and SQL quality independently.
- [ ] Run analytics build, migration/analytics lint, typechecks and relevant unit/mobile rendering suites; record evidence in the incident baseline, commit and push, then obtain whole-branch review before opening the PR.
