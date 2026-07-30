# Daily Metrics KV Migration Plan

> Status: **planning**. Not started.

## Motivation

`fitness.daily_metrics` is a wide table with ~20 sparse measurement columns
(`hrv`, `spo2_avg`, `steps`, `walking_speed`, `walking_step_length`,
`walking_double_support_pct`, `stress_high_minutes`, `recovery_high_minutes`,
`resilience_level`, `push_count`, `uv_exposure`, …). Adding a new provider-
specific metric requires a schema migration, a Drizzle update, and changes to
every writer and reader path.

The repo already has a scaffolded alternative:

- `fitness.daily_metric_type` — catalog of metric definitions
  (`id`, `display_name`, `unit`, `category`, `priority_category`, `sort_order`,
  `is_integer`).
- `fitness.daily_metric_value` — KV table holding
  `(daily_metrics_id, metric_type_id, value)`.

Both tables exist in `schema.ts` and in production (created in
`drizzle/0000_baseline.sql`) but have **zero rows on production** and **zero
writers/readers in the codebase**. The migration plan below wires them up.

## Target architecture

```text
fitness.daily_metrics              -- "row identity" only
    id, user_id, provider_id, date, source_name, created_at

fitness.daily_metric_type          -- catalog (seeded once)
    id            text PK          -- 'hrv', 'spo2_avg', 'steps', ...
    display_name  text             -- 'HRV', 'SpO₂ (avg)', 'Steps', ...
    unit          text             -- 'ms', '%', 'count', ...
    category      text             -- 'recovery', 'activity', ...
    is_integer    bool

fitness.daily_metric_value         -- one row per (daily_metrics_id, metric_type_id)
    daily_metrics_id  uuid FK
    metric_type_id    text FK
    value             real

fitness.v_daily_metrics            -- compatibility view (pivots KV back to wide)
    user_id, provider_id, date, hrv, spo2_avg, steps, …
```

The view is the contract: every current reader already goes through
`fitness.v_daily_metrics` (confirmed by grep — only admin counters touch the
table directly). That gives us a clean seam to swap the storage shape behind
the view without breaking callers.

## What stays wide vs. moves to KV

| Column                      | Decision   | Reason |
| --------------------------- | ---------- | ------ |
| `id`, `user_id`, `provider_id`, `date`, `source_name`, `created_at` | **stay native** | Row identity; needed for FKs, indexes, dedup |
| `hrv`, `spo2_avg`, `respiratory_rate_avg`, `steps`, `distance_km`, `flights_climbed`, `exercise_minutes`, `walking_speed`, `walking_step_length`, `walking_double_support_pct`, `walking_asymmetry_pct`, `walking_steadiness`, `stand_hours`, `skin_temp_c`, `stress_high_minutes`, `recovery_high_minutes`, `push_count`, `wheelchair_distance_km`, `uv_exposure` | **move to KV** | All numeric, all sparse, all read through the view |
| `resilience_level` (text)   | **decide** | KV `value` column is `real`. Options below. |

### `resilience_level` (text enum) options

`daily_metric_value.value` is `real notnull`. A text-valued metric doesn't fit.
Three choices:

1. **Drop it** — Oura-only, never read by app code (verify before deciding).
2. **Numeric encode** — map `limited|adequate|solid|strong|exceptional` to
   `1..5`, store the mapping in the catalog. Cleanest if we want it queryable.
3. **Add `value_text text` to `daily_metric_value`** — most flexible, but
   contradicts the "tight types" reason for moving to KV in the first place.

**Recommendation: option 2** (numeric encode). The view exposes it as text
again via a `CASE` so client code doesn't change.

## Phased migration

### Phase 0 — Catalog seed (idempotent SQL migration, no behavior change)

Insert one `daily_metric_type` row per column being moved. Seed lives in
`drizzle/_views/` or a dedicated `drizzle/00XX_seed_daily_metric_types.sql`.

```sql
INSERT INTO fitness.daily_metric_type (id, display_name, unit, category, sort_order, is_integer)
VALUES
  ('hrv',                    'HRV',                'ms',      'recovery', 10, false),
  ('spo2_avg',               'SpO₂ (avg)',         '%',       'recovery', 20, false),
  ('respiratory_rate_avg',   'Respiratory rate',   'br/min',  'recovery', 30, false),
  ('steps',                  'Steps',              'count',   'activity', 40, true),
  -- ...
ON CONFLICT (id) DO NOTHING;
```

**Verification:** `SELECT COUNT(*) FROM fitness.daily_metric_type` returns the
expected count. No app behavior change.

### Phase 1 — Dual-write (TypeScript change, no schema change)

Add `writeDailyMetricKV(dailyMetricsId, metrics)` in a new repository.
Every existing writer that inserts into `fitness.daily_metrics` calls it
after the wide-column insert, in the same transaction:

```ts
await tx.execute(sql`INSERT INTO fitness.daily_metrics (...) VALUES (...) RETURNING id`);
await writeDailyMetricKV(tx, dailyMetricsId, {
  hrv: 42.1, steps: 8000, /* ... */
});
```

Writers to update (from current grep):
- `packages/server/src/routers/health-kit-sync-processors.ts` (3 inserts)
- `packages/server/src/repositories/health-kit-sync-repository.ts` (3 inserts)
- `src/providers/polar/sync-service.ts`
- `src/providers/eight-sleep.ts`
- `src/providers/whoop/sync-recovery.ts`
- `cypress.config.ts` test fixture

