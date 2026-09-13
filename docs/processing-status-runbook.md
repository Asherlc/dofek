# Processing Status Architecture and Runbook

Use this document to deploy, monitor, or diagnose the durable processing status
shown in the web and mobile applications.

## What the Status Proves

Each provider sync or file import creates a tenant-scoped operation in Postgres.
Append-only stage events record ingest, canonical commit, CDC, analytics, and
cache-refresh facts. The current state is derived from the latest fact for each
operation, dataset, and emitted output path.

Relational data and metric-stream data are independent:

| Output actually emitted | Canonical evidence | ClickHouse arrival evidence |
| --- | --- | --- |
| Postgres relational rows | A Postgres processing marker written after the provider/import write completes, with the current WAL location | The exact operation/dataset/batch marker exists in the destination table assigned to that flow: `postgres_fitness.processing_flow_marker` for the fitness mirror or `postgres_fitness.processing_flow_marker_provider_inventory` for the provider-inventory mirror |
| Redpanda metric batch | A stable batch ID and expected event count recorded after broker publication | The exact operation/batch receipt with the same count exists in `ingest.metric_stream_processing_acknowledgement` |
| No rows for a path | No output-manifest row | The path is skipped and cannot block readiness |

The relational marker is a causal fence, not a second copy of the provider
payload and not an assertion that metric samples also exist. PostgreSQL LSNs are
monotonically increasing byte positions in WAL and can be used to measure
replication progress ([PostgreSQL WAL internals](https://www.postgresql.org/docs/current/wal-internals.html),
[`pg_lsn`](https://www.postgresql.org/docs/current/datatype-pg-lsn.html)). PeerDB
performs its initial load and then continuously applies WAL changes to
ClickHouse ([PeerDB Postgres-to-ClickHouse CDC](https://docs.peerdb.io/mirror/cdc-pg-clickhouse)).
The exact marker in the destination, rather than an unrelated maximum domain
timestamp, proves that the relevant replication flow crossed the fence.

Metric rows remain on the direct Redpanda-to-ClickHouse path. The producer puts
each batch-completed marker in the same topic partition as the batch. Kafka
guarantees write/read order within a topic partition, not across partitions
([Apache Kafka introduction](https://kafka.apache.org/documentation/)). The sink
writes the ClickHouse receipt only after applying the preceding metric events.
The Postgres `processing_queue_outbox` contains reconciliation work identifiers
only; it never contains metric payloads.

## Runtime Progression

1. The provider/import worker records ingest lifecycle events and an output
   manifest containing only paths that emitted rows.
2. The worker records relational fences and/or published metric batches, then
   queues reconciliation work in Postgres.
3. The production `processing-reconciliation` service runs the reconciliation
   script synchronously, then waits 300 seconds before the next run. It compares
   each pending operation with exact ClickHouse evidence and queues analytics
   only after every emitted path for a dataset is present.
4. Independently, the `cdc-health` service runs
   `scripts/check-clickhouse-cdc.ts` every five minutes and records only the
   bounded CDC result for its health probe.
5. The analytics worker runs every production dbt model sequentially and records
   the status of every selected model. dbt writes execution status only for
   executed nodes to `run_results.json`; those identifiers are resolved through
   the full project `manifest.json` ([dbt run results](https://docs.getdbt.com/reference/artifacts/run-results-json),
   [dbt manifest](https://docs.getdbt.com/reference/artifacts/manifest-json)).
6. The cache warmer records each registered query-family outcome. A dataset is
   ready only after its required analytics and cache work succeeds or is
   explicitly skipped.

All event writes are idempotent. Re-running the reconciler, analytics build, or
cache warmer may reuse the same facts without duplicating lifecycle state.

## Deployment Order

Use the normal production deployment workflow; do not deploy these pieces
manually out of order.

1. Deploy the dependency stack while `analytics-worker`,
   `metric-stream-clickhouse-sink`, and `processing-reconciliation` remain
   quiesced, then wait for Postgres, ClickHouse, and the PeerDB Flow API.
2. Run `peerdb-cdc-contract prepare`. This applies only registered additive
   `pre-cdc` ClickHouse migrations, reconciles every live mapping to the typed
   contract, reads the mapping back, and validates the resulting PostgreSQL to
   ClickHouse projection. An existing mirror is edited in place; it and its
   logical replication slot are not replaced.
3. Run the normal database migrations and deploy the requested immutable image
   with the same consumers still quiesced. Run the checked-in CDC setup for any
   mirror that does not exist yet.
4. Run `peerdb-cdc-contract finalize`. It validates the post-migration schema
   again and writes one unique processing marker for each marker-bearing mirror.
   The owner-only deploy artifact records the exact operation, dataset, flow,
   batch, and source watermark expected at the destination.
5. Run `peerdb-cdc-contract verify`. It succeeds only when every exact marker
   is visible in the ClickHouse destination assigned to that mirror. A stale
   row, an unrelated maximum timestamp, or another flow's marker cannot satisfy
   the gate.
6. Restore the full stack, including ClickHouse consumers, only after prepare,
   migrations, finalize, and verify all succeed. The temporary marker artifact
   is removed on success or failure.

PeerDB requires a mirror to be paused before editing and automatically resumes
it after a table-mapping update. The reconciler therefore uses two separately
verified transitions for a changed table: remove the stale mapping, read back
its absence, then add the canonical mapping and read back exact equality. A
failure leaves the mirror paused for diagnosis instead of resuming an
unverified projection. See PeerDB's official documentation for
[creating mirrors](https://docs.peerdb.io/sql/commands/create-mirror),
[editing mirrors](https://docs.peerdb.io/features/edit-mirror), the
[state-change API](https://docs.peerdb.io/peerdb-api/endpoints/change-mirror-state),
[schema changes](https://docs.peerdb.io/features/schema-changes), and the
[resync procedure](https://docs.peerdb.io/features/resync-mirror).

The canonical mappings, exclusions, marker destinations, initial-copy policy,
and managed mirror names live in `src/db/peerdb/mirror-contracts.ts`. Do not
maintain a second mapping list in deployment code or documentation. A contract
or schema failure is fatal. Inspect the reported mirror/table/column difference
and paused mirror state; do not recreate a healthy mirror as a shortcut.

The schema is additive and remains compatible with the old app during the
rolling update. Image rollback does not remove the new database tables.

## Diagnosis

Start with the operation and its latest facts:

```sql
SELECT id, user_id, provider_id, kind, dataset_keys, created_at
FROM fitness.processing_operation
WHERE id = '<operation-uuid>'::uuid;

SELECT sequence, stage, status, dataset_key, output_path, model_name,
       occurred_at, source_watermark, serving_watermark,
       error_code, error_message
FROM fitness.processing_stage_event
WHERE operation_id = '<operation-uuid>'::uuid
ORDER BY sequence;

SELECT dataset_key, output_path
FROM fitness.processing_operation_output
WHERE operation_id = '<operation-uuid>'::uuid
ORDER BY dataset_key, output_path;
```

If relational CDC is waiting, compare source and destination markers:

```sql
SELECT dataset_key, flow_name, batch_key, source_watermark, created_at
FROM fitness.processing_flow_marker
WHERE operation_id = '<operation-uuid>'::uuid;
```

```sql
SELECT 'dofek_fitness_raw_analytics' AS observed_in_flow,
       dataset_key, flow_name, batch_key, source_watermark, _peerdb_synced_at
FROM postgres_fitness.processing_flow_marker FINAL
WHERE operation_id = toUUID('<operation-uuid>')
  AND flow_name = 'dofek_fitness_raw_analytics'
  AND _peerdb_is_deleted = 0
UNION ALL
SELECT 'dofek_provider_inventory_raw_analytics' AS observed_in_flow,
       dataset_key, flow_name, batch_key, source_watermark, _peerdb_synced_at
FROM postgres_fitness.processing_flow_marker_provider_inventory FINAL
WHERE operation_id = toUUID('<operation-uuid>')
  AND flow_name = 'dofek_provider_inventory_raw_analytics'
  AND _peerdb_is_deleted = 0;
```

Each destination is checked only for the flow it represents. Both mirrors copy
the shared source marker table, so a row's `flow_name` without its destination
table is not sufficient proof that a particular mirror crossed the fence.

If the Postgres marker exists but ClickHouse does not, follow
[clickhouse-cdc-health-runbook.md](clickhouse-cdc-health-runbook.md). A healthy
replication slot is supporting evidence, not completion proof for this
operation.

If metric CDC is waiting, compare expectations and receipts:

```sql
SELECT batch_id, dataset_keys, expected_event_count, published_at
FROM fitness.processing_metric_stream_batch
WHERE operation_id = '<operation-uuid>'::uuid;
```

```sql
SELECT batch_id, dataset_keys, expected_event_count,
       topic, topic_partition, marker_offset, applied_at
FROM ingest.metric_stream_processing_acknowledgement FINAL
WHERE operation_id = toUUID('<operation-uuid>');
```

A missing receipt means the sink has not durably applied that batch marker. A
count mismatch is treated as incomplete. Follow
[metric-stream-redpanda-r2-runbook.md](metric-stream-redpanda-r2-runbook.md)
before replaying or changing offsets.

Pending reconciliation work is visible here:

```sql
SELECT operation_id, job_id, status, created_at, dispatched_at
FROM fitness.processing_queue_outbox
WHERE queue_name = 'processing-reconcile'
  AND status <> 'completed'
ORDER BY created_at;
```

For analytics or cache failures, query the corresponding stage events and then
inspect `analytics-worker` logs. Persisted user messages are sanitized; raw
exceptions remain in Sentry/logs rather than the ledger.

## Monitoring and Retention

The `processing-reconciliation` service logs a summary after each synchronous
run, then waits 300 seconds before the next run. Its script initializes Sentry
and reports reconciliation failures there; the entrypoint logs the nonzero exit
before the next scheduled retry. Alert on repeated `processing reconciliation`
failures, outbox rows that persist across two completed reconciliation
summaries, analytics/cache `failed` events, and operations whose latest
nonterminal event exceeds the dataset's freshness target. Monitor `cdc-health`
independently for a stale or failing bounded CDC result.

The ledger is append-only and is not physically purged in the first release.
`processing.status` considers operations created in the last 90 days;
`processing.history` remains tenant-scoped and cursor-paginates the full
history. Introduce a separately reviewed retention job before deleting any
events—do not mutate or compact stage facts in place.

Operational metadata must never contain provider payloads, metric samples,
credentials, raw exception objects, or identifying filenames. Ordinary user
APIs omit dbt model names and other infrastructure details.
