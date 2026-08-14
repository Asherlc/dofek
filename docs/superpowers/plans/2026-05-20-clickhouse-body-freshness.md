# ClickHouse Body Freshness Implementation Plan

> Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. See `AGENTS.md` for any agent-specific execution workflows.

**Goal:** Restore body metric freshness and reduce ClickHouse starvation from large read-model refreshes.

**Architecture:** Keep the fix small: stop PeerDB from replicating the problematic `metric_stream.point` column into the active analytics mirror, and lengthen refresh intervals for the read models that scan the large `postgres_fitness.metric_stream` mirror. Preserve existing app query APIs and avoid a broader location analytics redesign in this incident fix.

**Tech Stack:** TypeScript, Vitest, ClickHouse SQL generation, PeerDB SQL template.

---

## Task 1: Exclude `metric_stream.point` From PeerDB CDC Mirrors

**Files:**
- Modify: `src/db/peerdb/metric-stream-cdc.sql`
- Test: `src/db/clickhouse-cdc.test.ts`

- [ ] **Step 1: Write the failing test**

Add assertions to the CDC SQL tests that both metric-stream mirrors exclude `point`:

```ts
expect(peerDbQueries[5]).toContain("exclude: [device_id, source_type, vector, point, metadata]");
expect(peerDbQueries[6]).toContain("exclude: [device_id, source_type, vector, point, metadata]");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/db/clickhouse-cdc.test.ts`

Expected: FAIL because the generated PeerDB SQL excludes `device_id`, `source_type`, `vector`, and `metadata`, but not `point`.

- [ ] **Step 3: Write minimal implementation**

Update both `exclude` lists in `src/db/peerdb/metric-stream-cdc.sql` to:

```sql
exclude: [device_id, source_type, vector, point, metadata]
```

Also update the nearby comment so it no longer claims location analytics replicate the canonical PostGIS point through PeerDB.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/db/clickhouse-cdc.test.ts`

Expected: PASS.

## Task 2: Lengthen Heavy ClickHouse Refresh Intervals

**Files:**
- Modify: `src/db/clickhouse-sql-helpers.ts`
- Modify: `src/db/clickhouse-read-models.ts`
- Test: `src/db/clickhouse.test.ts`

- [ ] **Step 1: Write the failing test**

Add assertions that heavy metric-stream-backed read models use longer refresh intervals:

```ts
expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor\nREFRESH EVERY 15 MINUTE");
expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_location\nREFRESH EVERY 15 MINUTE");
expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_summary\nREFRESH EVERY 15 MINUTE OFFSET 10 SECOND");
expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_body_measurement\nREFRESH EVERY 15 MINUTE");
expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.provider_stats\nREFRESH EVERY 15 MINUTE");
expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_trend_daily\nREFRESH EVERY 15 MINUTE OFFSET 20 SECOND");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/db/clickhouse.test.ts`

Expected: FAIL because those views currently use `REFRESH EVERY 1 MINUTE`.

- [ ] **Step 3: Write minimal implementation**

Extend `refreshableMergeTreeViewHeader` to accept an optional refresh interval while preserving its current default:

```ts
export function refreshableMergeTreeViewHeader(
  viewName: string,
  orderBy: string,
  refreshOffset = "",
  refreshEvery = "1 MINUTE",
): string {
  const offsetClause = refreshOffset ? ` OFFSET ${refreshOffset}` : "";
  return `CREATE MATERIALIZED VIEW IF NOT EXISTS ${viewName}
REFRESH EVERY ${refreshEvery}${offsetClause}
ENGINE = MergeTree
ORDER BY ${orderBy}
SETTINGS allow_nullable_key = 1
AS`;
}
```

Pass `"15 MINUTE"` for `analytics.v_body_measurement`, `analytics.provider_stats`, and `analytics.activity_trend_daily`. Update the inline materialized-view SQL for `analytics.deduped_sensor`, `analytics.deduped_location`, and `analytics.activity_summary` to use the same interval, preserving their existing offsets.

- [ ] **Step 4: Add a non-destructive ClickHouse migration**

Add migration `0015_reduce_metric_stream_refresh_load` with `ALTER TABLE ... MODIFY REFRESH` statements for the same six read models. Do not drop/recreate the views in this migration.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/db/clickhouse.test.ts`

Expected: PASS.

## Task 3: Document And Verify

**Files:**
- Modify: `docs/production-incident-baseline.md`
- Modify if needed: `docs/clickhouse-metric-stream.md`

- [ ] **Step 1: Update incident notes**

Record that the code fix excludes `point` from CDC and reduces heavy refresh frequency.

- [ ] **Step 2: Run focused checks**

Run:

```bash
pnpm vitest run src/db/clickhouse-cdc.test.ts src/db/clickhouse.test.ts
pnpm lint
```

Expected: PASS.

- [ ] **Step 3: Report remaining production deployment step**

The code change does not alter the already-running PeerDB mirror until deployed and the mirror/schema is reconciled. The final report must call out the production follow-up explicitly.
