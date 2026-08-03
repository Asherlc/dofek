import { TupleParam } from "@clickhouse/client";
import { invalidateAllUserQueries } from "dofek/lib/cache";
import { z } from "zod";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import {
  INGEST_DATABASE,
  METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_PROVIDER_GENERATION_PROJECTION,
  METRIC_STREAM_PROVIDER_LIVE_GENERATION_PROJECTION,
  METRIC_STREAM_TABLE,
  PROVIDER_DATA_GENERATION_TABLE,
} from "../metric-stream/clickhouse-table.ts";
import type {
  ProviderDataDeletionContinuationJobData,
  ProviderDataDeletionJobData,
} from "./queues.ts";

const PROVIDER_DATA_DELETION_BATCH_SIZE = 1_000;
const providerDataDeletionWorkBlocked = Symbol("provider-data-deletion-work-blocked");
const metricStreamCursorRowsSchema = z.array(
  z.object({
    generation: z.coerce.number().int().nonnegative(),
    id: z.uuid(),
  }),
);
const metricStreamTombstoneRowsSchema = z.array(
  z.object({
    activity_id: z.uuid().nullable(),
    channel: z.string().min(1),
    device_id: z.string().nullable(),
    external_id: z.string().nullable(),
    generation: z.coerce.number().int().nonnegative(),
    id: z.uuid(),
    ingested_at: z.string().min(1),
    is_deleted: z.literal(1),
    metadata: z.string(),
    point: z.string(),
    provider_id: z.string().min(1),
    recorded_at: z.string().min(1),
    scalar: z.number().nullable(),
    source_type: z.string().nullable(),
    user_id: z.uuid(),
    vector: z.array(z.number()),
    version: z.coerce.number().int().nonnegative(),
  }),
);
const projectionReadinessRowsSchema = z.tuple([
  z.object({
    active_parts: z.coerce.number().int().nonnegative(),
    missing_projection_parts: z.coerce.number().int().nonnegative(),
  }),
]);

export interface ProviderDataDeletionClickHouseClient {
  command(options: { query: string; query_params?: Record<string, unknown> }): Promise<unknown>;
  insert?(options: {
    table: string;
    values: readonly object[];
    format: "JSONEachRow";
    clickhouse_settings?: Record<string, string | number | boolean>;
  }): Promise<unknown>;
  query(options: {
    query: string;
    query_params?: Record<string, unknown>;
    format: "JSONEachRow";
  }): Promise<{ json(): Promise<unknown> }>;
}

export interface ProviderDataDeletionJob {
  data: ProviderDataDeletionJobData;
  updateData(data: ProviderDataDeletionJobData): Promise<void>;
  updateProgress(data: {
    checkpoint?: ProviderDataDeletionJobData["checkpoint"];
    message: string;
    percentage?: number;
  }): Promise<void>;
}

export interface ProviderDataDeletionDependencies {
  accountErasureAllowsWork(workKind: string): Promise<boolean>;
  clickHouseClient: ProviderDataDeletionClickHouseClient;
  enqueueAnalyticsRefresh: (
    userId: string,
    providerId: string,
    deletionEventId: string,
  ) => Promise<void>;
  enqueueContinuation: (data: ProviderDataDeletionContinuationJobData) => Promise<void>;
  markCompleted: (eventId: string) => Promise<void>;
}

async function updateProgress(
  job: ProviderDataDeletionJob,
  percentage: number | undefined,
  message: string,
  checkpoint?: ProviderDataDeletionJobData["checkpoint"],
): Promise<void> {
  await job
    .updateProgress({ ...(percentage === undefined ? {} : { percentage }), message, checkpoint })
    .catch((error: unknown) => {
      captureException(error, { tags: { providerDataDeletionStep: "updateProgress" } });
      logger.warn(`[provider-data-deletion] Failed to update progress: ${String(error)}`);
    });
}

