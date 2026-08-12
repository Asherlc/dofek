# Task 3 Report: Persist Hang Ten workout intervals

## Status

Implemented and committed the Hang Ten persistence layer. The implementation
uses the finalized historical behavior from commits `cdf418e6f`, `b9eaa8cd2`,
`e9a193e4a`, and `c4a653992` for interval construction, activity upserts,
reimport handling, and malformed metadata reporting.

## Files

Changed exactly the files named by the Task 3 brief:

- `src/providers/apple-health/hang-ten-intervals.ts`
- `src/providers/apple-health/hang-ten-intervals.test.ts`
- `src/providers/apple-health/db-insertion.ts`
- `src/providers/apple-health/db-insertion.test.ts`
- `src/providers/apple-health/db-insertion.integration.test.ts`
- `src/providers/apple-health/import.ts`
- `src/providers/apple-health/import.test.ts`
- `src/providers/apple-health/import.integration.test.ts`
- `src/providers/apple-health/test-helpers.ts`

The pre-existing untracked `paseo.json` was preserved and not staged.

## Implemented behavior

- Added Hang Ten interval labels for work, hold-size/type, and rest segments.
- Built ordered `work`/`rest` interval rows with conservative end-time
  derivation after unknown durations.
- Replaced an activity's intervals atomically in one SQL statement, deleting
  stale intervals before inserting the replacement set.
- Deduplicated workouts by `workoutExternalId`.
- Persisted workout duration, distance, and heart-rate metadata in the raw
  payload, including typed `raw.hangTen` metadata.
- Persisted Hang Ten activities as canonical `hangboard` activities named by
  their plan and sourced from `Hang Ten`.
- Updated Hang Ten names on reimport while preserving ordinary workout names.
- Preserved malformed segment metadata on the activity and reported a specific,
  non-fatal sync error containing the workout external ID.
- Did not add provider-estimated calorie or expenditure data.

## Tests and exact outcomes

### TDD RED

Command:

```text
rtk pnpm vitest src/providers/apple-health/hang-ten-intervals.test.ts src/providers/apple-health/db-insertion.test.ts src/providers/apple-health/import.test.ts
```

Outcome: expected failure. Three test files ran; 200 tests passed and 4
Hang Ten tests failed because the interval helper and persistence/import
behavior were not yet implemented. The interval test file also failed to load
because `hang-ten-intervals.ts` did not exist.

### Focused GREEN validation

Command:

```text
rtk pnpm vitest src/providers/apple-health/hang-ten-intervals.test.ts src/providers/apple-health/db-insertion.test.ts src/providers/apple-health/import.test.ts
```

Outcome: passed. 3 test files, 203 tests passed.

### TypeScript

Command:

```text
rtk pnpm typecheck
```

Outcome: passed with `TypeScript: No errors found`.

### Scoped formatting and lint

Command:

```text
rtk pnpm exec biome check src/providers/apple-health/hang-ten-intervals.ts src/providers/apple-health/hang-ten-intervals.test.ts src/providers/apple-health/db-insertion.ts src/providers/apple-health/db-insertion.test.ts src/providers/apple-health/db-insertion.integration.test.ts src/providers/apple-health/import.ts src/providers/apple-health/import.test.ts src/providers/apple-health/import.integration.test.ts src/providers/apple-health/test-helpers.ts
```

Outcome: passed. All 9 Task 3 files checked with no fixes required.

The full `rtk pnpm lint` command passed its exact-version, Biome, suppression,
workflow-download, migration-policy, mobile telemetry, web story, review
scenario, and mobile route checks, then stopped in the ClickHouse SQL lint
phase because the local ClickHouse service was unavailable at
`127.0.0.1:65384`.

### Database integration

Command:

```text
rtk pnpm test:integration -- src/providers/apple-health/db-insertion.integration.test.ts src/providers/apple-health/import.integration.test.ts
```

Outcome: not executed. The first attempt could not connect to the Docker
daemon. After starting Docker Desktop and confirming `docker info` reported a
healthy server, the retry stopped before test execution because Docker could
not create the workspace network: `all predefined address pools have been fully
subnetted`. Existing unrelated workspace networks were left untouched.

## Commits

- `b8ac48158e4c58cefe373ce0a906764b110b8e13` — `feat: persist Hang Ten workout intervals`

## Concerns

- The two requested Postgres integration suites remain unverified locally due
  to Docker network address-pool exhaustion before Compose startup.
- Full repository lint remains incomplete only at the ClickHouse SQL stage
  because its service was unavailable; all preceding lint stages and the
  scoped Biome check passed.
- CI or a host with available Compose network capacity should run the exact
  integration command before merge.

## Retrospective

- **Root cause:** Docker network address pools were exhausted before the
  requested integration suites could start.
- **Direct fix:** No runtime mitigation was shipped; hosted CI must execute the
  named integration suites until Docker network capacity is recovered.
- **Remaining risk:** Local integration coverage remains unexecuted, with the
  exact command and evidence retained above.
- **Improvement:** Document Docker network-pool recovery in
  [`docs/testing.md`](../../../docs/testing.md).
