# Provider Data Deletion Runbook

Provider deletion is an asynchronous, generation-fenced workflow. It does not publish one broker event per stored metric. The API records one durable deletion request, and a BullMQ worker writes bounded batches of exact-ID tombstones directly to ClickHouse.

## Industry Terms

| Term | Meaning in Dofek |
|------|------------------|
| Transactional outbox | The provider record deletion, generation increment, and deletion request are committed in one PostgreSQL transaction. PostgreSQL transactions make those steps an all-or-nothing operation: <https://www.postgresql.org/docs/current/tutorial-transactions.html>. |
| Generation / fencing token | A monotonically increasing number for one `(user_id, provider_id)`. Events from an older generation are stale and cannot become active after deletion. |
| Idempotency key | The outbox `event_id`, also used as the BullMQ `jobId`. BullMQ custom job IDs prevent a second job with the same ID while the retained job exists: <https://docs.bullmq.io/guide/jobs/job-ids>. |
| Checkpoint | BullMQ job data containing the last processed metric-stream ID and cumulative batch/row counts. A retry resumes after the last durable checkpoint. |
| Tombstone | A new version of an existing metric-stream row with `is_deleted = 1`. Raw history remains available while current-state queries treat the ID as deleted. |
| Projection | ClickHouse's hidden, query-optimized ordering of the same table data. `by_provider_generation` orders IDs by user, provider, and generation so deletion scans do not require a full table scan. ClickHouse maintains projections for new inserts automatically: <https://clickhouse.com/docs/data-modeling/projections>. |
| Acknowledgement | A durable ClickHouse row proving the metric-stream deletion batches finished before downstream analytics refresh begins. |

## Control Flow

1. The API starts a PostgreSQL transaction.
2. It deletes the provider's relational records but preserves the provider connection token.
3. It increments `fitness.provider_data_generation.current_generation` and inserts one row into `fitness.provider_data_deletion_outbox` in the same transaction.
4. The outbox dispatcher adds a `provider-data-deletion` BullMQ job using `event_id` as the idempotency key, then marks the outbox row `dispatched`.
5. The worker advances the ClickHouse generation fence in `ingest.provider_data_generation`.
6. The worker scans active rows from older generations in batches of 10,000 IDs, writes exact-ID tombstones, and persists a checkpoint after every batch.
7. When no older active rows remain, the worker writes `ingest.metric_stream_delete_acknowledgement`, enqueues the provider analytics refresh, and marks the outbox row `completed`.

Metric-stream writers stamp every new event with the provider's current generation. After inserting a batch, the ClickHouse sink checks the generation fence and immediately tombstones exact IDs from older generations. The post-insert check closes the race between an in-flight sink batch and a newly advanced fence: either the deletion worker sees the row in its scan, or the sink sees the fence after insertion. The jobs are intentionally idempotent because BullMQ can deliver a job again after a worker failure; BullMQ documents this retry-safe design as idempotent jobs: <https://docs.bullmq.io/patterns/idempotent-jobs>.

## Deployment And Historical Projection

The ClickHouse migration adds `generation`, the generation-fence table, and the `by_provider_generation` projection definition. New parts populate the projection automatically. Existing parts remain correct but do not receive the reordered projection until an operator explicitly materializes it. ClickHouse requires `MATERIALIZE PROJECTION` for existing data: <https://clickhouse.com/docs/data-modeling/projections#filtering-on-columns-which-arent-in-the-primary-key>.

Materialization rewrites historical data, so do not put it in the deploy migration. Run it only in an approved maintenance window:

```sql
ALTER TABLE ingest.metric_stream
MATERIALIZE PROJECTION by_provider_generation;
```

Monitor progress and failures:

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

Verify that active projection parts exist:

```sql
SELECT
  name,
  sum(rows) AS rows,
  formatReadableSize(sum(bytes_on_disk)) AS bytes_on_disk
FROM system.projection_parts
WHERE active
  AND database = 'ingest'
  AND table = 'metric_stream'
  AND name = 'by_provider_generation'
GROUP BY name;
```

## Verify A Deletion

Find the durable request and its generation in PostgreSQL:

```sql
SELECT
  event_id,
  user_id,
  provider_id,
  generation,
  status,
  created_at,
  dispatched_at,
  completed_at
FROM fitness.provider_data_deletion_outbox
WHERE user_id = '<user UUID>'::uuid
  AND provider_id = '<provider ID>'
ORDER BY created_at DESC;
```

For a completed request, confirm the ClickHouse fence and acknowledgement:

```sql
SELECT max(generation) AS active_generation
FROM ingest.provider_data_generation FINAL
WHERE user_id = toUUID('<user UUID>')
  AND provider_id = '<provider ID>';

SELECT event_id, max(applied_at) AS applied_at
FROM ingest.metric_stream_delete_acknowledgement FINAL
WHERE event_id = toUUID('<event UUID>')
GROUP BY event_id;
```

Confirm no active rows remain from older generations:

```sql
SELECT count() AS active_old_generation_rows
FROM
(
  SELECT id
  FROM ingest.metric_stream
  WHERE user_id = toUUID('<user UUID>')
    AND provider_id = '<provider ID>'
    AND generation < 3 -- Replace 3 with the active generation.
  GROUP BY id
  HAVING argMax(is_deleted, tuple(version, ingested_at)) = 0
);
```

The count must be zero before treating the metric-stream deletion as complete. Analytics can lag behind that acknowledgement while its refresh job runs.

## Deployment Transition

Deletion requests submitted before this outbox migration are not retroactively inserted into `fitness.provider_data_deletion_outbox`. After deploying this workflow, submit those deletion requests again so they receive a generation and durable outbox event.