async function advanceClickHouseGenerationFence(
  client: ProviderDataDeletionClickHouseClient,
  data: ProviderDataDeletionJobData,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${PROVIDER_DATA_GENERATION_TABLE} (
        user_id, provider_id, generation, updated_at
      ) VALUES (
        {user_id:UUID}, {provider_id:String}, {generation:UInt64}, now64(9)
      )`,
    query_params: {
      user_id: data.userId,
      provider_id: data.providerId,
      generation: data.generation,
    },
  });
}

async function assertProviderGenerationProjectionReady(
  client: ProviderDataDeletionClickHouseClient,
): Promise<void> {
  const result = await client.query({
    query: `SELECT
        count() AS active_parts,
        countIf(
          NOT has(projections, {covering_projection_name:String})
          OR NOT has(projections, {live_projection_name:String})
        ) AS missing_projection_parts
      FROM system.parts
      WHERE active
        AND database = {database_name:String}
        AND table = {table_name:String}`,
    query_params: {
      database_name: INGEST_DATABASE,
      covering_projection_name: METRIC_STREAM_PROVIDER_GENERATION_PROJECTION,
      live_projection_name: METRIC_STREAM_PROVIDER_LIVE_GENERATION_PROJECTION,
      table_name: "metric_stream",
    },
    format: "JSONEachRow",
  });
  const [readiness] = projectionReadinessRowsSchema.parse(await result.json());
  if (readiness.missing_projection_parts > 0) {
    throw new Error(
      `Provider data deletion requires the ${METRIC_STREAM_PROVIDER_GENERATION_PROJECTION} and ${METRIC_STREAM_PROVIDER_LIVE_GENERATION_PROJECTION} projections on all active ${METRIC_STREAM_TABLE} parts; ${readiness.missing_projection_parts} of ${readiness.active_parts} parts are missing at least one. Materialize the projections using docs/provider-data-deletion-runbook.md before retrying.`,
    );
  }
}

async function loadNextMetricStreamBatch(
  client: ProviderDataDeletionClickHouseClient,
  data: ProviderDataDeletionJobData,
  checkpoint: ProviderDataDeletionJobData["checkpoint"],
): Promise<z.infer<typeof metricStreamCursorRowsSchema>> {
  const queryParams: Record<string, unknown> = {
    batch_size: PROVIDER_DATA_DELETION_BATCH_SIZE,
    generation: data.generation,
    provider_id: data.providerId,
    user_id: data.userId,
  };
  const checkpointCondition = checkpoint
    ? `AND (
          generation > {last_generation:UInt64}
          OR (generation = {last_generation:UInt64} AND id > {last_id:UUID})
        )`
    : "";
  if (checkpoint) {
    queryParams.last_generation = checkpoint.lastGeneration;
    queryParams.last_id = checkpoint.lastId;
  }

  const result = await client.query({
    query: `SELECT generation, id
      FROM ${METRIC_STREAM_TABLE}
      WHERE user_id = {user_id:UUID}
        AND provider_id = {provider_id:String}
        AND is_deleted = 0
        AND generation < {generation:UInt64}
        ${checkpointCondition}
      ORDER BY generation, id
      LIMIT {batch_size:UInt64}
      SETTINGS
        force_optimize_projection = 1,
        force_optimize_projection_name = '${METRIC_STREAM_PROVIDER_LIVE_GENERATION_PROJECTION}',
        preferred_optimize_projection_name = '${METRIC_STREAM_PROVIDER_LIVE_GENERATION_PROJECTION}'`,
    query_params: queryParams,
    format: "JSONEachRow",
  });
  return metricStreamCursorRowsSchema.parse(await result.json());
}

async function tombstoneMetricStreamBatch(
  client: ProviderDataDeletionClickHouseClient,
  data: ProviderDataDeletionJobData,
  batchKeys: z.infer<typeof metricStreamCursorRowsSchema>,
  accountErasureAllowsWork: (workKind: string) => Promise<boolean>,
): Promise<number | typeof providerDataDeletionWorkBlocked> {
  if (!client.insert) {
    throw new Error("Provider data deletion requires an insert-capable ClickHouse client");
  }
  const result = await client.query({
    query: `SELECT
        id,
        activity_id,
        user_id,
        recorded_at,
        channel,
        provider_id,
        external_id,
        device_id,
        source_type,
        scalar,
        vector,
        point,
        metadata,
        now64(9) AS ingested_at,
        toInt8(1) AS is_deleted,
        greatest(source_version + 1, {delete_version:Int64}) AS version,
        generation
      FROM (
        SELECT
          id,
          activity_id,
          user_id,
          recorded_at,
          channel,
          provider_id,
          external_id,
          device_id,
          source_type,
          scalar,
          vector,
          point,
          metadata,
          is_deleted AS source_is_deleted,
          version AS source_version,
          generation
        FROM ${METRIC_STREAM_TABLE}
        WHERE tuple(generation, id) IN {batch_keys:Array(Tuple(UInt64, UUID))}
          AND user_id = {user_id:UUID}
          AND provider_id = {provider_id:String}
          AND generation < {generation:UInt64}
        ORDER BY generation, id, source_version DESC, ingested_at DESC
        LIMIT 1 BY generation, id
      )
      WHERE source_is_deleted = 0
      SETTINGS
        force_optimize_projection = 1,
        force_optimize_projection_name = '${METRIC_STREAM_PROVIDER_GENERATION_PROJECTION}',
        preferred_optimize_projection_name = '${METRIC_STREAM_PROVIDER_GENERATION_PROJECTION}'`,
    query_params: {
      batch_keys: batchKeys.map((batchKey) => new TupleParam([batchKey.generation, batchKey.id])),
      delete_version: Date.now(),
      generation: data.generation,
      provider_id: data.providerId,
      user_id: data.userId,
    },
    format: "JSONEachRow",
  });
  const tombstones = metricStreamTombstoneRowsSchema.parse(await result.json());
  if (tombstones.length === 0) return 0;
  if (!(await accountErasureAllowsWork("provider deletion tombstone insert"))) {
    return providerDataDeletionWorkBlocked;
  }
  await client.insert({
    table: METRIC_STREAM_TABLE,
    values: tombstones,
    format: "JSONEachRow",
    clickhouse_settings: { date_time_input_format: "best_effort" },
  });
  return tombstones.length;
}

async function acknowledgeProviderDataDeletion(
  client: ProviderDataDeletionClickHouseClient,
  eventId: string,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE} (event_id)
      VALUES ({event_id:UUID})`,
    query_params: { event_id: eventId },
  });
}

