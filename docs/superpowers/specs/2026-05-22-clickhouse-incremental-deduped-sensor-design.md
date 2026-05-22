# ClickHouse Incremental Deduped Sensor Design

## Goal

Replace the full-history `analytics.deduped_sensor` refresh with an
activity-agnostic incremental sensor stream. Normal maintenance should be
proportional to new or changed metric-stream rows, not total history.

The immediate production problem is PeerDB CDC freshness. Provider syncs write
new rows to Postgres, but ClickHouse-backed charts become stale when
`analytics.deduped_sensor` refreshes scan hundreds of millions of rows from
`postgres_fitness.metric_stream FINAL` and saturate the single-node host.

## Key Design Change

`analytics.deduped_sensor` should no longer store or compute `activity_id`.

The sensor table is responsible for one thing: provide the best scalar sensor
sample for a `(user_id, channel, recorded_at)` key according to static provider
priority metadata stored in Postgres.

Activity-specific code is responsible for deciding which sensor rows belong to
an activity. Activity queries already know the canonical activity id, member
activities, start/end time, and access rules. They should pull sensor rows by
user/channel/time window, then associate those rows with the activity result.

This removes the expensive parts of the current read model:

- joining every sensor row through `analytics.v_activity_members`,
- computing activity-linked best source by sample count,
- using ambient fallback windows,
- rewriting sensor rows under canonical activity ids.

## Current Problem

The current `analytics.deduped_sensor` is a ClickHouse refreshable materialized
view:

```text
postgres_fitness.metric_stream
        |
        | REFRESH EVERY 15 MINUTE
        v
analytics.deduped_sensor
```

It rebuilds the whole derived table on every refresh. The query repeatedly
scans `postgres_fitness.metric_stream FINAL` to compute canonical activity
membership, sample-count based source selection, ambient fallback windows, and
standalone samples.

On 2026-05-22, one production refresh scanned roughly 566 million rows / 44 GiB,
ran for about 6.4 minutes, and used roughly 4.3 GiB of memory. That load
coincided with Docker Swarm heartbeat failures, Docker DNS failures, PeerDB
heartbeat timeouts, and stale ClickHouse body metrics.

## Scope

In scope:

- Keep PeerDB as the raw Postgres-to-ClickHouse CDC path.
- Replace sample-count source selection with static provider priority metadata.
- Make Postgres priority tables the runtime source of truth for provider,
  device, and sensor-channel priority.
- Remove `activity_id` from the final deduped sensor table.
- Use native ClickHouse incremental materialized views where possible.
- Keep deletes/updates correct enough through versioned rows and a repair path,
  without letting rare cases dominate the normal design.
- Update activity stream, zone, summary, and trend readers to apply activity
  windows at query time.
- Add freshness and backlog observability for this pipeline.

Out of scope:

- Changing provider ingestion semantics.
- Writing derived analytics back to Postgres.
- Using PeerDB query mirrors for derived analytics.
- Solving location projection freshness.
- Replacing every ClickHouse refreshable materialized view.

## Data Model

### Priority Source Of Truth

Provider priority should be a database-owned domain model, not duplicated in
JSON, generated SQL, and ad hoc query fragments.

Postgres is the runtime source of truth. Repo-managed seed data should populate
defaults for clean environments, and priority changes should be auditable and
exportable, but the app and ClickHouse read models should resolve priority from
tables.

The model should answer:

```text
For channel heart_rate, provider garmin outranks apple_health.
For channel power, provider wahoo outranks garmin.
For channel heart_rate, Apple Health rows from Wahoo TICKR outrank generic
Apple Watch rows.
For unknown providers, use a deterministic fallback priority.
```

Priority must not depend on sample count. This makes the chosen source stable
when more rows arrive.

Recommended tables:

```text
fitness.provider_priority
- provider_id
- priority
- sleep_priority
- body_priority
- recovery_priority
- daily_activity_priority

fitness.device_priority
- provider_id
- source_name_pattern
- priority
- sleep_priority
- body_priority
- recovery_priority
- daily_activity_priority

fitness.sensor_provider_priority
- provider_id
- channel
- priority

fitness.sensor_device_priority
- provider_id
- source_name_pattern
- channel
- priority
```

