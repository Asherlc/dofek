# ClickHouse Activity Dedup Runbook

Activity-facing ClickHouse read models must use canonical activity IDs from the
persisted activity groups. Do not build final activity rows directly from
`postgres_fitness.activity`; that table intentionally stores raw provider rows,
including overlapping duplicates from multiple providers or devices.

Activity titles follow the recording origin resolved by the
[origin selector](../analytics/macros/activity_origin.sql), separately from the
analytics representative. Preserve a missing primary title as null and expose
`primary_canonical_type` so web and mobile can display the primary activity type
without borrowing another member's title or changing analytics classification.
Unresolved groups retain their existing field-priority title selection. The
[Postgres view](../drizzle/_views/01_v_activity.sql) and
[ClickHouse model](../analytics/models/read_models/deduped_activities.sql) apply
the same rule.

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

### Late HealthKit Copies

For late HealthKit copies, compare raw `provider_id`, `source_name`, workout
UUIDs, and `group_id` before investigating analytics freshness. A WHOOP workout
can arrive directly and through Apple Health with a different UUID while still
reporting WHOOP as its source. The [HealthKit workout processor](../packages/server/src/routers/health-kit-sync-processors.ts)
runs provider presence and shared group reconciliation in one transaction,
acquiring the per-user grouping lock before updating presence. User queries are
invalidated after commit, including empty uploads. All raw
source records remain stored. The [router integration tests](../packages/server/src/routers/health-kit-sync.integration.test.ts)
cover a late WHOOP-sourced copy joining the original group. If both database
projections expose separate groups, inspect this ingestion boundary before
changing overlap thresholds or rebuilding ClickHouse models.

Run this comparison in a read-only transaction with the affected account and
workout window supplied privately. It reports whether the direct WHOOP record
and its HealthKit copies share a persisted group, alongside their overlap:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
WITH records AS (
  SELECT id, group_id, provider_id, source_name, started_at, ended_at
  FROM fitness.activity
  WHERE user_id = '<user-uuid>'::uuid
    AND started_at >= '<window-start>'::timestamptz
    AND started_at < '<window-end>'::timestamptz
    AND deleted_at IS NULL AND provider_absent_at IS NULL
)
SELECT origin.provider_id AS origin_provider,
       copy.provider_id AS copy_provider,
       origin.group_id = copy.group_id AS same_group,
       round(
         extract(epoch FROM least(origin.ended_at, copy.ended_at)
                            - greatest(origin.started_at, copy.started_at))
         / nullif(extract(epoch FROM greatest(origin.ended_at, copy.ended_at)
                                    - least(origin.started_at, copy.started_at)), 0),
         3
       ) AS overlap_iou
FROM records AS origin
JOIN records AS copy ON origin.provider_id = 'whoop'
  AND copy.provider_id = 'apple_health' AND copy.source_name = 'WHOOP'
  AND origin.started_at < copy.ended_at AND copy.started_at < origin.ended_at;
ROLLBACK;
```

The incident comparison found both an already-grouped pair and later ungrouped
pairs with overlap rounding to `1.000`. Compare the corresponding raw and
canonical groups using the queries below, and check successful upload requests
with `docker service logs --raw --timestamps --since 30m --tail 2000 dofek_web`.
Follow the [deployment diagnostics](../deploy/README.md) to select the live
service before reading logs. The [workout processor](../packages/server/src/routers/health-kit-sync-processors.ts)
and [synthetic router regressions](../packages/server/src/routers/health-kit-sync.integration.test.ts)
define the write path and executable reproduction.

The grouping lock is acquired before row updates to preserve consistent lock
ordering with normal canonical commits. The [shared lock helper](../src/db/activity-group-reconciliation.ts)
uses a transaction-level advisory lock; acquiring that lock again from the same
transaction succeeds, and commit or rollback releases it. PostgreSQL documents
[consistent lock ordering and advisory lock ownership](https://www.postgresql.org/docs/current/explicit-locking.html).

After a provider removal, inspect persisted membership separately from visible
activity counts: the [canonical view](../drizzle/_views/01_v_activity.sql)
excludes groups containing an effective tombstone, even when reconciliation
has separated the remaining active records into different groups.

### Grouping Query Cost

Before changing reconciliation scope, inspect measured query cost with
[PostgreSQL statement diagnostics](../deploy/README.md#postgres-statement-diagnostics):

```sql
SELECT calls,
       round(mean_exec_time::numeric, 2) AS mean_ms,
       round(max_exec_time::numeric, 2) AS max_ms
FROM pg_stat_statements
WHERE query ILIKE '%overlap_edges%'
  AND query ILIKE '%manual_merge_anchor_id%'
ORDER BY calls DESC;
```

The incident review found two matching query shapes with cumulative mean times
of about 2.5 and 3.2 seconds and maxima below 6.8 seconds. These statement times
do not bound the entire HTTP request or prove an upload timeout. Preserve
transitive group edges, splits, and alias ownership from the [shared resolver](../src/db/activity-group-reconciliation.ts)
when considering any measured optimization; an upload-window filter alone does
not establish a complete affected component.

## Missing Primary Source Label

When a card shows only “Sources,” inspect `source_providers`,
`primary_activity_id`, `primary_provider_id`, `origin_candidate_member_ids`, and
`origin_evidence` for the same group in PostgreSQL `fitness.v_activity` and
ClickHouse `analytics.v_activity`. Compare those results with active raw member
rows and their source/device metadata. A retained provider with null primary
fields indicates unresolved origin; it does not by itself establish a sync
failure. The [origin resolver](../drizzle/_views/00_activity_origin.sql),
[dbt selector](../analytics/macros/activity_origin.sql), and
[source disclosure](../packages/web/src/components/ActivitySourceDisclosure.tsx)
define these fields and the collapsed label.

Distinguish an exported copy from a parallel recording: transfer evidence can
link one provider's record to another, while an independent WHOOP recording
does not establish a transfer from the workout's initiating device. Check the
shared [origin fixtures](../src/test-fixtures/activity-origin.json) before
changing the policy. Agreement between both database projections helps
separate origin policy from stale analytics; disagreement needs a CDC or
read-model investigation using the [rollout runbook](clickhouse-read-model-deploy-runbook.md).

Run the shared real-engine origin regressions through the
[integration tier](testing.md#integration-dependencies):

```bash
pnpm test:integration -- src/db/activity-origin.integration.test.ts src/db/activity-origin-read-model.integration.test.ts --maxWorkers 1 --no-file-parallelism
```

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

Deploy PostgreSQL migration `0158_activity_copy_identity` and pre-CDC ClickHouse
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
