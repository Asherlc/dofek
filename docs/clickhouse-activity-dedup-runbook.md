# ClickHouse Activity Dedup Runbook

Activity-facing ClickHouse read models must use canonical activity IDs from the
persisted activity groups. Do not build final activity rows directly from
`postgres_fitness.activity`; that table intentionally stores raw provider rows,
including overlapping duplicates from multiple providers or devices.

## Required Shape

- PostgreSQL [group reconciliation](../src/db/activity-group-reconciliation.ts)
  owns `fitness.activity.group_id`; ClickHouse receives that identity through
  [activity source records](../analytics/models/read_models/activity_source_records.sql).
- Activity sample and location membership models should map raw rows through
  [deduplicated members](../analytics/models/read_models/deduped_activity_members.sql).
- Final activity-facing models, especially `analytics.activity_summary_rows`,
  must emit one row per persisted group ID; see
  [deduplicated activities](../analytics/models/read_models/deduped_activities.sql).
- Raw `postgres_fitness.activity` rows may be used as dirty-key triggers, but
  not as the final identity source.

## Symptom

`https://dofek.fit/activities` shows duplicate cards with the same start
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

Update the read model so persisted group identity drives output. Keep raw
activity changes only as dirty-key inputs:

- canonical rows: from `deduped_activities`
- changed raw rows: used to find overlapping canonical rows to refresh
- stale rows: existing summary IDs no longer present in canonical
  activity groups, emitted as deletion tombstones

After deploy, let `analytics-worker` run the safe dbt model set. For urgent
cleanup, run the same safe dbt command used by the worker rather than editing
server files manually.

## Propagated Record Identity And Absence

Before changing type mappings or overlap thresholds, compare source metadata
and external IDs. The [copy identity function](../drizzle/_views/00_activity_copy_identity.sql)
recognizes the observed WHOOP-to-Peloton transfer: both `raw.platform` and
`raw.deviceType` identify WHOOP, and the Peloton external ID is a valid WHOOP
UUID, optionally without hyphens. An exact identity links the records even
when timing or broad activity categories differ. Titles and time overlap alone
do not prove propagation. PostgreSQL and ClickHouse share executable
[origin fixtures](../src/test-fixtures/activity-origin.json).

Inspect the affected user's raw PostgreSQL activities, retaining tombstones:

```sql
SELECT a.id, a.group_id, a.provider_id, a.external_id,
       a.canonical_type, a.started_at, a.ended_at,
       a.provider_absent_at, a.absence_provider_id, a.deleted_at,
       copy.provider_id AS origin_provider, copy.external_id AS origin_external_id
FROM fitness.activity AS a
LEFT JOIN LATERAL fitness.activity_copy_identity(
  a.provider_id, a.external_id, a.raw
) AS copy ON true
WHERE a.user_id = '<user-uuid>'::uuid
  AND a.started_at >= '<window-start>'::timestamptz
  AND a.started_at < '<window-end>'::timestamptz
ORDER BY a.started_at;
```

[Absence reconciliation](../src/db/provider-activity-absence.ts) propagates a
confirmed origin absence to copies with that exact identity. Confirmation is
an explicit delete or a complete authoritative origin list covering the record's
start time; a missing local origin row alone is insufficient. Ambiguous empty
lists do not count. The existing tombstone timestamp preserves raw records;
`absence_provider_id` records which provider confirmed the absence. A downstream
list can restore its own absence without an imported origin. An origin-caused
tombstone requires authoritative confirmation that the origin has reappeared,
followed by confirmation that the downstream record is present. Importing an
origin row alone does not release that evidence. Upserts cannot clear either tombstone field; see the
[shared writer](../src/db/provider-activity-sync.ts).

The [presence predicate](../src/db/provider-activity-absence.ts) recognizes upstream
ID spelling aliases only when an explicit copy identity proves the relationship
for the same user and provider. Restoration and absence use that same predicate,
so an authoritative return cannot immediately be undone by a stale alias.
Raw IDs and unrelated opaque provider IDs retain exact matching semantics.

Deploy PostgreSQL migration `0157_activity_copy_identity` and pre-CDC ClickHouse
migration `0105_activity_absence_provider` through the normal
[deployment procedure](../deploy/README.md#deployment). Subsequent completed
provider syncs reconcile existing records and persist group changes. Verify the
PostgreSQL result, mirrored tombstones and group IDs, then the affected
ClickHouse rows and caches using the
[read-model rollout runbook](clickhouse-read-model-deploy-runbook.md).
Historical records outside the source's authoritative sync window need a bounded
source sync covering that interval. No historical full refresh or deletion
ledger is installed by these migrations; WHOOP's current path confirms absence
through its [authoritative list sync](../src/providers/whoop/sync-workouts.ts).
