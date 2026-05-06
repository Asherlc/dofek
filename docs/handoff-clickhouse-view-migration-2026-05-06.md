# Handoff: ClickHouse View Migration / Deploy Retry

Date: 2026-05-06
Branch: `aloud-bike`
Worktree: local path omitted (machine-specific)

## Goal

Fix the failing deploy and complete the user-requested move of troublesome Postgres view/read-model work to ClickHouse. The deploy was timing out while replacing/syncing hot Postgres views, especially `fitness.v_daily_metrics`; the requested direction is to move all of that view work to ClickHouse and remove deploy/ingestion-time Postgres view sync triggers.

## Evidence Collected

- Original deploy run `25415707212`, job `74546726240`, failed in `Configure ClickHouse CDC`.
- First fatal line:
  `"invalid mirror: rpc error: code = FailedPrecondition desc = failed to validate destination connector dofek_clickhouse_postgres_fitness: not all PeerDB columns found in destination table metric_stream"`
- Root cause: ClickHouse `postgres_fitness.metric_stream` was missing PeerDB metadata columns `_peerdb_synced_at`, `_peerdb_is_deleted`, and `_peerdb_version`.
- Later branch deploy run `25443588374` timed out in `Run migrations`.
- First fatal line from workflow timeout: `Migration exceeded 3300s`.
- Postgres inspection showed blocked DDL: `CREATE OR REPLACE VIEW fitness.v_daily_metrics AS ...`.
- Causal chain: deploy-time Postgres view DDL waited behind live app reads; later app queries queued behind the pending DDL. This was the slowness/lock.

## Implemented Direction

- Added native ClickHouse `postgres_fitness` raw mirror tables and ClickHouse `analytics.*` read models.
- Removed use of `postgres_fitness_live` / ClickHouse PostgreSQL-engine tables.
- Removed deploy-time Postgres view sync/maintenance from migration/deploy workflows.
- Removed ingestion-time Postgres materialized-view refresh hooks from HealthKit/WHOOP paths.
- Migrated runtime ClickHouse consumers from `postgres_fitness_live.v_*` to `analytics.v_*` or native `postgres_fitness.*` tables.
- Updated ClickHouse integration tests to mirror raw Postgres rows into isolated ClickHouse databases and refresh stored test read-model tables.
- Serialized Vitest file execution in `vitest.config.ts`; local ClickHouse could not reliably create and refresh multiple isolated read-model copies concurrently.

## Validation So Far

Passed:

- `pnpm lint`
- `pnpm tsc --noEmit`
- `cd packages/server && pnpm tsc --noEmit`
- `cd packages/web && pnpm tsc --noEmit`
- Focused ClickHouse/unit suites:
  `pnpm exec vitest run src/db/clickhouse.test.ts src/db/clickhouse-migrations.test.ts packages/server/src/repositories/clickhouse-activity-sensor-store.test.ts packages/server/src/routers/clickhouse-integration-test-helpers.test.ts`
- Changed test set with serial file execution:
  `pnpm exec vitest run --changed origin/main --fileParallelism=false`
  passed 75 files / 1,888 tests.

Important: after `vitest.config.ts` was changed to serialize only the integration project, rerun exact repo gates before pushing:

```bash
pnpm lint
pnpm test:changed
pnpm tsc --noEmit
cd packages/server && pnpm tsc --noEmit
cd packages/web && pnpm tsc --noEmit
```

## Next Steps

1. Run the exact pre-push gates above.
2. Commit all changes, including this handoff and the production incident baseline update.
3. Push `aloud-bike`:
   `git push origin aloud-bike`
4. Confirm workflow inputs:
   `gh workflow list --repo Asherlc/dofek`
   `gh workflow view <workflow> --repo Asherlc/dofek`
5. Trigger the branch deploy from `aloud-bike`.
6. Monitor with `gh run list` and `gh run view`. If it fails, capture the failing step, first fatal log line, and causal chain before changing code.

## Remaining Risks

- `src/db/clickhouse.ts` is still over the repo's 1000-line guideline and should be split into explicit ClickHouse raw-table/read-model modules in a follow-up if it is not done before deploy.
- `analytics.provider_stats` now lives in ClickHouse, but verify production consumer expectations if additional provider count categories are added later.
- The local ClickHouse issue was test-infrastructure concurrency, not app query correctness: serial changed tests passed after the read-model fixes.
