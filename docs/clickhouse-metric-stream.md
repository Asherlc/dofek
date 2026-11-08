# ClickHouse Metric Stream Projection

`metric_stream` samples publish to a Kafka-protocol hot log first (**local /
checked-in stack target: Apache Kafka**; **production today: Redpanda** until
approved cutover). [Redpanda Connect](https://docs.redpanda.com/redpanda-connect/)
archives the topic to Cloudflare R2 for long-term replay, and
`metric-stream-clickhouse-sink` writes the analytics copy into
`ingest.metric_stream`. Postgres is no longer the normal forward
ingestion path for metric-stream samples, and PeerDB does not mirror
`fitness.metric_stream`.

```text
Kafka-protocol topic (e.g. metric-stream-*-v1 today in prod)
        |                         |
        | R2 archive              | ClickHouse sink
        v                         v
Cloudflare R2 replay archive
ClickHouse ingest.metric_stream
        |
        | dbt microbatch projection by recorded_at
        v
ClickHouse analytics.sensor_scalar_sample
        |
        | dbt microbatch dedupe by recorded_at
        v
ClickHouse analytics.deduped_sensor
        |
        | normal view
        v
ClickHouse analytics.activity_summary
        |
        | normal view
        v
ClickHouse analytics.activity_trend_daily
        |
        v
Activity stream, zone, summary, and trend reads
```

Location rows are exposed through `analytics.deduped_location`, also as a normal
view. There are no ClickHouse full-refresh read models in this chain.

Activity sensor API queries must read `analytics.deduped_sensor`,
`analytics.activity_summary`, or `analytics.activity_trend_daily`, not the raw
metric stream. Daily Heart Rate's source-comparison endpoint retains every
provider and therefore reads current raw source rows rather than the
provider-priority-deduped activity samples; see its
[repository contract](../packages/server/src/repositories/heart-rate-repository.ts).
Derived rows are never synced back to Postgres.

## Sample Identity — Approved Target Contract

The approved identity rule (2026-11-07) permanently binds a metric-sample ID to
one user, provider, and recorded timestamp. Changing any of those identity
fields creates a new sample ID. Activity association and measurement values
may change while retaining the ID.

The checked-in new-publication path enforces this rule through the existing deterministic
[event constructor](../src/metric-stream/events.ts): callers supply an external
source identifier rather than an internal sample ID. The
[writer boundary](../src/db/metric-stream-writer.ts) exposes the same contract.
The hash namespace and existing channel, external-ID, generation and interval
provenance discriminators are unchanged; the three immutable fields alone are
not a unique sample key. New publication timestamps retain the existing
millisecond normalization. Activity changes retain an ID only when the other
hash inputs remain unchanged; some import paths include activity in their
fallback external identifier.

Historical compatibility is not established. The wire parsers still preserve
stored IDs and timestamp precision; historical imports are not rehashed. The
old [Postgres primary key](../drizzle/0009_metric_stream_id_not_null_primary_key.sql)
was `(id, recorded_at)`, so its constraints do not establish immutable identity
across all retained versions. Broader historical identity and timestamp
coverage remain unestablished; the scoped audit results below do not certify
every retained ID.

The approved 2026-11-07 incident-scope audit checked 43,406 candidate IDs across
130,218 retained physical versions, finding no conflicting immutable tuples
and no sub-millisecond timestamps. That first audit covered retained incident
IDs; the subsequent frozen unread-row audit is recorded below. Neither
certifies archive replay or all historical IDs; see the
[audit result and limits](production-incident-baseline.md#2026-11-07--historical-sample-identity-audit-preflight-incident-unresolved).

The checked-in [deletion implementation](../src/metric-stream/clickhouse-sink.ts)
now resolves versions by the approved immutable identity tuple. Production
still uses the older global latest-ID lookup. Deployment and consumer recovery
remain held pending historical/deletion-scope coverage and production-version
validation; do not rewrite retained IDs or resume a paused consumer from a
clean subset alone. This code-only change authorizes no production migration
or data change; [ClickHouse replacement](https://clickhouse.com/docs/guides/replacing-merge-tree)
uses the complete sorting key, which is not interchangeable with this sample
identity rule.

### Historical compatibility audit before query changes

New-publication enforcement does not certify old imports or unread events.
Both the [historical migration](../src/db/clickhouse-migrations/custom-runs.ts)
and the [catch-up import](../scripts/catch-up-clickhouse-metric-stream.ts)
copy stored IDs; neither establishes a globally immutable identity. Wire
versions also do not identify which constructor produced an ID. Do not infer
compliance from a UUID's shape.

Before proposing a production deletion change:

1. Define the exact coverage: the incident's candidate IDs, all retained
   ClickHouse IDs, unread broker events, and archived replay data are different
   populations. A result for one does not certify the others.
2. Prepare a stock read-only query that counts distinct
   `(user_id, provider_id, recorded_at)` tuples per ID across **all physical
   versions** in the audited population. Do not use `FINAL`, latest-row
   aggregation, or an outer user/provider/time restriction that could hide
   an older conflicting identity. Preserve recorded timestamp precision;
   report sub-millisecond timestamps separately rather than truncating them.
3. Inspect its [EXPLAIN plan](https://clickhouse.com/docs/sql-reference/statements/explain)
   and table/part metadata before requesting a scan budget. A candidate-ID
   filter or output `LIMIT` does not establish a bounded storage read. The
   incident's existing ID lookup selected every outer granule.
4. Run data queries only within an approved read/load budget and return
   aggregate findings rather than sample identifiers. A timed-out, truncated,
   sampled or partially covered audit is incomplete, not a clean result.
   Archive-body reads and broker consumption need their own explicit scope;
   offset and object metadata alone cannot establish row identity.
5. Review conflicts, timestamp precision and remaining replay coverage before
   changing the latest-version lookup. Keep historical wire parsing, retained
   IDs and the current deletion checks unchanged until that decision. Do not
   resume the paused history consumer based solely on a clean subset.

This checklist authorizes no production scan, rehash, acknowledgement repair,
offset change or deployment. Use stock SQL and existing operational workflows;
it does not require a new identity registry or audit framework.

### Remaining deletion-scope coverage preflight — proposed, not executed

The prior identity-only export omitted deletion scopes and its private inputs
were removed. It therefore cannot establish which other retained IDs the
backlog's 248 deletions may affect. The next proposed read is narrower than a
storage audit:

1. Verify that history partition 0 still retains the frozen interval
   `[70578630, 74445631)`. Stop if its start is no longer retained or broker
   metadata differs from the reviewed interval.
2. Read that interval once with stock `rpk`, committed isolation and explicit
   partition/offsets, without a consumer group. Immediately project each
   record to offset/type; retain scope, event version, event ID and operation
   revision only for deletion records. Do not store row payloads or read R2
   archive bodies. Redpanda documents the stock
   [consume command](https://docs.redpanda.com/current/reference/rpk/rpk-topic/rpk-topic-consume/).
3. Bound the read to 15 minutes and 1 GiB compressed private output, with
   complete local verification of 3,867,001 distinct offsets, exact endpoints,
   known types and expected 248 deletions. Any invalid, missing, duplicate,
   truncated or unexpected result is incomplete, never a clean audit. Retain
   identifiers privately only for the authorized coverage investigation;
   publish aggregate counts and remove private inputs when finished.
4. Inspect distinct scope shapes, then obtain `EXPLAIN` for candidate selection
   only. Report what population and read work a subsequent all-version identity
   comparison would require. No candidate data query or full storage scan is
   included in this preflight; propose its separate budget after the plan.

This is a proposed authorization boundary, not permission to execute. It
includes no topic edits, acknowledgements, offset commits, persistent tables,
deployment or history-consumer resume. A clean scoped result would not certify
unrelated IDs, archive replay or future writes. Use existing stock commands
and SQL, without a new repository audit tool or runtime validation service.

### Local identity-local deletion qualification — not deployed

The 2026-11-07 local qualification tested an identity-local lookup against the
unchanged global latest-ID lookup on ClickHouse **26.6.1.1193** and
**26.10.2.103**. The candidate discovers `(id, user_id, provider_id, recorded_at)`
tuples from the union of deletion scopes, resolves the full latest row across
versions of those tuples, then reapplies the original scope and erasure
predicates. Only immutable user/provider/time conjuncts may restrict the
version scan. A scope branch without such a conjunct remains unrestricted;
activity, channel and external-ID predicates stay after latest resolution.
The [frozen single-scope SELECT](evidence/metric-stream-identity-local-20261107/candidate-select.sql)
illustrates the lookup only, not an approved production operation.

This uses stock [tuple `IN`](https://clickhouse.com/docs/reference/statements/in)
and existing [primary indexes](https://clickhouse.com/docs/guides/clickhouse/data-modelling/sparse-primary-indexes).
No projection, storage model, optimizer hint or application-side ID paging
was added. The existing full-row `argMax` and tombstone version expression
were retained; scope persistence and acknowledgement sequencing were not
changed or claimed as qualified by these lookup tests.

Both engines passed **19 real-engine lookup checks**, including mutable-field
moves before/after merges, nullable/overlapping scopes, cross-activity moves,
version/ingestion ordering, tombstones, erasure fences, replay and physical
erasure. Exact ranking-tuple ties permit an arbitrary single winner; the test
does not assert identical winners across different query plans. Immutable
user/provider/timestamp moves are outside the candidate's supported contract;
these dated lookup tests did not change production regressions.

Each engine also completed **64 result-checked measurements** over 1,048,576
rows with all six existing projections, hashed IDs and fixed timestamps.
The matrix covered 1/64/113/8,192 candidate IDs, two parts and one merged part,
and target users owning 12.5% or 75% of the rows, with alternating query order.
For the 113-ID comparison case, total candidate-plus-resolution reads were:

| Engine | Current rows read | Candidate rows read | Candidate/current bytes |
| --- | ---: | ---: | ---: |
| 26.6.1.1193 | 1,056,769–1,064,961 | 32,769–57,345 | 10.0–22.3% |
| 26.10.2.103 | 1,056,769–1,064,961 | 32,769–40,961 | 8.5–17.9% |

The 26.6 plans selected 3–5 of 128 probe granules. On 26.10, merged parts
selected 3–4 of 128; the two-part plans applied staged pruning of 64/128 then
3/64 granules. The
[paired measurements and limitations](evidence/metric-stream-identity-local-20261107/summary.json)
support a local qualification, not a production latency forecast or a bounded
read guarantee for every scope. The fixture assigns activities to contiguous
source-time ranges; scattered-time and unconstrained scopes can behave
differently. The 113-ID case reflects the earlier written-row/granule proxy,
not a scaled replay of the 43,406 IDs discovered by the retained-data audit;
the matrix also tests much larger candidate sets. This local experiment did
not certify unread broker events, archives or other historical IDs. It
changed no production source, queried no
production data, and removed its isolated databases/containers/networks/volumes.

### Checked-in deletion lookup — code only

The sink uses native tuple membership on `(id, user_id, provider_id,
recorded_at)`, then the unchanged full-row `argMax` ranked by
`(version, ingested_at)` and latest-scope predicates. The dated experiment above also included additional
static immutable-field predicates; the implementation omits that redundant
predicate-building logic. It adds no projection, registry or infrastructure.
Scope persistence, revision guards, tombstone versions and acknowledgement
after the successful insert remain unchanged; see the
[implementation and executable regressions](../src/metric-stream/clickhouse-sink.integration.test.ts).
Native [tuple membership](https://clickhouse.com/docs/reference/statements/in)
retains the stored timestamp precision rather than round-tripping through JavaScript.

The actual public deletion path passed all 20 integration tests without retries
on ClickHouse **26.6.1.1193** and **26.10.2.103**, using the committed
tuple-only implementation. Its 65,536-row regression fixture deleted the
4,096 matching identities, retained the other rows and read 20,480 rows on each version (the old query read 77,824).
See the [implementation verification](evidence/metric-stream-identity-local-20261107/implementation-verification.json).
Mutable activity, channel and external-ID moves remain supported; scalar corrections, native
microsecond timestamps, ingestion-time ordering, mixed scopes and chunk
boundaries are covered by real-engine tests. The prior provider-move fixture
now exercises activity movement because retaining an ID across a provider
change is outside the approved contract. Historical wire parsing is unchanged.

This implementation is not deployed. Adequate historical deletion-candidate
coverage remains required before recovery approval. The two-engine million-row
experiment above is evidence for its dated SQL; the executable tests qualify
the final statement on both versions without establishing that every deletion
scope has bounded reads.

### Unread-history row identity audit — frozen snapshot

On 2026-11-08 UTC, the approved read-only audit covered history partition 0
offsets **[70578630, 74445631)**: **3,867,001 distinct offsets**, with no gaps,
duplicates or out-of-range records. The stock
[rpk reader](https://docs.redpanda.com/current/reference/rpk/rpk-topic/rpk-topic-consume/)
used committed reads and direct partition assignment without a consumer group.
Only identity/type/offset fields were retained; measurement values were removed
before transfer. The compressed snapshot was **112,346,109 bytes** and completed
in approximately **98 seconds**, within the 15-minute / 1 GiB export budget.

The snapshot contained **3,866,505 row events**, **248 deletion events** and
**248 processing markers**. There were no malformed/unknown records, invalid
identity fields, timestamps beyond six fractional digits, or sub-millisecond
row timestamps in this population. This checks projected identity/type fields,
not the complete event payload schema or processing outcome.

Local analysis found **3,866,489 distinct IDs**, each bound to one immutable
tuple. Sixteen additional row events shared those tuples; measurement values
were not retained, so this is not a claim of identical payloads. After that
local check, one production comparison used stock
[external query data](https://clickhouse.com/docs/reference/engines/table-engines/special/external-data)
and tuple membership against all retained physical versions of matching IDs,
with no `FINAL`, latest-row aggregation or outer ownership/time restriction.
It found **0 conflicts across 11,807,909 matching retained versions**.

Query-log verification recorded **58,041 ms**, **209,021,415 rows /
4,228,279,393 bytes read** and **919,351,317 bytes tracked peak memory**, with
exception code 0. This stayed within the approved one-thread / 1 GiB memory /
120-second / 210-million-row / 12-GiB-read limits. There was one source export
and one production comparison, with no automatic retries. The
[aggregate evidence](evidence/metric-stream-history-identity-audit-20261107/summary.json)
and [executed comparison SQL](evidence/metric-stream-history-identity-audit-20261107/retained-comparison.sql)
contain no sample identifiers. Private input files and all isolated local test
resources were removed. History remained `0/0` with its checkpoint unchanged;
other consumer groups had zero lag in the post-audit check.

This establishes observed identity consistency for the frozen incoming row IDs
and their matching retained versions. It does **not** establish consistency for
unrelated retained IDs, old archive bodies or later writes. Deletion predicates
were not retained in the projection, so retained IDs affected by those deletions
but absent from the incoming row-ID set are not certified by this audit.
Deletion acknowledgements and processing completeness were not checked. No
deployment, offset edit, acknowledgement repair or consumer resume follows from
this result; the broader historical-coverage and recovery decisions remain held.

## Local Development

Start the backing services:

```bash
pnpm compose -- up -d db clickhouse redis
pnpm migrate
```

To run the CDC path locally (not part of the default compose profile):

```bash
pnpm compose -- -f docker-compose.yml -f docker-compose.peerdb.yml up -d
pnpm clickhouse-cdc
```

Use these local URLs:

- `DATABASE_URL=postgres://health:health@localhost:5435/health`
- `CLICKHOUSE_URL=http://default:health@localhost:8123`

## Query Model

Activity routes resolve authorization, access windows, and canonical activity
membership in Postgres. Stream and heart-rate/power-zone reads query
`analytics.deduped_sensor` by user, channel, and activity time window; the
sensor table does not store `activity_id`. Activity summary, location, provider
stats, sleep/body/daily metrics, and trend reads query normal ClickHouse
`analytics.*` views over the raw mirrors and incremental projection tables. The
app does not issue raw `metric_stream` analytical reads for those endpoints.
Daily and weekly trend reads use `analytics.activity_trend_daily`; weekly rows
are rolled up from daily rows at query time.

Provider record inventory uses the ClickHouse `analytics.provider_stats` read
model for all provider-owned record counts displayed by sync/provider detail:
activity, daily metric, sleep, body measurement, food entry, health event,
metric stream, distinct nutrition day, lab panel, and lab result
counts. Metric-stream counts are maintained by the incremental
`analytics.provider_metric_stream_daily` model at
`(user_id, provider_id, recorded_date)` grain. It reads compact
`analytics.metric_stream_day_change` keys, resolves exact latest state with
`argMax(tuple(recorded_at, ingested_at, version, is_deleted),
tuple(version, ingested_at))`, and emits zero rows for fully tombstoned days.
`provider_stats` sums the daily rows only after every marked day for the
provider has caught up. The selected-day raw scan prefers the covering
`ingest.metric_stream.by_provider_current_state_recorded_at` projection;
projections are optimizer support structures rather than an application source
of truth:
<https://clickhouse.com/docs/data-modeling/projections>. The provider detail UI
still treats these as raw provider-owned record counts, not deduped analytical
sample counts. Historical marker bootstrap and projection materialization are
explicit operator actions; use the
[read-model deploy runbook](clickhouse-read-model-deploy-runbook.md#known-failure-provider_stats-current-state-scan-timeout)
for rollout verification and stop conditions if the daily model remains dirty
or raw provider recounts return.

## Daily Heart Rate Source Access

Release A keeps the existing reader.
[`HeartRateRepository.dailyBySource`](../packages/server/src/repositories/heart-rate-repository.ts)
reads `ingest.metric_stream FINAL` directly for one user's local calendar day,
with user, channel and recorded-time predicates.

The candidate-key reader below is the planned Release B reader. It selects
candidate raw replacement keys for one user's local calendar day using the
`by_user_channel_recorded_at` covering projection, then reads those keys with
native `FINAL`. Candidate predicates use only user, channel and recorded time;
deleted, zero and null revisions remain candidates. Deletion and positive-value
filters follow winner selection. Sources remain separate, and minute averaging
and source summary statistics retain the existing response contract.

Native winner selection is required: the writer can produce different values
with the same replacement key, version and ingestion timestamp. ClickHouse's
[ReplacingMergeTree tie rule](https://clickhouse.com/docs/reference/engines/table-engines/mergetree-family/replacingmergetree#ver)
retains the last inserted row; [argMax ties are nondeterministic](https://clickhouse.com/docs/reference/functions/aggregate-functions/argMax).
The candidate lookup separates assigned and null activity IDs because
[`IN` does not match SQL NULL](https://clickhouse.com/docs/reference/statements/in#null-processing).

Migration `0098_heart_rate_source_access` adds the projection definition only.
It does not populate old parts. Release its schema preparation before releasing
the Release B reader, then perform materialization as an explicit operator
action after capacity review. The current raw table has no partition expression,
so this operation covers its single historical partition; it cannot be bounded
by a date partition without changing the table design. Review free disk, memory,
active mutations and workload before starting. ClickHouse documents
[projection materialization](https://clickhouse.com/docs/reference/statements/alter/projection)
and [table partitioning](https://clickhouse.com/docs/engines/table-engines/mergetree-family/custom-partitioning-key).

```sql
ALTER TABLE ingest.metric_stream
  MATERIALIZE PROJECTION by_user_channel_recorded_at;

SELECT mutation_id, parts_to_do, is_done, latest_fail_reason
FROM system.mutations
WHERE database = 'ingest' AND table = 'metric_stream'
ORDER BY create_time DESC;

SELECT count() AS active_parts,
  countIf(NOT has(projections, 'by_user_channel_recorded_at')) AS missing_projection_parts
FROM system.parts
WHERE database = 'ingest' AND table = 'metric_stream' AND active;
```

Do not release the Release B reader until the materialization mutation has completed
without errors, at least one active part exists, and `missing_projection_parts`
is zero. Verify the candidate query's normal projection selection with `EXPLAIN`
and the complete query's `system.query_log.projections`; separately confirm
native `FINAL` reads candidate-key ranges rather than the whole user history.
The outer plan may omit the candidate subqueries under `CreatingSets`, so inspect
the candidate selection's plan separately. See ClickHouse's
[`EXPLAIN`](https://clickhouse.com/docs/reference/statements/explain),
[`system.query_log`](https://clickhouse.com/docs/operations/system-tables/query_log),
[`system.parts`](https://clickhouse.com/docs/operations/system-tables/parts), and
[`system.mutations`](https://clickhouse.com/docs/operations/system-tables/mutations)
references. Keep optimizer forcing settings out of the serving query.

## Scalar And Location Projections

Scalar sensor samples and location samples use separate ClickHouse projections
because they have different deduplication semantics.

`analytics.deduped_sensor` is optimized for scalar channels such as heart rate,
power, cadence, speed, and altitude. For those channels, the useful atomic unit
is one `(user_id, channel, recorded_at)` key. The incremental pipeline can
recompute a single changed key and select the best live sample with
provider/device priority rules.

GPS location is different. The useful unit is a coherent route for an activity,
not an independently selected point at each timestamp. Providers can report the
same route with different sampling rates, timestamp rounding, pause trimming,
smoothing, altitude correction, and GPS filtering. If location were deduped
point-by-point with the scalar rules, a derived route could silently stitch
Apple, Garmin, Strava, or other provider points together. That stitched route
may not match any route a provider actually recorded, and route-sensitive
metrics such as distance, centroid, and map shape can be inflated, deflated, or
visibly jagged by small provider-to-provider differences.

For that reason, `analytics.deduped_location` remains a separate activity-route
projection. It selects a route source for an activity, currently by valid
location sample count with deterministic provider tie-breaking, and then uses
that source's ordered points for GPS-derived activity summary fields. This is
not mainly a table-shape constraint; the table shape could change. The core
constraint is preserving route coherence while keeping scalar sensor dedupe a
small per-key incremental pipeline.

## Sync Model

ClickHouse migrations run from the normal one-shot `migrate` container when
`CLICKHOUSE_URL` is set. Destructive cleanup, such as dropping obsolete
ClickHouse read models or old custom sync tables, belongs there so API startup
does not repeatedly delete analytical state.

ClickHouse `Nullable(Point)` columns require
`allow_experimental_nullable_tuple_type=1`. The app ClickHouse client sends
that setting with its requests, and Docker deployments also load the checked-in
server profile at
`deploy/clickhouse/users.d/default-query-guardrails.xml`.

ClickHouse migrations create and update the databases and read models:

- `ingest.metric_stream`: a ClickHouse-native `ReplacingMergeTree` copy of the
  raw metric stream populated by `metric-stream-clickhouse-sink`. Historical
  rows may still have been backfilled from Postgres, but new forward rows come
  from metric-stream broker events. Its `version` and `is_deleted` columns encode replacement
  order and logical deletion so current-state queries can select the latest live
  row. Its `by_provider_current_state` aggregate projection computes the same
  latest-row state in advance at provider-record grain for exact inventory counts
  ([ReplacingMergeTree](https://clickhouse.com/docs/en/guides/replacing-merge-tree),
  [projections](https://clickhouse.com/docs/data-modeling/projections)).
- `ingest.metric_stream_delete_acknowledgement`: one receipt per version 2
  deletion event, written only after the sink's tombstone insert completes.
- `ingest.metric_stream_processing_acknowledgement`: one receipt per stable
  processing batch ID, written after the sink applies that batch's events and
  marker. Processing status requires the operation ID and expected event count
  to match the Postgres expectation; the table stores evidence, not metric
  payloads ([acknowledgement table migration](../src/db/clickhouse-migrations/0051_metric_stream_processing_acknowledgement.ts),
  [reconciliation logic](../src/processing/processing-reconciler.ts)).
- `postgres_fitness`: app-managed native ClickHouse raw mirrors with PeerDB CDC
  metadata columns for lower-volume Postgres-backed raw tables, including
  activity, sleep, daily metrics, provider inventory, and sensor priority
  tables. The fitness and provider-inventory mirrors write the shared Postgres
  processing marker into distinct ClickHouse destination tables so each flow's
  causal fence can be proven independently. Metric-stream rows use compatible
  metadata columns but are not a PeerDB mirror
  ([marker table migration](../src/db/clickhouse-migrations/0052_processing_flow_markers.ts),
  [reconciliation logic](../src/processing/processing-reconciler.ts)).
- `analytics.v_activity`, `analytics.v_activity_members`, `analytics.v_sleep`,
  `analytics.v_body_measurement`, and `analytics.v_daily_metrics`: normal
  ClickHouse views over the raw mirrors and body sample projection.
- `analytics.provider_metric_stream_daily` and `analytics.provider_stats`:
  dbt-owned incremental `ReplacingMergeTree` serving tables for bounded
  provider metric counts and their provider-inventory sum.
- `analytics.body_measurement_sample`: a narrow `ReplacingMergeTree`
  projection of body-related `metric_stream` channels. It is backfilled once by
  migration and kept current by `analytics.body_measurement_sample_ingest`, so
  `analytics.v_body_measurement` does not scan the full metric stream mirror.
- `analytics.sensor_scalar_sample`: a narrow dbt `microbatch` incremental
  `ReplacingMergeTree` projection of activity sensor scalar channels. It uses
  `recorded_at` as its dbt event time, writes one current row per raw
  `metric_stream.id`, and maps the raw stream's `version` into its
  `_peerdb_version` projection column inside the bounded batch query.
- `analytics.deduped_sensor`: an activity-agnostic dbt `microbatch`
  incremental `ReplacingMergeTree` table containing the best live scalar sample
  per `(user_id, channel, recorded_at)` according to mirrored sensor
  provider/device priority tables. It uses `recorded_at` as its dbt event time
  and has no `activity_id`; activity reads join samples to activities by time
  window.
- `analytics.deduped_location`: a normal view over
  `ingest.metric_stream` location rows. The metric-stream ClickHouse sink
  converts EWKT point payloads into ClickHouse point-compatible values.
- `analytics.activity_summary`: a normal view over `analytics.deduped_sensor`,
  `analytics.deduped_location`, and `analytics.v_activity`.
- `analytics.activity_trend_daily`: a normal view with one activity-linked
  sensor trend row per user and UTC day. It is derived from
  `analytics.deduped_sensor`.

### Provider inventory projection rollout

Migration `0061_provider_current_state_projection` adds the
`by_provider_current_state` definition. New metric-stream parts populate it
automatically, but existing parts do not receive a newly added projection until
an operator materializes it. ClickHouse documents `MATERIALIZE PROJECTION` as
the required existing-data step:
<https://clickhouse.com/docs/data-modeling/projections#filtering-on-columns-which-arent-in-the-primary-key>.

Materialization rewrites historical parts, so it is an explicit maintenance
operation rather than a deploy migration:

```sql
ALTER TABLE ingest.metric_stream
MATERIALIZE PROJECTION by_provider_current_state;
```

Monitor the mutation until `is_done = 1` and `latest_fail_reason` is empty:

```sql
SELECT
  mutation_id,
  command,
  is_done,
  latest_fail_reason
FROM system.mutations
WHERE database = 'ingest'
  AND table = 'metric_stream'
ORDER BY create_time DESC;
```

Then verify every active base-table part contains the projection:

```sql
SELECT countIf(NOT has(
  projections,
  'by_provider_current_state'
)) AS missing_projection_parts
FROM system.parts
WHERE active
  AND database = 'ingest'
  AND table = 'metric_stream';
```

### Daily provider metric-count rollout

Migration `0068_provider_metric_stream_daily_counts` adds the compact
`analytics.metric_stream_day_change` table and its insert-triggered materialized
view, plus the covering
`by_provider_current_state_recorded_at` projection. The daily dbt model is
ordered before `provider_change_watermark` and `provider_stats`; it processes a
bounded default batch of 32 dirty provider/day keys and leaves provider
publication dirty while a selected day has not caught up. The model's exact
latest-state query remains the source of truth; the projection only narrows
selected-day reads. ClickHouse incremental materialized views consume newly
inserted blocks, and dbt incremental models own the bounded serving transform:
[ClickHouse incremental materialized views](https://clickhouse.com/docs/materialized-view/incremental-materialized-view),
[dbt incremental models](https://docs.getdbt.com/docs/build/incremental-models).

Apply the forward migration through the normal migration container, then
materialize the projection as an explicit maintenance action. Do not combine
the historical scan with deploy-time migration execution:

```sql
ALTER TABLE ingest.metric_stream
MATERIALIZE PROJECTION by_provider_current_state_recorded_at;
```

Stop if the mutation reports a non-empty `latest_fail_reason`. Do not continue
to the active-part check or historical bootstrap until every relevant mutation
row reports `is_done = 1` and an empty `latest_fail_reason`:

```sql
SELECT
  mutation_id,
  command,
  is_done,
  latest_fail_reason
FROM system.mutations
WHERE database = 'ingest'
  AND table = 'metric_stream'
ORDER BY create_time DESC;

SELECT countIf(NOT has(
  projections,
  'by_provider_current_state_recorded_at'
)) AS missing_projection_parts
FROM system.parts
WHERE active
  AND database = 'ingest'
  AND table = 'metric_stream';
```

The active-part result must contain at least one active part and
`missing_projection_parts = 0`. Bootstrap historical dirty days only after
that gate passes. Use one explicit provider/date window per bounded batch, keep
the window checkpoint with the rollout record, and resume at the next window;
do not run an unrestricted `GROUP BY` over the raw table. The query reads the
raw canonical table with the materialized covering projection forced and writes
invalidation keys, not counts:

```sql
INSERT INTO analytics.metric_stream_day_change
  (user_id, provider_id, recorded_date, changed_at)
SELECT
  user_id,
  provider_id,
  toDate(recorded_at) AS recorded_date,
  now64(9, 'UTC') AS changed_at
FROM ingest.metric_stream
WHERE user_id = toUUID('00000000-0000-0000-0000-000000000000')
  AND provider_id = 'REPLACE_WITH_PROVIDER_ID'
  AND recorded_at >= toDateTime64('2020-01-01 00:00:00', 6, 'UTC')
  AND recorded_at < toDateTime64('2020-01-02 00:00:00', 6, 'UTC')
GROUP BY user_id, provider_id, recorded_date
SETTINGS
  force_optimize_projection = 1,
  force_optimize_projection_name = 'by_provider_current_state_recorded_at';
```

Replace the example user, provider, and date window before each batch. Record
the last completed `(user_id, provider_id, recorded_date)` window and resume
with the next deterministic window. `MATERIALIZE PROJECTION` rewrites existing
raw parts; this bootstrap only appends compact marker state, so the two costs
and completion checks remain separate.

After the analytics worker has run, verify that no day marker is newer than its
daily replacement row:

```sql
WITH source_days AS (
  SELECT
    user_id,
    provider_id,
    recorded_date,
    max(changed_at) AS source_changed_at
  FROM analytics.metric_stream_day_change
  GROUP BY user_id, provider_id, recorded_date
), daily_rows AS (
  SELECT
    user_id,
    provider_id,
    recorded_date,
    max(source_changed_at) AS source_changed_at
  FROM analytics.provider_metric_stream_daily FINAL
  GROUP BY user_id, provider_id, recorded_date
)
SELECT
  source_days.user_id,
  source_days.provider_id,
  source_days.recorded_date,
  source_days.source_changed_at,
  daily_rows.source_changed_at AS daily_changed_at
FROM source_days
LEFT JOIN daily_rows
  ON daily_rows.user_id = source_days.user_id
 AND daily_rows.provider_id = source_days.provider_id
 AND daily_rows.recorded_date = source_days.recorded_date
WHERE daily_rows.recorded_date IS NULL
   OR source_days.source_changed_at > daily_rows.source_changed_at
ORDER BY source_days.source_changed_at
LIMIT 50;
```

Stop rollout if this query returns rows, if any projection mutation fails, or
if `provider_stats` resumes reading the raw metric stream instead of summing
`provider_metric_stream_daily`. Confirm a successful `QueryFinish` for the
model in `system.query_log`, a successful analytics processing marker, and
downstream provider-inventory freshness before declaring the rollout complete.

### Deletion protocol

New metric-stream deletions are version 3 broker events with a unique event
ID and operation revision. The ClickHouse sink discovers candidate IDs through
the deletion scope, resolves latest versions within their immutable identity
tuples, rechecks the scope,
and inserts a newer
`is_deleted = 1` version, and then writes the event ID to
`ingest.metric_stream_delete_acknowledgement`. The provider deletion worker
waits for that acknowledgement before rebuilding dbt models and invalidating
the user's analytics cache; it does not scan the full raw table to infer that
the event was applied. Archived version 1 deletion events remain available for replay,
but do not have acknowledgement IDs.

The native-table backfill is resumable within a successful migration attempt,
but migration `0006_backfill_native_metric_stream` intentionally drops the
backfill checkpoint table before rebuilding the raw table. If the migration
container fails before recording the migration, the next retry starts from a
clean raw table instead of trusting stale chunk checkpoints.

Postgres runs with `wal_level=logical`, `max_replication_slots`, and
`max_wal_senders` enabled for PeerDB. The deploy workflow runs
`src/db/setup-clickhouse-cdc.ts` after `docker stack deploy`; that command
loads `src/db/peerdb/metric-stream-cdc.sql`, substitutes deployment
connection values, and applies the declarative PeerDB peer and mirror
definition. Provider inventory tables are mirrored by
`dofek_provider_inventory_raw_analytics` so existing raw analytics mirrors do
not need to be rebuilt when inventory coverage expands. Sensor priority tables
are mirrored by `dofek_sensor_priority_raw_analytics` so priority changes do
not require rebuilding the broader raw analytics mirrors.

**Mirror reconciliation**: The deploy CDC setup checks whether each mirror's
table list matches the expected mapping in `rawAnalyticsMirrorTableMappings`.
If any expected table is missing from an existing mirror's config, the setup
drops and recreates the entire mirror, triggering a full initial snapshot of
all tables in that mirror. This is destructive on a resource-constrained
server — only add tables to a mirror mapping if a ClickHouse read model
actually consumes them.

The mirrors use a
dedicated publication name, exclude `device_id`, `source_type`, `vector`,
`point`, and `metadata` from the metric stream mirrors, and enable soft deletes
so delete events are represented in ClickHouse.
ClickHouse's built-in `MaterializedPostgreSQL` engine is not the CDC path for
`metric_stream`.

API startup only verifies that the migrated ClickHouse tables exist. It must not
create or rewrite analytical schema, because production runs multiple web
replicas and schema ownership belongs to the one-shot migration path.