The existing `provider_priority` and `device_priority` tables remain for
activity, sleep, body, recovery, and daily-activity dedupe. The new sensor
priority tables add channel-level specificity without widening the existing
tables for every sensor channel.

Priority writes should create audit rows:

```text
fitness.provider_priority_audit
- id
- changed_at
- changed_by
- priority_table
- provider_id
- source_name_pattern Nullable(String)
- channel Nullable(String)
- old_value JSONB
- new_value JSONB
- reason Nullable(String)
```

Initial defaults should be inserted by migration or a TypeScript seed script
run by migrations. The old `provider-priority.json` sync path should be removed
after equivalent seeded rows exist. If a human-reviewable artifact is still
useful, add an export command that dumps current DB priorities to a generated
Markdown or JSON snapshot; that export is documentation, not the runtime source
of truth.

PeerDB should mirror the priority tables into ClickHouse under
`postgres_fitness.*`. ClickHouse SQL should use generic joins and `COALESCE`,
not provider-specific priority expressions.

### `analytics.sensor_scalar_sample`

Create a narrow current-row projection over raw PeerDB metric-stream data:

```text
- id UUID
- user_id UUID
- recorded_at DateTime64(6, 'UTC')
- recorded_date Date
- channel LowCardinality(String)
- provider_id LowCardinality(String)
- device_id Nullable(String)
- scalar Float32
- provider_priority UInt16
- _peerdb_synced_at DateTime64(9)
- _peerdb_is_deleted UInt8
- _peerdb_version Int64
```

Recommended engine:

```text
ReplacingMergeTree(_peerdb_version)
ORDER BY (user_id, channel, recorded_date, recorded_at, provider_priority, provider_id, id)
```

This table should include only scalar channels consumed by activity sensor,
zone, summary, and trend reads. Body measurement channels remain in
`analytics.body_measurement_sample`; location belongs to the location pipeline.

### Native Ingest Materialized View

Create a native ClickHouse incremental materialized view:

```sql
CREATE MATERIALIZED VIEW analytics.sensor_scalar_sample_ingest
TO analytics.sensor_scalar_sample
AS
SELECT
  metric_stream.id,
  metric_stream.user_id,
  metric_stream.recorded_at,
  toDate(metric_stream.recorded_at) AS recorded_date,
  metric_stream.channel,
  metric_stream.provider_id,
  metric_stream.device_id,
  assumeNotNull(metric_stream.scalar) AS scalar,
  coalesce(device_priority.priority, provider_priority.priority, 1000) AS provider_priority,
  metric_stream._peerdb_synced_at,
  metric_stream._peerdb_is_deleted,
  metric_stream._peerdb_version
FROM postgres_fitness.metric_stream AS metric_stream
LEFT JOIN postgres_fitness.sensor_provider_priority AS provider_priority
  ON provider_priority.provider_id = metric_stream.provider_id
 AND provider_priority.channel = metric_stream.channel
LEFT JOIN postgres_fitness.sensor_device_priority AS device_priority
  ON device_priority.provider_id = metric_stream.provider_id
 AND device_priority.channel = metric_stream.channel
 AND metric_stream.device_id LIKE device_priority.source_name_pattern
WHERE metric_stream.scalar IS NOT NULL
  AND metric_stream.channel IN (...)
```

If multiple device patterns match one row, select the most specific matching
override deterministically before falling back to provider-channel priority.
The implementation should use a ranked subquery rather than allowing duplicate
matches to duplicate samples.

### `analytics.deduped_sensor`

Create a final activity-agnostic table:

```text
- user_id UUID
- recorded_at DateTime64(6, 'UTC')
- recorded_date Date
- channel LowCardinality(String)
- scalar Float32
- provider_id LowCardinality(String)
- source_metric_stream_id UUID
- provider_priority UInt16
- refresh_version UInt64
- is_deleted UInt8
- refreshed_at DateTime64(9)
```

Recommended engine:

```text
ReplacingMergeTree(refresh_version)
ORDER BY (user_id, channel, recorded_date, recorded_at)
```

There is no `activity_id` column. Runtime activity reads filter by
`user_id`, `channel`, and the activity time window.

## Incremental Maintenance

The normal path can be much simpler than the previous dirty-activity-window
design.

