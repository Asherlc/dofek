# Body Metrics Timezone Filter TDD Plan

> **For agentic workers:** Use the repository's test-driven-development and
> integration-test readiness workflows. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make exact-range body-metric reads filter the native ClickHouse
`DateTime64` value before serializing timestamps for the API.

**Behavior:** `BodyRepository.listRange()` returns measurements whose timestamps
fall inside the requested inclusive local-date range without passing a `String`
alias to `toTimeZone`.

**Scope:** Change the body repository query and add a real ClickHouse regression
test. Do not change the serving view, MCP contract, schemas, or unrelated body
queries.

**Docs:** [ClickHouse explains that aliases can be reused throughout a query and
recommends a subquery as the portable way to scope derived
expressions](https://presentations.clickhouse.com/meetup70/modern_sql/).

---

## Current Evidence

- `BodyRepository.listRange()` projects
  `toString(recorded_at) AS recorded_at` while its `WHERE` clause calls
  `toTimeZone(recorded_at, ...)`.
- ClickHouse resolves the `WHERE` identifier to the projected `String` alias
  and raises `Illegal type String of argument of function toTimezone`.
- `BodyRepository.list()` already avoids this collision by filtering raw
  timestamps in an inner `body_measurements` query and serializing them only in
  the outer projection.

## Test Strategy

- Unit: Retain the existing repository mapping and parameter tests.
- Integration: Seed isolated ClickHouse body samples on opposite sides of a
  local-date boundary, call `listRange()` through the real query runner, and
  assert that only the in-range local date is returned.
- UI/mobile/web parity: Not applicable; the MCP and router share this
  server-side repository behavior.

## File Structure

- Create:
  `packages/server/src/repositories/body-repository.integration.test.ts` -
  execute the range query against an isolated real ClickHouse database.
- Modify: `packages/server/src/repositories/body-repository.ts` - scope raw
  timestamp filtering to an inner query.

## Tasks

### Task 1: Add the Failing Integration Test

- [ ] Seed two measurements straddling the requested local-date boundary.
- [ ] Run
  `rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration packages/server/src/repositories/body-repository.integration.test.ts'`.
- [ ] Confirm the query fails because `toTimeZone` receives the stringified
  `recorded_at` alias.

### Task 2: Implement the Minimal Query Fix

- [ ] Filter raw `recorded_at` values inside an inner `body_measurements`
  subquery.
- [ ] Serialize `recorded_at`, `created_at`, IDs, and the remaining fields only
  in the outer projection.
- [ ] Re-run the focused integration test and confirm the local-date boundary
  behavior passes.

### Task 3: Final Verification

- [ ] Run the existing body repository unit tests.
- [ ] Run the relevant lint, typecheck, and changed-test commands.
- [ ] Review the sibling body queries for the same alias collision without
  broadening the change beyond confirmed occurrences.
- [ ] Commit, push, open the linked PR, monitor CI and reviews, and merge only
  after every required check passes.
