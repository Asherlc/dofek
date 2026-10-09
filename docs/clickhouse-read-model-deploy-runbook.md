# ClickHouse Read Model Deploy Runbook

This runbook covers deploy failures involving ClickHouse CDC, ClickHouse
analytics read models, or legacy Postgres fitness view DDL. It exists because
normal deploys must not rebuild hot Postgres read models.

## Rules

- Do not add deploy-time Postgres `CREATE OR REPLACE VIEW`, `DROP VIEW`, or
  materialized-view refresh work for hot fitness read models.
- Do not restore `refresh_materialized_views` deploy inputs or post-sync
  refresh hooks as a shortcut.
- Use ClickHouse-native `postgres_fitness.*` mirror tables and `analytics.*`
  read models for sensor and fitness analytics paths.
- Missing CDC prerequisites must fail loudly with explicit table or column
  names.
- Capture the failing step, the first fatal log line, and the causal chain
  before changing code.

## Fast Triage

### Compact sensor analytics: two-release boundary

Preparation release A preserves old request readers and processing/cache
coverage behavior. It installs the bounded pace/HR writers and the parameterized
`activity_sensor_processing_coverage` view after both writers, plus canonical
version-aware registered cache replay. The view reads current/prior activity
keys and exact source pairs; it does not store another source of truth.
ClickHouse documents views in [CREATE VIEW](https://clickhouse.com/docs/reference/statements/create/view)
and dbt owns them through [view materialization](https://docs.getdbt.com/reference/resource-configs/materialized).
Require an explicit UUID user set at every current/prior/activity/sensor-day/
inventory entry. B derives targets from processing/cache work and registered
changed-path keys, preserving their enumeration and snapshot; empty targets
perform no coverage work and never mean all users. Parameterized views lack
ordinary schema metadata without parameters, as described in
[parameterized views](https://clickhouse.com/docs/reference/statements/create/view#parameterized-view).
At each typed coverage read, parameterized DESCRIBE and natural EXPLAIN, also pass
the existing view context explicitly:
`clickhouse_settings: { max_threads: 1, join_use_nulls: 1, enable_materialized_cte: 1 }`.
Use the existing [ClickHouse client query interface](https://clickhouse.com/docs/integrations/javascript#query-method)
without changing generic clients or global settings. Stored view settings alone
did not bound outer execution in the pinned empty-model fixture; the actual
default-caller failure remains in the [incident baseline](production-incident-baseline.md).
The natural invocation gate validates this required UUID/context contract.
Retain independent [workload-specific lane/memory measurements](https://clickhouse.com/resources/engineering/high-concurrency-sizing-user-analytics);
this context is coverage-specific and does not prove materialized CTE reuse.
Preparation A activates no production coverage consumer. Reader B must supply
and independently test this context at its canonical production typed boundary.
Verify pinned canonical dbt initial create and replacement, discovery,
parameterized DESCRIBE, schema/contracts, docs, artifacts, tests and SQLFluff
before adopting the preparation source. No custom materializer or bypass is
approved. Verify EXPLAIN/read rows/memory/time with the existing semantic
settings; user row scope and total query/worker memory are independent gates.
The prior ordinary view read unrelated-user sources, and its approximately
550 MB query memory remains a separate concern; see the
[incident baseline](production-incident-baseline.md).

Reader release B requires independently reviewed A source/image and verified
population, complete exact twelve-duration pace markers, one current HR marker
per activity, and disappearance/deletion/processed-empty coverage. Its finite
captured catchup uses at most 32 exact user/activity/source pairs per compact
writer invocation through the existing dbt [project variables](https://docs.getdbt.com/docs/build/project-variables).
It runs the canonical build once and finishes captured work before registered
warming. Model success or a run ID alone cannot authorize current cache status.
Per-path generation evidence includes actual request context and live HR
profile/RHR inputs, with matching snapshots checked after warming.

Measure full source-to-visible lag and resource cost for stable backlog and
source arrival during draining/warming against the original reader/cache
baseline and the existing fifteen-minute contract. New source operations stay
pending; an older verified snapshot cannot complete them. A finite capture
does not guarantee arbitrary-churn latest-input parity. Any failed freshness,
scope or resource gate blocks B cutover and requires direction. No extra release,
timer, retry, TTL extension, optimizer override or raw-reader fallback is part
of this rollout. Source implementation approval is not production permission.
See the [implementation plan](superpowers/plans/2026-10-02-subsecond-page-loading.md#task-6-serve-compact-pacehr-results-and-prove-freshness).

Inspect the deploy with `gh`:

```bash
gh run view <run-id> --repo Asherlc/dofek --json status,conclusion,url,jobs
gh run view <run-id> --repo Asherlc/dofek --job <job-id> --log
```

The important deploy steps are:

1. `Run migrations`
2. `Deploy stack`
3. `Wait for PeerDB`
4. `Configure ClickHouse CDC`

If the job times out, identify the last active step and inspect both GitHub
logs and server state before retrying.

## Known Failure: New PeerDB Table Added Before Its Migration

For DOFEK-SERVER-3B, [deploy 37873586628](https://github.com/Asherlc/dofek/actions/runs/37873586628)
added `fitness.provider_field_priority` during `Prepare PeerDB CDC contract`,
before Postgres migration `0144` created it. The first fatal PeerDB activity
reported that the table was missing from `peerdb_raw_analytics_publication`.
The fitness mirror entered `STATUS_SNAPSHOT`,
its existing slot became inactive, and the failed deployment left ClickHouse
consumers quiesced. Catalog `flows.status = 1` alone did not reflect the stuck
workflow; [PeerDB's status handler](https://github.com/PeerDB-io/peerdb/blob/v0.36.19/flow/cmd/mirror_status.go)
queries Temporal for the current state.

The durable boundary is: prepare reconciles and validates existing mapping
identities against the old schemas; tracked migrations create new source and
destination tables; CDC setup configures publication membership and reconciles
the full mapping contract. Finalize/verify then prove exact causal markers
before the final canonical deploy restores consumers. See
[contract deployment](../src/db/peerdb/mirror-deployment.ts),
[CDC setup](../src/db/clickhouse-cdc.ts), and
[deployment order](processing-status-runbook.md#deployment-order).

### Reviewable recovery procedure

This procedure is prepared for an operator; it does not authorize production
mutation. SSH shell diagnostics remain read-only. Execute the cancellation only
as a separately approved remote Docker API operator action, then use the fixed
canonical CI deployment
for migrations, CDC setup, marker verification, and consumer restoration.

PeerDB `v0.36.19` supports
`POST /v1/flows/cdc/cancel_table_addition` in `STATUS_SETUP` or
`STATUS_SNAPSHOT`. It restores the pre-addition catalog mapping set plus any
completed QRep additions, checks catalog source OIDs before updating the
catalog or replacing the workflow, and starts CDC without setup/snapshot.
It preserves the slot and destination data; its publication cleanup skips an
explicit user publication such as `peerdb_raw_analytics_publication`.
These behaviors come from the pinned
[request/response definition](https://github.com/PeerDB-io/peerdb/blob/v0.36.19/protos/route.proto#L518-L529),
[handler](https://github.com/PeerDB-io/peerdb/blob/v0.36.19/flow/cmd/cancel_table_addition.go),
[workflow](https://github.com/PeerDB-io/peerdb/blob/v0.36.19/flow/workflows/cancel_table_addition_flow.go), and
[activities](https://github.com/PeerDB-io/peerdb/blob/v0.36.19/flow/activities/cancel_table_addition_activity.go).

1. Preserve the failing step, log reporting missing publication membership, API
   workflow state, slot state, and current consumer replica counts. Verify the deployed PeerDB image
   is still `v0.36.19`. Require the existing slot's `wal_status` to be `reserved`
   or `extended` and `restart_lsn` to be non-null; `unreserved` or `lost`
   requires fresh recovery review. Stop if the workflow has changed or evidence
   names a different failure. Slot fields are documented in
   [PostgreSQL replication slots](https://www.postgresql.org/docs/current/view-pg-replication-slots.html).
2. Review the incident-specific baseline: ten mappings for `fitness.activity`,
   `sleep_session`, `sleep_stage`, `daily_metrics`, `provider`,
   `provider_connection`, `provider_priority`, `device_priority`,
   `processing_flow_marker`, and `user_profile`; each destination has the same
   unqualified table name. The pending addition is
   `fitness.provider_field_priority` to `provider_field_priority`. Preserve all
   live mapping properties, including the existing sleep/daily exclusions.
   Do not substitute a newly rendered contract or remove a baseline table.
3. Run the source and catalog queries below through the existing read-only
   database operator connections, without exporting credentials. Require nonzero
   source OIDs and publication membership for every baseline table, catalog
   schema entries for their destinations, and no completed pending addition.
   The cancellation endpoint separately rejects a missing catalog schema or
   zero catalog OID before mutation. A completed addition is retained by the
   endpoint and requires fresh review rather than this baseline-only recovery.

```sql
-- Source Postgres: all ten baseline rows must have nonzero OIDs and published=true.
SELECT source_table, to_regclass(source_table)::oid AS source_oid,
  EXISTS (SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'peerdb_raw_analytics_publication'
      AND schemaname || '.' || tablename = source_table) AS published
FROM unnest(ARRAY['fitness.activity', 'fitness.sleep_session', 'fitness.sleep_stage',
  'fitness.daily_metrics', 'fitness.provider', 'fitness.provider_connection',
  'fitness.provider_priority', 'fitness.device_priority',
  'fitness.processing_flow_marker', 'fitness.user_profile']) AS expected(source_table);
SELECT slot_name, active, wal_status, restart_lsn,
  pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_wal_bytes
FROM pg_replication_slots
WHERE slot_name = 'peerflow_slot_dofek_fitness_raw_analytics';

-- PeerDB catalog: every baseline destination must exist; no pending copy may be complete.
SELECT table_name FROM public.table_schema_mapping
WHERE flow_name = 'dofek_fitness_raw_analytics' ORDER BY table_name;
SELECT source_table, run_uuid, consolidate_complete FROM peerdb_stats.qrep_runs
WHERE parent_mirror_name = 'dofek_fitness_raw_analytics'
  AND source_table = 'fitness.provider_field_priority';
```

4. After operator approval, submit the following supported request. It rereads
   live mappings, preserves their full objects, and leaves the removal override
   false. Keep the same recorded idempotency key if the client disconnects;
   inspect the cancellation workflow and mirror state before resubmitting.
   The handler's idempotency key selects the Temporal cancellation workflow,
   while its state precondition rejects a mirror that already resumed. Choose
   the exact running web container ID with `docker --host ssh://dofek-server ps`,
   using the [configured production SSH alias](../deploy/README.md#ssh-access-debugging-only); Node
   reaches the internal Flow API through its existing overlay network. Print
   only selected status fields, never the full config or its `env` map.

```bash
web_task='<reviewed-running-web-container-id>'
docker --host ssh://dofek-server exec -i --workdir /app "$web_task" node --input-type=module <<'NODE'
const flow = 'dofek_fitness_raw_analytics';
const api = 'http://peerdb-flow-api:8113/v1';
const post = async (path, body) => {
  const response = await fetch(`${api}/${path}`, {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) throw new Error(`PeerDB HTTP ${response.status}: ${result.message ?? 'request rejected'}`);
  return result;
};
const status = await post('mirrors/status',
  {flow_job_name: flow, include_flow_info: true, exclude_batches: true});
if (!['STATUS_SETUP', 'STATUS_SNAPSHOT'].includes(status.currentFlowState))
  throw new Error(`Recovery precondition changed: ${status.currentFlowState}`);
const config = status.cdcStatus.config;
console.log(JSON.stringify({state: status.currentFlowState,
  publication: config.publicationName, mappings: config.tableMappings,
  snapshots: status.cdcStatus.snapshotStatus}, null, 2));
const expected = ['activity', 'sleep_session', 'sleep_stage', 'daily_metrics',
  'provider', 'provider_connection', 'provider_priority', 'device_priority',
  'processing_flow_marker', 'user_profile', 'provider_field_priority'];
if (config.publicationName !== 'peerdb_raw_analytics_publication' ||
    config.tableMappings.length !== expected.length ||
    expected.some(name => !config.tableMappings.some(mapping =>
      mapping.sourceTableIdentifier === `fitness.${name}` && mapping.destinationTableIdentifier === name)))
  throw new Error('Live mappings differ from the reviewed incident baseline');
if (status.cdcStatus.snapshotStatus.clones.some(copy =>
    copy.sourceTable === 'fitness.provider_field_priority' && copy.consolidateCompleted))
  throw new Error('Pending addition completed a snapshot; review recovery again');
const result = await post('flows/cdc/cancel_table_addition', {
  flow_job_name: flow, currently_replicating_tables: config.tableMappings,
  idempotency_key: 'DOFEK-SERVER-3B-2026-10-08', assume_table_removal_will_not_happen: false,
});
console.log(JSON.stringify({flow: result.flowJobName, runId: result.runId,
  mappings: result.tablesAfterCancellation}, null, 2));
NODE
```

5. Recheck API `STATUS_RUNNING`, the same active slot with non-null `restart_lsn`
   and `wal_status` still `reserved` or `extended`, and the ten baseline mappings.
   Run the existing health command in
   the running `cdc-health` container:
   `node --experimental-strip-types scripts/check-clickhouse-cdc.ts`.
   Require a fresh passing monitor result and inspect normalization progress
   with the [CDC health runbook](clickhouse-cdc-health-runbook.md).
6. Deploy the tested fix through canonical CI. Require migrations, full CDC
   setup, finalize, and exact marker verification to succeed before the final
   stack deploy restores consumers. Confirm `provider_field_priority` exists
   on both databases, belongs to the publication, and is mirrored. An active
   slot or successful cancellation alone does not prove that new mapping or
   analytics freshness. Record the recovery evidence in the
   [incident baseline](production-incident-baseline.md).

## Known Failure: PeerDB Destination Validation

Symptom:

```text
invalid mirror: rpc error: code = FailedPrecondition desc = failed to validate destination connector ... not all PeerDB columns found in destination table <table>
```

Cause:

The ClickHouse destination table does not match the columns PeerDB expects. For
Postgres-to-ClickHouse mirrors, every mirrored raw table must include the PeerDB
metadata columns used by the mirror:

- `_peerdb_synced_at`
- `_peerdb_is_deleted`
- `_peerdb_version`

Fix pattern:

1. Add the missing columns to the ClickHouse raw mirror DDL.
2. Add or update tests that assert the mirror table includes PeerDB metadata.
3. Rerun the deploy; do not bypass CDC setup.

## Known Failure: Missing Activity Ends Become Epoch Timestamps

Compare source `fitness.activity.ended_at IS NULL` with the same IDs in
`postgres_fitness.activity FINAL`. A non-nullable destination converts missing
timestamps into defaults; this can produce negative durations and corrupt load
analytics. PeerDB documents [nullable column mapping](https://clickhouse.com/blog/postgres-to-clickhouse-data-modeling-tips).

CDC setup persists `PEERDB_NULLABLE=true` in the PeerDB catalog's
`public.dynamic_settings`; no application environment variable is required.
PeerDB resolves this catalog setting after mirror-specific overrides, and its
application mode is new mirrors: [versioned configuration implementation](https://github.com/PeerDB-io/peerdb/blob/v0.36.19/flow/internal/dynamicconf.go).
Migration 0101 restores nullable raw and deduplicated activity end columns;
the deployment schema validator rejects a non-nullable activity end column.
Changing the type does not repair existing defaults: [ClickHouse Nullable](https://clickhouse.com/docs/sql-reference/data-types/nullable).

For an existing mirror, capture exact mismatched source IDs, restore only those
raw values from Postgres, and confirm a subsequent CDC update preserves NULL.
Then rebuild the affected activity source records, deduplicated activities,
summary rows, and daily endurance load. Use the existing user/activity refresh
scope for activity models; do not put historical repair in runtime setup.
Run operator dbt rebuilds in a separate one-shot container using the deployed
image and normal ClickHouse credentials. Do not start a second dbt process
inside a busy analytics worker: both processes share its memory limit. For a
read-only project mount, put `--log-path` and `--target-path` in writable
temporary directories. Remove temporary credential files after the rebuild.
Docker documents [container memory limits](https://docs.docker.com/engine/containers/resource_constraints/#memory)
and dbt documents [log-path](https://docs.getdbt.com/reference/global-configs/logs#log-path)
and [target-path](https://docs.getdbt.com/reference/global-configs/json-artifacts#target-path).
Verify unknown ends remain NULL, no active duration is negative, obsolete load
rows are tombstoned, and registered chart caches are recomputed. Missing ends
are excluded from duration/load totals; the bounded sensor search window must
not become a fabricated duration. dbt supports [incremental model execution](https://docs.getdbt.com/docs/build/incremental-models).

## Known Failure: Deploy Migration Timeout

Symptom:

```text
Migration exceeded 3300s
```

Possible causal SQL:

```sql
CREATE OR REPLACE VIEW fitness.v_daily_metrics AS ...
```

Diagnosis:

Check for blocked DDL and lock queues on Postgres. SSH is allowed for reading
logs and state only; do not edit server config manually.

Useful read-only checks:

```sql
SELECT pid,
       wait_event_type,
       wait_event,
       state,
       now() - query_start AS age,
       left(query, 250) AS query
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY query_start;

SELECT blocked.pid AS blocked_pid,
       blocked_activity.query AS blocked_query,
       blocking.pid AS blocking_pid,
       blocking_activity.query AS blocking_query
FROM pg_locks blocked
JOIN pg_stat_activity blocked_activity ON blocked_activity.pid = blocked.pid
JOIN pg_locks blocking
  ON blocking.locktype = blocked.locktype
 AND blocking.database IS NOT DISTINCT FROM blocked.database
 AND blocking.relation IS NOT DISTINCT FROM blocked.relation
 AND blocking.page IS NOT DISTINCT FROM blocked.page
 AND blocking.tuple IS NOT DISTINCT FROM blocked.tuple
 AND blocking.virtualxid IS NOT DISTINCT FROM blocked.virtualxid
 AND blocking.transactionid IS NOT DISTINCT FROM blocked.transactionid
 AND blocking.classid IS NOT DISTINCT FROM blocked.classid
 AND blocking.objid IS NOT DISTINCT FROM blocked.objid
 AND blocking.objsubid IS NOT DISTINCT FROM blocked.objsubid
 AND blocking.pid <> blocked.pid
JOIN pg_stat_activity blocking_activity ON blocking_activity.pid = blocking.pid
WHERE NOT blocked.granted
ORDER BY blocked_activity.query_start;
```

Fix pattern:

1. Remove deploy-time Postgres view DDL for hot read models.
2. Move the read model to ClickHouse if it belongs to the fitness analytics
   path.
3. Keep Postgres migrations forward-only and cheap.
4. Rerun the deploy from the branch after local validation.

## Known Failure: `provider_stats` Current-State Scan Timeout

Symptom:

```text
Code: 159, e.displayText() = DB::Exception: Timeout exceeded: elapsed ...
```

The analytics worker logs the model name and the ClickHouse query log records
the authoritative duration, rows, bytes, and exception code. ClickHouse's
[`system.query_log`](https://clickhouse.com/docs/operations/system-tables/query_log)
is the source of truth for this diagnosis; do not infer the cause from the
worker's retry cadence.

Capture service state and the first fatal log line without changing production
state. The deploy runbook uses the OCI host in the `ORACLE_SERVER_HOST`
GitHub Actions variable ([production host configuration](../deploy/README.md)):

```bash
oracle_host=$(gh variable get ORACLE_SERVER_HOST --repo Asherlc/dofek)
ssh ubuntu@"$oracle_host" 'docker service ps --no-trunc dofek_analytics-worker'
ssh ubuntu@"$oracle_host" 'docker service logs --since 2h --raw --timestamps dofek_analytics-worker 2>&1'
```

Inspect the exact model query and its resource footprint from the ClickHouse
container:

```bash
ssh ubuntu@"$oracle_host" 'bash -s' <<'REMOTE'
set -euo pipefail
clickhouse=$(docker ps --format '{{.Names}}' | grep dofek_clickhouse | head -1)
test -n "$clickhouse"
docker exec -i "$clickhouse" sh -lc 'clickhouse-client --password "$CLICKHOUSE_PASSWORD"' <<'SQL'
SELECT
  event_time,
  type,
  query_duration_ms,
  read_rows,
  formatReadableSize(read_bytes) AS read_bytes,
  memory_usage,
  exception_code,
  left(exception, 240) AS exception,
  query_id
FROM system.query_log
WHERE event_time >= now() - INTERVAL 6 HOUR
  AND positionCaseInsensitive(query, 'model.dofek_analytics.provider_stats') > 0
  AND type IN ('ExceptionWhileProcessing', 'QueryFinish')
ORDER BY event_time DESC
LIMIT 50;
SQL
REMOTE
```

Check whether the current-state projection is present on every active raw
table part. A newly created projection is maintained for new inserts, but
existing parts require an explicit
[`MATERIALIZE PROJECTION`](https://clickhouse.com/docs/data-modeling/projections#filtering-on-columns-which-arent-in-the-primary-key)
operation:

```bash
ssh ubuntu@"$oracle_host" 'bash -s' <<'REMOTE'
set -euo pipefail
clickhouse=$(docker ps --format '{{.Names}}' | grep dofek_clickhouse | head -1)
docker exec -i "$clickhouse" sh -lc 'clickhouse-client --password "$CLICKHOUSE_PASSWORD"' <<'SQL'
SELECT
  countIf(NOT has(projections, 'by_provider_current_state')) AS missing_projection_parts,
  count() AS active_parts
FROM system.parts
WHERE active
  AND database = 'ingest'
  AND table = 'metric_stream';

SELECT
  name,
  rows,
  formatReadableSize(bytes_on_disk) AS bytes_on_disk,
  has(projections, 'by_provider_current_state') AS has_current_state_projection
FROM system.parts
WHERE active
  AND database = 'ingest'
  AND table = 'metric_stream'
ORDER BY rows DESC
LIMIT 20;

SELECT
  source_state.user_id,
  source_state.provider_id,
  source_state.changed_at,
  watermark.refreshed_at
FROM
(
    SELECT
      user_id,
      provider_id,
      max(changed_at) AS changed_at
    FROM analytics.provider_change_state
    GROUP BY user_id, provider_id
) AS source_state
INNER JOIN
(
    SELECT
      user_id,
      provider_id,
      max(refreshed_at) AS refreshed_at
    FROM analytics.provider_change_watermark FINAL
    GROUP BY user_id, provider_id
) AS watermark
  ON watermark.user_id = source_state.user_id
 AND watermark.provider_id = source_state.provider_id
WHERE source_state.changed_at > watermark.refreshed_at
ORDER BY source_state.changed_at ASC
LIMIT 50;
SQL
REMOTE
```

This compares the live provider-change source with the watermark's last
refresh time. Comparing the watermark row's own `changed_at` with
`refreshed_at` would be tautologically clean because that row is written from
the source during the refresh.

Interpret the evidence in this order:

1. If active parts are missing `by_provider_current_state`, materialize that
   projection as an approved maintenance operation, monitor the mutation to
   completion, and rerun the same query. The existing projection rollout is
   documented in [clickhouse-metric-stream.md](clickhouse-metric-stream.md).
2. If the projection is present but `provider_stats` still reads tens of
   millions of current-state IDs before reaching the existing execution
   boundary, the projection is working but is not a compact per-provider
   count. The exact count remains proportional to the dirty provider's
   current record cardinality. This is a read-model design problem, not a
   reason to raise `max_execution_time`, add retries, or force a larger memory
   budget; ClickHouse documents that setting as an execution limit, not a
   query optimization ([`max_execution_time`](https://clickhouse.com/docs/operations/settings/settings#max_execution_time)).
3. Record the model-specific failure fingerprint and leave the dirty watermark
   visible until the dbt-owned `provider_metric_stream_daily` source is caught
   up and validated against tombstones and replacements. The rollout and
   readiness checks are documented in the remediation section below.

Never mark the refresh successful merely because the worker retries. Verify
the next `QueryFinish` row, the analytics processing marker, and the affected
read-model freshness before closing the incident.

## Provider metric-count remediation (migration 0068)

The durable remediation is the bounded daily model documented in
[`clickhouse-metric-stream.md`](clickhouse-metric-stream.md#daily-provider-metric-count-rollout).
Migration `0068_provider_metric_stream_daily_counts` creates the day-change
invalidation state and the covering
`by_provider_current_state_recorded_at` projection. The deploy migration does
not materialize the projection or bootstrap historical keys; those are explicit
operator actions because `MATERIALIZE PROJECTION` rewrites existing parts
([ClickHouse projection maintenance](https://clickhouse.com/docs/data-modeling/projections#filtering-on-columns-which-arent-in-the-primary-key)).

Use this stop-gated sequence after the migration succeeds:

1. Materialize `by_provider_current_state_recorded_at`. Stop on any non-empty
   `latest_fail_reason`, and do not continue until the relevant mutation has
   `is_done = 1` with an empty `latest_fail_reason`.
2. Verify that `system.parts` reports at least one active
   `ingest.metric_stream` part and that every active part has the projection.
3. Bootstrap `analytics.metric_stream_day_change` from
   `ingest.metric_stream` in explicit provider/date windows, forcing
   `by_provider_current_state_recorded_at` for each bounded batch. Record the
   last completed window as the resume checkpoint; never use an unrestricted
   historical `GROUP BY`. Then observe the bounded
   `provider_metric_stream_daily` batches.
4. Keep the provider watermark dirty until the day-marker readiness query is
   empty; do not publish a partial provider count.
5. Confirm a successful `provider_stats` `QueryFinish`, analytics processing
   success, and provider-inventory freshness.

If raw metric-stream rows still appear in the `provider_stats` query after the
daily model is deployed, stop and capture the rendered dbt SQL and
`system.query_log` evidence. Do not raise execution limits, add retries, or
turn the daily model into a warning-only step. dbt's incremental model contract
keeps the serving transformation bounded and stateful:
[dbt incremental models](https://docs.getdbt.com/docs/build/incremental-models).

## Activity source-version projection rollout (migration 0073)

Migration `0073_activity_sensor_summary_source_version` registers
`by_activity_source_refresh_version`, but the deploy migration intentionally
does not rewrite existing `analytics.activity_sensor_sample` parts. ClickHouse
requires an explicit
[`MATERIALIZE PROJECTION`](https://clickhouse.com/docs/reference/statements/alter/projection)
operation to populate a newly added projection on historical parts.

After the migration and dbt model deploy succeed, run this stop-gated sequence
from the production ClickHouse client:

```sql
SELECT
  countIf(NOT has(projections, 'by_activity_source_refresh_version')) AS missing_projection_parts,
  count() AS active_parts
FROM system.parts
WHERE active
  AND database = 'analytics'
  AND table = 'activity_sensor_sample';

ALTER TABLE analytics.activity_sensor_sample
MATERIALIZE PROJECTION by_activity_source_refresh_version
SETTINGS mutations_sync = 0;

SELECT
  mutation_id,
  command,
  is_done,
  parts_to_do,
  latest_fail_reason
FROM system.mutations
WHERE database = 'analytics'
  AND table = 'activity_sensor_sample'
  AND command LIKE '%MATERIALIZE PROJECTION by_activity_source_refresh_version%'
ORDER BY create_time DESC;
```

`mutations_sync = 0` submits a server-side mutation without waiting for
completion; the operation continues if the client disconnects. Identify it
with the `system.mutations` query and treat the latest row as the resume
checkpoint. Do not submit a duplicate while `is_done = 0`.
Stop on any non-empty `latest_fail_reason`. If no mutation is running and the
initial command was never accepted, rerun it once; otherwise resume by
monitoring the existing mutation.

After `is_done = 1`, rerun the `system.parts` query and require
`missing_projection_parts = 0`. Then observe one successful analytics-worker
cycle and verify the stale activity-summary count reaches zero before declaring
the rollout complete. Do not force the summary refresh before projection
materialization completes.

## Route source-freshness projection rollout (migration 0097)

Migration `0097_activity_route_source_freshness_projections` replaces the sensor
`by_activity_source_refresh_version` definition with both `max(refresh_version)`
and `maxIf(refreshed_at, channel = 'altitude')`. It also adds location
`by_activity_location_source_refresh`, matching
`max(greatest(source_refreshed_at, refreshed_at))`. Both retain deleted rows in
their freshness aggregates so later tombstones invalidate routes. dbt carries
the same definitions when recreating targets. The migration changes schema
only; replacing the sensor definition removes its old historical projection
coverage. Newly inserted parts maintain projections automatically, while old
parts require explicit materialization ([ClickHouse projections](https://clickhouse.com/docs/concepts/features/projections/projections)).

Historical materialization requires a separate approved maintenance window and
the approved CI or remote database operator channel. The SQL below is a
reviewable operator procedure, not permission to mutate production over SSH;
production SSH remains read-only under the repository deployment policy.
Inventory the work first using [system.parts](https://clickhouse.com/docs/operations/system-tables/parts):

```sql
SELECT table, partition_id, sum(rows) AS rows, sum(bytes_on_disk) AS bytes,
  countIf(NOT has(projections, if(table = 'activity_sensor_sample',
    'by_activity_source_refresh_version', 'by_activity_location_source_refresh')))
    AS missing_projection_parts
FROM system.parts
WHERE active AND database = 'analytics'
  AND table IN ('activity_sensor_sample', 'activity_location_sample')
GROUP BY table, partition_id
ORDER BY table, partition_id;
```

Also capture the per-part inventory below before and after the part-filtered
empty-row checks. Compare exact part names and delete-mask/projection flags;
the grouped totals alone cannot detect a replaced part.

```sql
SELECT table, partition_id, name AS part_name, has_lightweight_delete,
  has(projections, if(table = 'activity_sensor_sample',
    'by_activity_source_refresh_version',
    'by_activity_location_source_refresh')) AS has_expected_projection
FROM system.parts
WHERE active AND database = 'analytics'
  AND table IN ('activity_sensor_sample', 'activity_location_sample')
ORDER BY table, partition_id, part_name;
```

Agree on maximum partition rows/bytes and available disk/memory before writing.
Process one reviewed partition of one table at a time; substitute its exact
`partition_id` below. Both source tables currently have no partition key,
so each table's single `all` partition is its smallest native materialization scope.
If either partition exceeds the approved capacity bounds, stop and review the
operation with the owner; a time filter cannot subdivide native projection
materialization. ClickHouse supports partition-scoped
[`MATERIALIZE PROJECTION`](https://clickhouse.com/docs/reference/statements/alter/projection).

```sql
ALTER TABLE analytics.activity_sensor_sample
MATERIALIZE PROJECTION by_activity_source_refresh_version
IN PARTITION ID '<reviewed-partition-id>' SETTINGS mutations_sync = 0;

-- Run separately, after the sensor partition completes and capacity is checked.
ALTER TABLE analytics.activity_location_sample
MATERIALIZE PROJECTION by_activity_location_source_refresh
IN PARTITION ID '<reviewed-partition-id>' SETTINGS mutations_sync = 0;

SELECT table, mutation_id, command, is_done, parts_to_do, latest_fail_reason
FROM system.mutations
WHERE database = 'analytics'
  AND table IN ('activity_sensor_sample', 'activity_location_sample')
  AND command LIKE '%MATERIALIZE PROJECTION%'
ORDER BY create_time DESC;
```

Record each accepted mutation as the resume checkpoint. Do not resubmit while
it is running, and stop on a non-empty `latest_fail_reason`; these progress
fields are documented in [system.mutations](https://clickhouse.com/docs/operations/system-tables/mutations).
Require completion and zero uncovered query-visible rows before selecting the
next partition. Every active part must have the expected projection or be
separately verified as fully masked and empty. For each projection-less part,
require `has_lightweight_delete = 1` in `system.parts` and run a part-filtered
query that reads a base column, substituting the exact table and part name:

```sql
SELECT count() AS visible_rows, min(recorded_at), max(recorded_at)
FROM analytics.activity_sensor_sample
WHERE _part = '<uncovered-part-name>';
```

Require `visible_rows = 0` for every such part. Record the inventory before and
after these queries; if the projection-less part names change, repeat the
verification against the new inventory. An absent projection alone is never
evidence that a part is empty. ClickHouse's
[lightweight-delete mask](https://clickhouse.com/docs/reference/statements/delete#how-lightweight-deletes-work-internally-in-clickhouse)
hides rows before later merges remove them physically, and
[system.parts](https://clickhouse.com/docs/reference/system-tables/parts)
reports whether a part has that mask. This exception concerns internal delete
masks; application `is_deleted` tombstone rows remain query-visible and must
retain projection coverage so they invalidate routes.

After all partitions are covered, verify natural selection with
`EXPLAIN projections = 1` for the two exact aggregates above, and observe an
unscoped incremental route build. Require both projection names in its
`system.query_log.projections`, bounded read rows, successful route/tombstone
output, and a successful analytics-worker cycle. Query-log projection evidence
is documented in [ClickHouse's projection verification example](https://clickhouse.com/docs/concepts/features/projections/projections#filtering-on-columns-which-arent-in-the-primary-key).
Do not force a build before coverage completes or compensate for incomplete
coverage with retries, higher timeouts, or forced optimizer settings.

Run the separate aggregate checks without projection preference or force
settings. A scheduled build may retain previously deployed query settings;
record those settings with its query-log evidence rather than describe that
build as having no optimizer hints. Distinguish compact freshness reads from
the remaining indexed geometry work, and retain query-log, readiness, and live/tombstone
output snapshots together for recovery review. ClickHouse documents projection
selection in the [query-log verification example](https://clickhouse.com/docs/concepts/features/projections/projections#filtering-on-columns-which-arent-in-the-primary-key).

## Activity sensor summary queue-depth check

Use this read-only check to confirm the `activity_sensor_summary_rows`
dirty-key backlog has drained. It reports the activities whose sensor samples
are newer than their stored summary, which is the model's `changed_sample`
dirty set.

```sql
SELECT count() AS dirty_keys
FROM (
    SELECT s.activity_id AS activity_id, s.user_id AS user_id
    FROM (
        SELECT activity_id, user_id, max(refresh_version) AS source_refresh_version
        FROM analytics.activity_sensor_sample
        GROUP BY activity_id, user_id
    ) AS s
    INNER JOIN (
        SELECT activity_id, user_id
        FROM analytics.deduped_activities
        GROUP BY activity_id, user_id
    ) AS c ON c.activity_id = s.activity_id AND c.user_id = s.user_id
    LEFT JOIN (
        SELECT activity_id, user_id, argMax(source_refresh_version, refresh_version) AS sv
        FROM analytics.activity_sensor_summary_rows
        GROUP BY activity_id, user_id
    ) AS e ON e.activity_id = s.activity_id AND e.user_id = s.user_id
    WHERE e.activity_id IS null OR s.source_refresh_version > e.sv
);
```

Do **not** wrap the inner aggregation in a `MATERIALIZED` CTE. The sample
subquery is served by the `by_activity_source_refresh_version` projection;
`MATERIALIZED` forces full-table materialization and is what makes this check
expensive. Verified production cost on 2026-09-16: ~200 ms, ~6.5 million rows
read, ~8 MiB peak memory, with projection
`analytics.activity_sensor_sample.by_activity_source_refresh_version` in use.

The value is a bounded freshness backlog, not an error count: it is the number
of activities whose sensor samples were refreshed since their last summary
write. It normally stays small (tens) because each unscoped summary cycle
processes the 100 oldest dirty keys and drains them within that cycle.

Do not treat 100 as a queue-depth ceiling. The `LIMIT 100` bounds the keys one
cycle selects, not the keys that can be dirty; arrivals between cycles can push
the count above 100 without indicating a regression. Judge health by trend and
by the age of the oldest dirty key: a backlog that keeps growing across cycles,
or an oldest dirty key that keeps aging, indicates a regression.

## Local Validation

Start dependencies before integration tests:

```bash
pnpm compose:up
pnpm compose -- ps db redis clickhouse redpanda
```

Run the normal gates:

```bash
pnpm lint
pnpm test:changed
pnpm typecheck
pnpm test:changed:all
```

ClickHouse-heavy integration tests create isolated raw mirror databases and
refresh read models. If local ClickHouse starts returning `socket hang up`
during concurrent setup, verify the test configuration is not running those
files in parallel and restart ClickHouse only after preserving the first fatal
test command.

## Deploy Retry

After committing and pushing the fix branch:

```bash
gh workflow run "Deploy" --repo Asherlc/dofek --ref <branch> -f target=web-stack
gh run watch <run-id> --repo Asherlc/dofek --interval 20 --exit-status
```

Successful evidence must include:

- Docker image build success.
- `Run migrations` success.
- `Deploy stack` success.
- `Configure ClickHouse CDC` success.
- Production health check:

```bash
curl -fsS https://dofek.fit/healthz
```

Record the incident in `docs/production-incident-baseline.md` with symptoms,
impact, evidence, root cause, fix, remaining risk, and follow-up work.
