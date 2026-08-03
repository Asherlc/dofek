# Provider Data Deletion Runbook

Provider deletion is an asynchronous, generation-fenced workflow. It does not publish one broker event per stored metric. The API records one durable deletion request, and a BullMQ worker writes bounded batches of exact-ID tombstones directly to ClickHouse.

Disconnect and data deletion are separate operations. Disconnect removes the
provider connection, OAuth token, and webhook secret, stops future syncs, and
retains imported records. **Delete All Data** removes the provider's imported
records through the workflow below without changing whether the provider is
connected. The canonical implementations are
[`deleteProviderAuthorization`](../src/db/tokens.ts) and
[`requestProviderDataDeletion`](../packages/server/src/repositories/provider-detail-repository.ts).

## Industry Terms

| Term | Meaning in Dofek |
|------|------------------|
| Transactional outbox | The provider record deletion, generation increment, and deletion request are committed in one PostgreSQL transaction. PostgreSQL transactions make those steps an all-or-nothing operation: <https://www.postgresql.org/docs/current/tutorial-transactions.html>. |
| Generation / fencing token | A monotonically increasing number for one `(user_id, provider_id)`. Events from an older generation are stale and cannot become active after deletion. |
| Idempotency key | The outbox `event_id`, also used as the BullMQ `jobId`. BullMQ custom job IDs prevent a second job with the same ID while the retained job exists: <https://docs.bullmq.io/guide/jobs/job-ids>. |
| Checkpoint | BullMQ job data containing the last processed generation and metric-stream ID plus cumulative batch, examined-row, and deleted-row counts. A retry resumes after the last durable checkpoint. |
| Tombstone | A new version of an existing metric-stream row with `is_deleted = 1`. Raw history remains available while current-state queries treat the ID as deleted. |
| Covering projection | ClickHouse's hidden, query-optimized ordering of the same table data. `by_provider_generation` contains every column required to create a tombstone and orders rows by user, provider, generation, ID, and version so neither deletion phase falls back to the base table. ClickHouse maintains projections for new inserts automatically: <https://clickhouse.com/docs/data-modeling/projections>. |
| Live-candidate projection | The narrow `by_provider_live_generation` projection orders rows by user, provider, deletion state, generation, and ID. Candidate pagination can therefore filter physical live rows and read them in cursor order without sorting the provider's full history. ClickHouse can avoid sorting when a query's ordering matches a table or projection ordering: <https://clickhouse.com/blog/clickhouse-top-n-queries-granule-level-data-skipping>. |
| Acknowledgement | A durable ClickHouse row proving the metric-stream deletion batches finished before downstream analytics refresh begins. |

## Control Flow

1. The API starts a PostgreSQL transaction.
2. It deletes the provider's relational records but preserves the provider connection token.
3. It increments `fitness.provider_data_generation.current_generation` and inserts one row into `fitness.provider_data_deletion_outbox` in the same transaction.
4. The outbox dispatcher adds a `provider-data-deletion` BullMQ job using `event_id` as the idempotency key, then marks the outbox row `dispatched`.
5. The worker advances the ClickHouse generation fence in `ingest.provider_data_generation`.
6. The worker verifies that every active base-table part has both deletion projections. It fails before scanning if historical parts have not been materialized.
7. The worker uses `by_provider_live_generation` to paginate physical live candidates over `(generation, id)` in batches of 1,000 without a provider-wide sort. It then uses `by_provider_generation` to select each candidate key's latest version, excludes candidates already superseded by tombstones, inserts exact-ID tombstones, and persists a checkpoint after every batch. The second latest-version check is required because unmerged parts can still contain an older physical live version beside a newer tombstone. The progress message reports both examined and deleted rows so polling clients visibly advance in that case. The 1,000-row transport bound keeps ClickHouse HTTP parameters below the server field-size limit. ClickHouse applies `LIMIT BY` after query ordering, which lets the second phase select the newest version for each key: <https://clickhouse.com/docs/sql-reference/statements/select/limit-by>.
8. When no older rows remain, the worker writes `ingest.metric_stream_delete_acknowledgement`, enqueues the provider analytics refresh, and marks the outbox row `completed`.

Metric-stream writers stamp every new event with the provider's current generation. After inserting a batch, the ClickHouse sink checks the generation fence and immediately tombstones exact IDs from older generations. The post-insert check closes the race between an in-flight sink batch and a newly advanced fence: either the deletion worker sees the row in its scan, or the sink sees the fence after insertion. The jobs are intentionally idempotent because BullMQ can deliver a job again after a worker failure; BullMQ documents this retry-safe design as idempotent jobs: <https://docs.bullmq.io/patterns/idempotent-jobs>.

## Deployment And Historical Projection

Production and CI must run ClickHouse 26.6.1.1193 or newer within the 26.6 stable line. ClickHouse 26.3 selects `by_provider_live_generation` but does not stop this ordered projection read at the 1,000-row batch limit, so it scans the provider's complete qualifying range. Version 26.6.1.1193 is an official ClickHouse stable release: <https://github.com/ClickHouse/ClickHouse/releases/tag/v26.6.1.1193-stable>.

The ClickHouse migrations add `generation`, the generation-fence table, and both deletion projection definitions. Migration `0047_cover_provider_generation_projection` provides the full latest-row lookup, while `0048_provider_live_generation_projection` adds the narrow deletion-state-first ordering used for bounded candidate pagination. New parts populate both projections automatically. Existing parts remain correct but do not receive a newly added or reordered projection until an operator explicitly materializes it. ClickHouse requires `MATERIALIZE PROJECTION` for existing data: <https://clickhouse.com/docs/data-modeling/projections#filtering-on-columns-which-arent-in-the-primary-key>.

Materialization rewrites historical data, so do not put it in the deploy migration. Run it only in an approved maintenance window:

```sql
ALTER TABLE ingest.metric_stream
MATERIALIZE PROJECTION by_provider_generation;

ALTER TABLE ingest.metric_stream
MATERIALIZE PROJECTION by_provider_live_generation;
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
  AND name IN ('by_provider_generation', 'by_provider_live_generation')
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

The Redpanda sink checks this acknowledgement before replaying a version-2 delete event. During incident recovery, insert a missing acknowledgement manually only after query evidence proves that the event's tombstones committed; the receipt causes redelivery to skip the already-applied delete and lets the consumer advance.

## Deployment Transition

Deletion requests submitted before this outbox migration are not retroactively inserted into `fitness.provider_data_deletion_outbox`. After deploying this workflow, submit those deletion requests again so they receive a generation and durable outbox event.
