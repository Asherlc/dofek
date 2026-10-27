# Activity Overview Availability Backfill

Use this runbook after deploying the activity overview availability fix when
historical compact summary rows still report unavailable distance or elevation
as zero. The command rewrites only latest zero-valued summary rows whose activity
has fewer than two valid source samples. It writes a newer replacement row rather
than mutating stored history, matching the documented behavior of
[`ReplacingMergeTree`](https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree).

The command is never part of deploy or request handling. Run it manually in
explicit, bounded UTC windows. ClickHouse supports this repair shape through
[`INSERT INTO ... SELECT`](https://clickhouse.com/docs/sql-reference/statements/insert-into).

## Preconditions

- The availability fix is deployed and the normal analytics build is healthy.
- `CLICKHOUSE_URL` targets the intended environment.
- Choose a bounded UTC half-open window of at most 31 days: `--start` is
  inclusive and `--end` is exclusive.
- Schedule execution during an observed low-load period. Start with a small
  window and advance only after verification.

## Dry run

Every invocation defaults to a dry run. Both bounds are mandatory and must
include an explicit UTC time zone:

```bash
pnpm backfill:activity-overview-availability -- \
  --start 2026-03-01T00:00:00Z \
  --end 2026-03-08T00:00:00Z
```

Record the reported distance and elevation candidate counts. Investigate before
execution if the counts are unexpected. Distance and elevation candidates are
evaluated independently, and rows backed by at least two valid samples remain
unchanged even when their measured aggregate is zero.

## Execute and verify

Re-run the identical window with the explicit write flag:

```bash
pnpm backfill:activity-overview-availability -- \
  --start 2026-03-01T00:00:00Z \
  --end 2026-03-08T00:00:00Z \
  --execute
```

Then repeat the dry run for the same bounds. Both candidate counts must be zero.
Verify an affected activity in the web or mobile activity overview and confirm
that unavailable measurements use the unavailable copy while genuinely measured
zero values still format as zero.

Advance to the next non-overlapping window only after that verification. Stop if
candidate counts remain nonzero, the command fails, ClickHouse health degrades,
or measured-zero activities change unexpectedly.