For each new raw scalar row, the pipeline only needs to determine whether that
row is the best sample for its `(user_id, channel, recorded_at)` key. The winner
is the non-deleted row with the lowest `provider_priority`, with deterministic
tie-breakers by `provider_id` and `id`.

### Option A: Native Incremental MV With Versioned Winners

Use a native ClickHouse MV to write candidate rows directly into
`analytics.deduped_sensor`:

```sql
CREATE MATERIALIZED VIEW analytics.deduped_sensor_ingest
TO analytics.deduped_sensor
AS
SELECT
  user_id,
  recorded_at,
  recorded_date,
  channel,
  argMin(scalar, (provider_priority, provider_id, id)) AS scalar,
  argMin(provider_id, (provider_priority, provider_id, id)) AS provider_id,
  argMin(id, (provider_priority, provider_id, id)) AS source_metric_stream_id,
  min(provider_priority) AS provider_priority,
  toUnixTimestamp64Nano(max(_peerdb_synced_at)) AS refresh_version,
  0 AS is_deleted,
  now64(9) AS refreshed_at
FROM analytics.sensor_scalar_sample
WHERE _peerdb_is_deleted = 0
GROUP BY user_id, recorded_at, recorded_date, channel
```

This is the simplest shape, but it needs benchmarking and correctness checks.
ClickHouse incremental MVs operate on inserted blocks. If a later block contains
a higher-priority provider row for the same key, it can insert a newer winner,
but the final read path must consistently select the latest replacement row.

### Option B: Small App-Managed Key Recompute

Maintain a queue of changed scalar keys:

```text
analytics.sensor_dirty_key
- user_id UUID
- channel String
- recorded_at DateTime64(6, 'UTC')
- min_peerdb_synced_at DateTime64(9)
- max_peerdb_synced_at DateTime64(9)
- processed_at Nullable(DateTime64(9))
- failure_message Nullable(String)
```

For each key, run a bounded recompute:

```sql
SELECT ...
FROM analytics.sensor_scalar_sample FINAL
WHERE user_id = {user_id}
  AND channel = {channel}
  AND recorded_at = {recorded_at}
  AND _peerdb_is_deleted = 0
ORDER BY provider_priority ASC, provider_id ASC, id ASC
LIMIT 1
```

Then insert one replacement row into `analytics.deduped_sensor`, or a tombstone
if no live source rows remain.

This is still incremental, but it is more explicit than Option A and handles
updates/deletes cleanly. It also keeps `FINAL` bounded to one key at a time.

### Recommendation

Start with Option B unless benchmarking proves Option A is correct and simpler
under realistic PeerDB block behavior.

Option B is still small because the key space is `(user_id, channel,
recorded_at)`, not activity windows. It avoids the hard parts we are removing:
activity membership, sample-count source selection, and ambient fallback.

## Activity Read Path

Activity stream and zone queries should join activity context at read time:

```sql
SELECT recorded_at, channel, scalar
FROM analytics.deduped_sensor
WHERE user_id = {user_id}
  AND channel IN (...)
  AND recorded_at >= {activity_started_at}
  AND recorded_at <= {activity_ended_at}
  AND is_deleted = 0
ORDER BY recorded_at
```

If a canonical activity spans multiple member activities, the activity
repository should compute the combined time window or explicit member windows
and pass those windows to the sensor query. The sensor table itself remains
unaware of canonical activity ids.

`analytics.activity_summary` and `analytics.activity_trend_daily` should derive
from this activity-window read model rather than from stored
`deduped_sensor.activity_id`.

## Deletes and Updates

Deletes and updates are not the primary design driver, but the model should not
silently corrupt when they occur.

The normal path records `_peerdb_is_deleted` and `_peerdb_version` in
`sensor_scalar_sample`. Option B processes the changed key and writes a new
winner or tombstone. If an edge case is missed, a repair job can recompute a
bounded time range by user/channel.

Do not use a full-history refresh as the repair mechanism.

## Freshness and Failure Semantics

The refresh worker must fail loudly on unexpected errors and report to Sentry.
It must not silently advance watermarks when a dirty key fails.

Expose operational checks:

