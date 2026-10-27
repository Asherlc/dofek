# Task 11C integration repair and verification report

Date: 2026-09-08

Starting revision: `807514272` (`Document Task 11B verification`)

Scope: repair changed integration fixtures and stable-ID expectations, preserve fail-loud production behavior, and verify the clean ClickHouse 0078 baseline. No branch switch, memory-limit increase, timeout increase, skipped test, or `v_activity` query rewrite was made.

## Clean ClickHouse baseline

The workspace-scoped disposable test state was reset with:

```text
rtk pnpm compose -- down --remove-orphans --volumes
```

Result: exit 0; only the `sudden-buffalo` containers, network, and named volumes were removed.

The clean migration test was then run:

```text
rtk pnpm test:integration -- src/db/clickhouse-migrations/0078_stable_activity_read_views.integration.test.ts --maxWorkers=1
```

Result: exit 0; 1 file and 3 tests passed in 1.19 s. The prior 1.25 GiB failure was not intrinsic on a clean workspace stack, so the strategy gate correctly stopped before any materialized-CTE or `v_activity` production change. Retained test schemas/resource pressure caused the earlier failure in this environment.

## Confirmed failures and fixes

### Activity integrity fixture and CDC verification

RED command:

```text
rtk pnpm test:integration -- src/db/activity-data-integrity-repair.integration.test.ts --maxWorkers=1
```

Initial result: exit 1. First fatal was ClickHouse code 60 for missing `activity_integrity_<suffix>.body_measurement`; the next independent fatal was code 47 for unknown `channel` in `location_versions`.

Fixes:

- Completed the fixture with the current `metric_stream` contract and the body-measurement, profile, current-profile, and resting-heart-rate tables consumed by the selected production dbt graph.
- Seeded one active sensor sample for each canonical group needed by the integrity assertions.
- Preserved the full production model selection and all fail-loud membership checks.

Once the schema fixture reached rollback, it exposed two production parsing/matching boundaries:

1. Optional audit fields may be absent in an older artifact while ClickHouse `Nullable` JSON returns explicit `null`. A focused unit test failed with `PostgreSQL CDC mirror did not publish 1 repaired activities within 10ms`. The matcher now normalizes only `undefined`/`null` with `?? null`; meaningful falsy values such as numeric `0` are not coerced.
2. ClickHouse serialized UTC `DateTime64` as `2026-09-01 14:55:54.123456` without a zone. Under the host timezone, `z.coerce.date()` produced `2026-09-01T21:55:54.123Z`. A focused schema test expected `14:55:54.123Z` and failed. The source-row schema now treats only the exact unzoned ClickHouse DateTime64 form as UTC and leaves already-zoned inputs unchanged.

TDD command:

```text
rtk pnpm vitest run src/db/activity-data-integrity-clickhouse.test.ts
```

Results: first RED exit 1 (1 failed, 32 passed); first GREEN exit 0 (33 passed). Timestamp RED exit 1 (1 failed, 33 passed; expected `14:55:54.123Z`, received `21:55:54.123Z`); final GREEN exit 0 (34 passed).

Final executable database command:

```text
rtk pnpm test:integration -- src/db/activity-data-integrity-repair.integration.test.ts --maxWorkers=1 --retry=0
```

Result: exit 0; 1 file and 1 test passed in 45.90 s, including all three 12-model dbt phases.

### Sensor summary fixture

RED command:

```text
rtk pnpm test:integration -- packages/server/src/routers/activity-sensor-summary-read-model.integration.test.ts --maxWorkers=1
```

Result: exit 1; ClickHouse code 62 because literal `{{ ref('deduped_activities') }}` reached executable SQL.

Fix: the renderer now resolves the current `deduped_activities` ref, creates its minimal executable schema, seeds the stable activity ID, and removes the obsolete raw-Postgres activity fixture.

GREEN result: exit 0; 1 file and 1 test passed.

### Stable activity IDs

Narrow RED commands proved stale visible IDs and missing intended group identities:

```text
rtk pnpm test:integration -- packages/server/src/routers/activity.integration.test.ts packages/server/src/routers/climbing.integration.test.ts packages/server/src/repositories/hangboarding-repository.integration.test.ts --maxWorkers=1
```

Result: exit 1; 7 failed and 19 passed.

```text
rtk pnpm test:integration -- packages/server/src/routers/router-data.integration.test.ts packages/server/src/routers/router-logic.integration.test.ts --maxWorkers=1
```

Result: exit 1; 2 failed and 77 passed.

Fixes:

- Activity router assertions and sensor mocks use returned stable group IDs; raw member IDs remain in metric-stream provenance and member-resolution requests. The missing identity/window path now asserts the intended actionable `NOT_FOUND` contract instead of an empty array.
- Climbing resolves and asserts the visible route group ID while retaining member IDs for foreign keys.
- Hangboarding assigns its intended duplicate members one shared group.
- Router-data uses group IDs for public response and derived-model fixture keys while retaining raw IDs for source rows.
- Router-logic requests interval detection by stable group ID while metric samples/interval FKs retain raw member IDs.

GREEN results: activity/climbing/hangboarding passed 26/26; router-data/router-logic passed 79/79.

### Additional changed-gate fixture drift

The single canonical changed gate exposed three more current-contract fixture failures:

