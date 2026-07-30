# Sleep Quality Backfill

Use this runbook after deploying the `sleep_session.staging_available` schema
and ingestion changes. The repair classifies historical rows conservatively,
clears legacy fabricated stage zeros, and clears Apple Health efficiency values
that Apple Health never reported.

The command is an explicit operator action, never part of deploy or request
handling. It updates one bounded half-open `started_at` window at a time using
PostgreSQL's documented
[`UPDATE ... FROM`](https://www.postgresql.org/docs/current/sql-update.html)
semantics. A window cannot exceed 31 days.

## Inference rules

- Apple Health staging is marked available only when retained
  `fitness.sleep_stage` rows contain distinct deep or REM staging evidence.
  Apple rows without that evidence have canonical stage totals cleared to
  `NULL`. Independently reported awake time is retained when its interval
  provenance exists. The retained interval rows remain the provenance.
- Historical Garmin and WHOOP rows whose four stage totals are all zero have
  those totals cleared to `NULL`.
- Other providers are marked staging-available only when all four canonical
  stage totals are present and at least one is nonzero.
- All historical Apple Health `efficiency_pct` values are cleared because that
  source does not report the measurement.

The backfill is idempotent. PostgreSQL's aggregate `FILTER` clause is used to
report each change category separately; see the
[`SELECT` aggregate documentation](https://www.postgresql.org/docs/current/sql-expressions.html#SYNTAX-AGGREGATES).

## Preconditions

- The Postgres and ClickHouse quality-flag migrations are deployed.
- `DATABASE_URL` targets the intended environment.
- Choose a UTC half-open window of at most 31 days. Start with a small window
  during an observed low-load period.

## Dry run

Every invocation defaults to preview mode:

```bash
pnpm backfill:sleep-quality -- \
  --start 2026-01-01T00:00:00Z \
  --end 2026-02-01T00:00:00Z
```

Record the total rows and the three category counts. Investigate unexpected
counts before executing the same window.

## Execute and verify

```bash
pnpm backfill:sleep-quality -- \
  --start 2026-01-01T00:00:00Z \
  --end 2026-02-01T00:00:00Z \
  --execute
```

Repeat the dry run for the same bounds. All counts must be zero. Then wait for
the normal Postgres-to-ClickHouse mirror and `analytics.daily_sleep` refresh,
and verify one complete and one partial night through the sleep API and either
client. Complete nights should retain stage breakdowns; partial nights should
show the explicit unavailable-stage state.

Advance to the next non-overlapping window only after verification. Stop if the
repeat preview is nonzero, the command fails, CDC health degrades, or a known
complete record loses its stage breakdown.
