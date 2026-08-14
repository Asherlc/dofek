# ClickHouse Activity Dedup Runbook

Activity-facing ClickHouse read models must use canonical activity IDs from the
bounded activity graph. Do not build final activity rows directly from
`postgres_fitness.activity`; that table intentionally stores raw provider rows,
including overlapping duplicates from multiple providers or devices.

## Required Shape

- `analytics/macros/bounded_activity_graph.sql` is the canonical ClickHouse
  activity dedup graph.
- Activity sample and location membership models should map raw rows through the
  graph's `current_activity` or `activity_members` CTEs.
- Final activity-facing models, especially `analytics.activity_summary_rows`,
  must emit one row per canonical `current_activity.activity_id`.
- Raw `postgres_fitness.activity` rows may be used as dirty-key triggers, but
  not as the final identity source.

## Symptom

`https://dofek.asherlc.com/activities` shows duplicate cards with the same start
time and overlapping durations. Some duplicates have metrics and others have
empty or partial metrics.

## Diagnosis

Run read-only checks against ClickHouse:

```sql
WITH activities AS (
  SELECT
    activity_id,
    user_id,
    started_at,
    coalesce(ended_at, started_at + INTERVAL 12 HOUR) AS ended_at
  FROM analytics.activity_summary
  WHERE started_at >= now() - INTERVAL 84 DAY
    AND ended_at IS NOT NULL
)
SELECT count() AS overlapping_pairs
FROM activities AS left_activity
INNER JOIN activities AS right_activity
  ON left_activity.user_id = right_activity.user_id
 AND toString(left_activity.activity_id) < toString(right_activity.activity_id)
WHERE dateDiff(
    'second',
    greatest(left_activity.started_at, right_activity.started_at),
    least(left_activity.ended_at, right_activity.ended_at)
  ) / nullIf(dateDiff(
    'second',
    least(left_activity.started_at, right_activity.started_at),
    greatest(left_activity.ended_at, right_activity.ended_at)
  ), 0) > 0.8;
```

If this returns many rows while Postgres `fitness.v_activity` groups the same
IDs under one `member_activity_ids` array, the ClickHouse final summary is using
raw activity identity somewhere.

## Fix Pattern

Update the read model so canonical `current_activity.activity_id` drives output.
Keep raw activity changes only as dirty-key inputs:

- canonical rows: from `bounded_activity_graph()` `current_activity`
- changed raw rows: used to find overlapping canonical rows to refresh
- stale rows: existing summary IDs no longer present in canonical
  `current_activity`, emitted as deletion tombstones

After deploy, let `analytics-worker` run the safe dbt model set. For urgent
cleanup, run the same safe dbt command used by the worker rather than editing
server files manually.