- `analytics-microbatch-bounds.integration.test.ts`: production `activity_sensor_sample` required `deduped.member_activity_ids`, then `deduped.refreshed_at`. Both current fields were added to the minimal fixture. Narrow GREEN: 1/1 in 16.86 s.
- `activity-power-curve-read-model.integration.test.ts`: 5/8 failed even alone on a freshly reset stack because singleton activities omitted `group_id`; generated stable IDs no longer matched raw metric activity IDs or expected model IDs. The fixture now sets `group_id = id`. Narrow GREEN: 8/8 in 40.84 s.
- `activity-type-classification.integration.test.ts` and `hang-ten-activity-priority.integration.test.ts`: intended duplicate members omitted a shared group, so the former returned two canonical rows and the latter never exercised priority across one group. Each fixture now assigns one explicit shared group. Narrow GREEN: 2 files, 3/3 tests.

## Canonical changed gate

After another workspace-scoped Compose volume reset, the canonical command was run exactly once:

```text
rtk pnpm test:changed:all
```

Result before the additional narrow fixture repairs: exit 1 after 553.78 s; 427 files and 7,765 tests passed, while 7 files and 12 tests failed.

Failing files/tests:

- `src/processing/analytics-microbatch-bounds.integration.test.ts`: 1 failure; first model fatal was ClickHouse code 47, unresolved `deduped.member_activity_ids`.
- `packages/server/src/routers/activity-power-curve-read-model.integration.test.ts`: 5 failures returning no power-curve rows.
- `src/db/activity-type-classification.integration.test.ts`: 1 failure returning two groups; retry then collided with the retained fixture's unique provider/external key.
- `src/db/hang-ten-activity-priority.integration.test.ts`: 1 failure; Apple Health remained selected after deleting Hang Ten priority because the two rows were not in one persisted group.
- `src/providers/wahoo-sync.integration.test.ts`: 2 failures caused by `Unable to start the native FIT decoder`.
- `src/providers/suunto-sync.integration.test.ts`: 1 failure caused by the same missing decoder.
- `src/providers/coros-sync.integration.test.ts`: 1 failure caused by the same missing decoder.

ClickHouse emitted transient `ECONNRESET` pings during this highly concurrent run, but immediate container inspection showed it running and healthy with `OOMKilled:false`, exit code 0, and no restart. The canonical broad command was intentionally not rerun, per the Task 11C instruction. Every non-FIT failure above subsequently passed in a narrow executable test.

## Final focused verification

```text
rtk pnpm vitest run src/db/activity-data-integrity-clickhouse.test.ts
```

Result: exit 0; 34/34 tests passed.

```text
rtk pnpm test:integration -- src/db/activity-data-integrity-repair.integration.test.ts packages/server/src/routers/activity-sensor-summary-read-model.integration.test.ts packages/server/src/routers/activity.integration.test.ts packages/server/src/routers/climbing.integration.test.ts packages/server/src/repositories/hangboarding-repository.integration.test.ts packages/server/src/routers/router-data.integration.test.ts packages/server/src/routers/router-logic.integration.test.ts src/processing/analytics-microbatch-bounds.integration.test.ts packages/server/src/routers/activity-power-curve-read-model.integration.test.ts src/db/activity-type-classification.integration.test.ts src/db/hang-ten-activity-priority.integration.test.ts --maxWorkers=1 --retry=0
```

Result: exit 0; 11 files and 119/119 tests passed in 136.40 s.

```text
rtk pnpm lint
```

Result: exit 0. The first sandboxed attempt failed only because tsx could not create its local IPC listener (`listen EPERM .../tsx-502/...pipe`); the identical command outside the sandbox passed. SQLFluff retained its existing warning that `deduped_activities.sql` exceeds its parser-size threshold.

```text
rtk pnpm typecheck
```

Result: exit 0; `TypeScript: No errors found`.

## Residual environment prerequisite

`file .build/fit-decoder/bin/dofek-fit-decoder` reports that the file does not exist. `/opt/homebrew/bin/vcpkg` exists, but it is Homebrew vcpkg `2026-07-13`, not the required full checkout pinned to commit `9e593bb18ea69cc5095e012465dcd675a822ed0d`. No pinned checkout is locally available, so no untracked decoder build was attempted and no FIT production/test/dependency change was made. The documented remedy remains:

```text
VCPKG_ROOT=/path/to/full/pinned/vcpkg/checkout pnpm build:fit-decoder
file .build/fit-decoder/bin/dofek-fit-decoder
```

Then rerun the Wahoo, Suunto, and COROS FIT-backed integration files.

## Retrospective

The clean-reset-first sequence prevented an unnecessary `v_activity` rewrite, and serial narrow tests separated fixture-contract regressions from the missing native toolchain. The most investigation was required at the CDC boundary, where correct ClickHouse row values still failed because unzoned UTC timestamps were interpreted in the workstation timezone. Future context would be clearer if `docs/testing.md` explicitly stated that ClickHouse JSON DateTime strings are unzoned and must be parsed as the column timezone, and if changed integration fixtures had a reusable current `deduped_activities` schema builder. The useful skills for similar work are `integration-tests-ready`, `superpowers:systematic-debugging`, `superpowers:test-driven-development`, and `superpowers:verification-before-completion`.