Helper handles `undefined`/`null` correctly (skip the row, don't insert a
zero). Use `ON CONFLICT (daily_metrics_id, metric_type_id) DO UPDATE` for
idempotency.

**Backfill:** one-time SQL that walks every `daily_metrics` row and inserts
the equivalent KV rows. Run as a separate migration once dual-write ships, so
new writes can't race the backfill.

```sql
INSERT INTO fitness.daily_metric_value (daily_metrics_id, metric_type_id, value)
SELECT id, 'hrv',   hrv   FROM fitness.daily_metrics WHERE hrv   IS NOT NULL
UNION ALL
SELECT id, 'steps', steps FROM fitness.daily_metrics WHERE steps IS NOT NULL
-- ... one UNION per column
ON CONFLICT DO NOTHING;
```

**Verification:** for every wide column, `SELECT COUNT(*) FROM daily_metrics
WHERE col IS NOT NULL` equals `SELECT COUNT(*) FROM daily_metric_value WHERE
metric_type_id = '<col>'`. Add an integration test that round-trips a synthetic
row.

### Phase 2 — Reader cutover (view rewrite)

Replace `fitness.v_daily_metrics` so it reads from KV instead of wide columns.
The view body uses `FILTER` aggregates to pivot:

```sql
CREATE OR REPLACE VIEW fitness.v_daily_metrics AS
SELECT
  dm.id, dm.user_id, dm.provider_id, dm.date, dm.source_name, dm.created_at,
  MAX(v.value) FILTER (WHERE v.metric_type_id = 'hrv')   AS hrv,
  MAX(v.value) FILTER (WHERE v.metric_type_id = 'steps')::int AS steps,
  -- ...
FROM fitness.daily_metrics dm
LEFT JOIN fitness.daily_metric_value v ON v.daily_metrics_id = dm.id
GROUP BY dm.id;
```

**Verification:** snapshot test — `SELECT * FROM v_daily_metrics ORDER BY id`
on prod before/after the view swap returns identical rows. Run on a snapshot,
not live prod.

**Performance check:** measure `EXPLAIN ANALYZE` on the hottest query
(`recovery.ts` reads). The pivot adds a `GROUP BY` over the KV join — if
slow, consider:
- Covering index on `daily_metric_value (daily_metrics_id, metric_type_id) INCLUDE (value)` — matches the view's `LEFT JOIN ... ON v.daily_metrics_id = dm.id` + `GROUP BY dm.id` pattern; `metric_type_id` filters per-column and `INCLUDE (value)` lets the planner stay index-only.
- Materialized view variant for the dashboard's daily aggregates.
- Keep `hrv` and `steps` as native columns (hybrid) since they're in every
  query — formally splits "hot path" vs. "long tail."

### Phase 3 — Drop wide columns

Once Phase 2 has been live for ≥1 week with no parity drift:

```sql
ALTER TABLE fitness.daily_metrics
  DROP COLUMN hrv,
  DROP COLUMN spo2_avg,
  DROP COLUMN steps,
  -- ...
  DROP COLUMN resilience_level;
```

Then remove the wide columns from `schema.ts` and stop dual-writing in the
writers — the KV write becomes the only write.

**Verification:** prod row count of `daily_metric_value` stays stable;
`v_daily_metrics` continues to return correct data for the dashboard's
golden-path queries.

## Cross-cutting concerns

- **Provider sync code in `@dofek/format` / `@dofek/scoring`**: these import
  field names from `daily_metrics`. They should change to read from the view
  type, not the table type. The view shape stays stable, so no domain logic
  change.
- **Provider data deletion**: Disconnect retains `daily_metrics`. **Delete All
  Data** and account deletion remove `daily_metrics`, which cascades to
  `daily_metric_value` through the FK (`onDelete: "cascade"` in
  [`schema.ts`](../src/db/schema.ts)). No change needed.
- **Mobile app**: HealthKit sync writes via the tRPC routers — server-side
  change only. Mobile code unaffected.
- **ClickHouse mirror**: `analytics.daily_metrics` proxies the Postgres table.
  If ClickHouse needs to mirror per-metric values, add a parallel
  `analytics.daily_metric_value` mirror in `src/db/clickhouse-read-models.ts`.

## Open questions for the user

1. **Hybrid or fully KV?** Keeping `hrv` and `steps` native preserves the hot
   read path with no GROUP BY cost; moving everything to KV maximizes
   extensibility. Recommendation: start with full KV and revisit only if
   benchmarks show regression.
2. **resilience_level**: drop, numeric-encode, or add `value_text`?
3. **Backfill window**: backfill in one shot (fast, locks the table briefly)
   or in batches (slower, no lock)? Production row count is small enough that
   one-shot is fine.

## Effort estimate

| Phase | Files touched | Risk |
| ----- | ------------- | ---- |
| 0 — catalog seed     | 1 migration | low |
| 1 — dual-write       | ~7 writers, 1 new repo, 1 backfill migration | medium (transaction semantics) |
| 2 — view cutover     | 1 migration (view), parity test | medium (perf risk) |
| 3 — drop columns     | 1 migration, schema.ts, writers (remove dual-write) | low |

Total: roughly half a day of focused work spread across four PRs, each
independently revertible.