- latest `_peerdb_synced_at` in `postgres_fitness.metric_stream`,
- latest `_peerdb_synced_at` processed by the sensor pipeline,
- dirty-key backlog count and oldest dirty key age,
- latest `recorded_at` in `analytics.deduped_sensor` by channel,
- last refresh error message.

These checks should make chart staleness diagnosable without manually comparing
Postgres and ClickHouse tables.

## Migration and Rollout

Use a side-by-side rollout:

1. Add Postgres sensor priority tables, seeded defaults, audit table, and tests.
2. Remove `provider-priority.json` as the runtime source of truth once current
   priority defaults are represented in database seed data.
3. Mirror priority tables to ClickHouse through PeerDB.
4. Add `analytics.sensor_scalar_sample` and its native ingest MV.
5. Backfill `sensor_scalar_sample` from existing raw ClickHouse rows in bounded
   chunks.
6. Add `analytics.deduped_sensor_v2` without `activity_id`.
7. Add either the native winner MV or the dirty-key worker.
8. Backfill `deduped_sensor_v2` in bounded chunks by user/channel/date.
9. Update activity stream, zone, summary, and trend read paths to apply
   activity windows at query time.
10. Run parity checks for representative activities and channels.
11. Rename/cut over `deduped_sensor_v2` to `analytics.deduped_sensor`.
12. Drop the old refreshable materialized view after freshness and parity are
   proven.

Do not keep permanent fallback reads from the old refreshable view. A temporary
validation path is acceptable only until cutover is complete.

## Testing

Required tests:

- Provider priority tests prove DB-seeded metadata chooses expected providers
  and device overrides per channel.
- Audit tests prove priority changes record old value, new value, actor, and
  reason.
- ClickHouse SQL generation tests prove the new tables and native ingest MV are
  created, join priority tables generically, and the final table has no
  `activity_id`.
- Unit tests for dirty-key derivation from inserted, updated, and deleted rows.
- Integration tests prove lower-priority rows do not replace higher-priority
  rows for the same key, and higher-priority rows do replace lower-priority
  rows.
- Activity repository tests prove activity streams use activity time windows
  instead of `deduped_sensor.activity_id`.
- Migration tests prove the old refreshable MV is not used after cutover.

Production validation:

- Confirm a provider sync advances Postgres and PeerDB raw rows.
- Confirm the sensor scalar projection advances.
- Confirm dirty-key backlog drains, if Option B is used.
- Confirm `analytics.deduped_sensor` advances for affected channels without a
  full-history ClickHouse query.
- Confirm PeerDB replication slots remain active and lag decreases.

## Operational Runbook Updates

Update `docs/clickhouse-metric-stream.md` with the new ownership boundary:

- PeerDB owns raw CDC only.
- ClickHouse native MVs own narrow append-side scalar projection.
- The deduped sensor model is activity-agnostic.
- Postgres priority tables own provider/device/channel priority.
- Activity repositories own activity window selection.

Add a PeerDB freshness section to the operational docs with commands for:

- Postgres latest metric-stream row by channel,
- ClickHouse raw latest row by channel,
- sensor scalar projection latest row by channel,
- active priority values for a provider/device/channel,
- dirty-key backlog,
- PeerDB slot active/lag status,
- recent ClickHouse full-scan queries.

## Risks

Removing `activity_id` changes the read-model boundary. Activity summaries and
zone calculations must be audited so they apply exactly the same activity time
windows they previously got from stored activity ids.

Static provider priority is simpler and more stable than sample-count winner
selection, but it is a semantic change. The seeded priority rows must be
reviewed for important channels before cutover, and production edits need audit
coverage so priority does not become unexplained hidden state.

Native ClickHouse incremental MVs may be enough for winner writes, but PeerDB
block behavior and replacement semantics need realistic testing. If native MV
behavior is ambiguous, use the dirty-key worker.

Historical backfill can still be expensive. It must be resumable, chunked, and
run with strict concurrency limits.

## Recommendation

Use the simplified activity-agnostic model.

The first implementation should favor correctness and operational clarity:
database-owned static provider priority, no `activity_id` in the sensor table,
bounded dirty-key recompute, and activity-window filtering in repositories.
After that is proven, benchmark whether the dirty-key worker can be replaced or
partially replaced by a pure native ClickHouse incremental MV.
