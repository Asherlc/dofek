# ClickHouse migration merge-conflict resolution

Date: 2026-09-08

## Resolution

- Preserved main's `0079_stable_activity_group_id`, `0080_sensor_source_activity_id`, and `0081_stable_activity_read_views` migrations in their original order.
- Renamed this branch's conflicting migration from `0079_metric_stream_delete_scope` to `0082_metric_stream_delete_scope`, including its file name, migration ID, registry import, and factory entry.
- Resolved the registry with the four entries in ascending sequence: `0079`, `0080`, `0081`, and `0082`.
- Repository search found no direct test or import references to the old delete-scope migration name outside the migration and registry.

## Verification evidence

- `./node_modules/.bin/vitest run src/db/clickhouse-migrations/registry.test.ts src/metric-stream/clickhouse-table.test.ts src/db/clickhouse-metric-stream-bootstrap.test.ts`
  - Passed: 3 test files, 14 tests.
- `pnpm typecheck`
  - Passed: `TypeScript: No errors found`.
- `git diff --cached --check`
  - Passed with no whitespace errors.

The initial `pnpm vitest` invocation did not start Vitest because pnpm refused a non-interactive dependency-directory purge (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). The focused tests above used the existing local Vitest binary and completed successfully without modifying dependency state.
