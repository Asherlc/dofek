# Task 11B report

## Implementation

- Reordered independent `AS MATERIALIZED` CTE declarations to the start of the five affected ClickHouse models. This preserves each CTE body, dependency, materialization, and result semantics while keeping SQLFluff ST03 traversal from ending before ordinary CTE references.
- Updated the hiking model test to match the repository's durable lowercase `null` SQL style.
- Updated the isolated ClickHouse helper assertion to match the durable qualified `activity.local_time_source` expression.
- Strengthened `ActivityRepository.findById()` public-interface coverage for member provenance, canonical cache reuse, canonical query parameters, absence of `resolved_from` on canonical lookup, and complete resolution telemetry. Production repository code was unchanged.

## RED evidence

- `rtk pnpm vitest run --project unit analytics/models/read_models/hiking_activity.sql.test.ts packages/server/src/routers/clickhouse-integration-test-helpers.test.ts --retry=0`
  - Result: exit 1; 2 files failed, 2 tests failed, 8 passed. Failures were the uppercase `NULL` expectation at hiking line 54 and the false helper assertion at line 332.
- `rtk pnpm lint:analytics-sql` (rerun outside the sandbox after the uv cache permission failure)
  - Result: exit 1; exactly 11 ST03 findings across the five named models. `deduped_activities.sql` was skipped because 20,049 bytes exceeded the 20,000-byte guard.
- `rtk pnpm exec stryker run stryker.ci.config.json --mutate 'packages/server/src/repositories/activity-repository.ts:606-691' --testFiles 'packages/server/src/repositories/activity-repository.test.ts' --concurrency 2`
  - Result: 19 killed, 5 survived, 0 no coverage; 79.17%. Survivors were the two object literals and three resolution-attachment condition mutations named in Task 11.

## GREEN evidence

- `rtk pnpm vitest run --project unit analytics/models/read_models/hiking_activity.sql.test.ts analytics/models/read_models/read_model_microbatch.sql.test.ts analytics/models/read_models/activity_sensor_summary_rows.sql.test.ts packages/server/src/routers/clickhouse-integration-test-helpers.test.ts packages/server/src/repositories/activity-repository.test.ts --retry=0`
  - Result: exit 0; 5 files passed, 117 tests passed.
- `rtk pnpm lint:analytics-sql`
  - Result: exit 0; all 11 ST03 findings cleared. The permanent 20,000-byte guard still emitted the expected skip warning.
- Temporary untracked `/private/tmp/task-11b-sqlfluff.ini` set `large_file_skip_byte_limit = 0`, followed by `rtk sh -c 'set -a; [ ! -f .env.local ] || . ./.env.local; set +a; cd analytics && UV_PROJECT_ENVIRONMENT=../.venv-analytics uv run --project . sqlfluff lint --config /private/tmp/task-11b-sqlfluff.ini --ignore parsing models'`.
  - Result: exit 0, `All Finished!`, with no large-file skip warning; `deduped_activities.sql` was linted. The temporary file was then deleted and confirmed absent.
- `rtk pnpm lint:sandbox` (outside the sandbox because tsx requires an IPC socket)
  - Result: exit 0; Biome checked 3,232 files, analytics migration policy passed, and all remaining policy checks passed.
- Final targeted Stryker command above
  - Result: exit 0; 24 killed, 0 survived, 0 no coverage; 100.00% mutation score.

## Files

- `analytics/models/read_models/activity_location_sample.sql`
- `analytics/models/read_models/activity_location_summary_rows.sql`
- `analytics/models/read_models/activity_sensor_sample.sql`
- `analytics/models/read_models/activity_sensor_summary_rows.sql`
- `analytics/models/read_models/activity_stream_points.sql`
- `analytics/models/read_models/hiking_activity.sql.test.ts`
- `packages/server/src/repositories/activity-repository.test.ts`
- `packages/server/src/routers/clickhouse-integration-test-helpers.test.ts`

## Commit and self-review

- Implementation: `637d2de0b` (`Close activity verification gaps`), pushed to `origin/fix/activity-representative-selection`.
- Diff review confirmed that SQL changes only relocate complete CTE declarations; no CTE text, joins, filters, settings, or output columns changed. No lint suppression, ignore, permanent config change, size-limit change, or production-for-testability change was introduced.

## Concerns and retrospective

- No Task 11B blocker remains. The previously reported integration/OOM constraints were intentionally left untouched as directed.
- What went well: the existing Task 11 report made each failure and mutant reproducible, and the narrow tests killed all five mutants without production changes.
- Investigation needed: the ST03 findings came from SQLFluff's traversal boundary at ClickHouse `AS MATERIALIZED`, so declaration order—not unused SQL—was the cause.
- Useful next-time guidance: document this SQLFluff/ClickHouse traversal constraint in `analytics/AGENTS.md` after approval. The same TDD and verification-before-completion skills remain appropriate for future verification-gap work.