export async function processProviderDataDeletionJob(
  job: ProviderDataDeletionJob,
  dependencies: ProviderDataDeletionDependencies,
): Promise<void> {
  const { clickHouseClient } = dependencies;
  const checkpoint = job.data.checkpoint;
  if (!checkpoint) {
    if (!(await dependencies.accountErasureAllowsWork("provider deletion generation fence"))) {
      return;
    }
    await updateProgress(job, 0, "Advancing provider generation fence...");
    await advanceClickHouseGenerationFence(clickHouseClient, job.data);
    if (
      !(await dependencies.accountErasureAllowsWork("provider deletion projection verification"))
    ) {
      return;
    }
    await updateProgress(job, 5, "Verifying provider deletion projection...");
    await assertProviderGenerationProjectionReady(clickHouseClient);
  }

  if (!(await dependencies.accountErasureAllowsWork("provider deletion batch read"))) {
    return;
  }
  const rows = await loadNextMetricStreamBatch(clickHouseClient, job.data, checkpoint);
  if (rows.length > 0) {
    if (!(await dependencies.accountErasureAllowsWork("provider deletion tombstone read"))) {
      return;
    }
    const deletedRows = await tombstoneMetricStreamBatch(
      clickHouseClient,
      job.data,
      rows,
      dependencies.accountErasureAllowsWork,
    );
    if (deletedRows === providerDataDeletionWorkBlocked) {
      return;
    }
    if (!(await dependencies.accountErasureAllowsWork("provider deletion continuation enqueue"))) {
      return;
    }
    const lastRow = rows.at(-1);
    if (!lastRow) {
      throw new Error("Provider data deletion batch did not produce a checkpoint cursor");
    }
    const nextCheckpoint = {
      batches: (checkpoint?.batches ?? 0) + 1,
      deletedRows: (checkpoint?.deletedRows ?? 0) + deletedRows,
      examinedRows: (checkpoint?.examinedRows ?? 0) + rows.length,
      lastGeneration: lastRow.generation,
      lastId: lastRow.id,
    };
    const continuationData: ProviderDataDeletionContinuationJobData = {
      ...job.data,
      checkpoint: nextCheckpoint,
    };
    await job.updateData(continuationData);
    await updateProgress(
      job,
      undefined,
      `Checked ${nextCheckpoint.examinedRows} metric stream rows; deleted ${nextCheckpoint.deletedRows}...`,
      nextCheckpoint,
    );
    await dependencies.enqueueContinuation(continuationData);
    return;
  }

  if (!(await dependencies.accountErasureAllowsWork("provider deletion acknowledgement"))) {
    return;
  }
  await updateProgress(job, 90, "Acknowledging provider data deletion...", checkpoint);
  await acknowledgeProviderDataDeletion(clickHouseClient, job.data.eventId);
  if (!(await dependencies.accountErasureAllowsWork("provider deletion analytics enqueue"))) {
    return;
  }
  await dependencies.enqueueAnalyticsRefresh(
    job.data.userId,
    job.data.providerId,
    job.data.eventId,
  );
  if (!(await dependencies.accountErasureAllowsWork("provider deletion cache invalidation"))) {
    return;
  }
  await invalidateAllUserQueries(job.data.userId);
  if (!(await dependencies.accountErasureAllowsWork("provider deletion completion"))) {
    return;
  }
  await dependencies.markCompleted(job.data.eventId);
  await updateProgress(job, 100, "Provider data deletion complete.", checkpoint);
}
