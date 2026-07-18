import * as Sentry from "@sentry/node";
import { z } from "zod";
import { logger } from "../logger.ts";
import {
  METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_TABLE,
  PROVIDER_DATA_GENERATION_TABLE,
} from "../metric-stream/clickhouse-table.ts";
import type { ProviderDataDeletionJobData } from "./queues.ts";

const PROVIDER_DATA_DELETION_BATCH_SIZE = 10_000;
const metricStreamIdRowsSchema = z.array(z.object({ id: z.uuid() }));

export interface ProviderDataDeletionClickHouseClient {
  command(options: { query: string; query_params?: Record<string, unknown> }): Promise<unknown>;
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
    percentage: number;
  }): Promise<void>;
}

export interface ProviderDataDeletionDependencies {
  clickHouseClient: ProviderDataDeletionClickHouseClient;
  enqueueAnalyticsRefresh: (
    userId: string,
    providerId: string,
    deletionEventId: string,
  ) => Promise<void>;
  markCompleted: (eventId: string) => Promise<void>;
}

async function updateProgress(
  job: ProviderDataDeletionJob,
  percentage: number,
  message: string,
  checkpoint?: ProviderDataDeletionJobData["checkpoint"],
): Promise<void> {
  await job.updateProgress({ percentage, message, checkpoint }).catch((error: unknown) => {
    Sentry.captureException(error, { tags: { providerDataDeletionStep: "updateProgress" } });
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

async function loadNextMetricStreamBatch(
  client: ProviderDataDeletionClickHouseClient,
  data: ProviderDataDeletionJobData,
  lastId: string | undefined,
): Promise<string[]> {
  const queryParams: Record<string, unknown> = {
    batch_size: PROVIDER_DATA_DELETION_BATCH_SIZE,
    generation: data.generation,
    provider_id: data.providerId,
    user_id: data.userId,
  };
  const checkpointCondition = lastId ? "AND id > {last_id:UUID}" : "";
  if (lastId) queryParams.last_id = lastId;

  const result = await client.query({
    query: `SELECT id
      FROM ${METRIC_STREAM_TABLE}
      WHERE user_id = {user_id:UUID}
        AND provider_id = {provider_id:String}
        AND generation < {generation:UInt64}
        ${checkpointCondition}
      GROUP BY id
      HAVING argMax(is_deleted, tuple(version, ingested_at)) = 0
      ORDER BY id
      LIMIT {batch_size:UInt64}`,
    query_params: queryParams,
    format: "JSONEachRow",
  });
  return metricStreamIdRowsSchema.parse(await result.json()).map((row) => row.id);
}

async function tombstoneMetricStreamBatch(
  client: ProviderDataDeletionClickHouseClient,
  data: ProviderDataDeletionJobData,
  rowIds: readonly string[],
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${METRIC_STREAM_TABLE} (
        id, activity_id, user_id, recorded_at, channel, provider_id, external_id,
        device_id, source_type, scalar, vector, point, metadata, ingested_at,
        is_deleted, version, generation
      )
      SELECT
        id,
        latest_row.1 AS activity_id,
        latest_row.2 AS user_id,
        latest_row.3 AS recorded_at,
        latest_row.4 AS channel,
        latest_row.5 AS provider_id,
        latest_row.6 AS external_id,
        latest_row.7 AS device_id,
        latest_row.8 AS source_type,
        latest_row.9 AS scalar,
        latest_row.10 AS vector,
        latest_row.11 AS point,
        latest_row.12 AS metadata,
        now64(9) AS ingested_at,
        1 AS is_deleted,
        greatest(latest_row.15 + 1, {delete_version:Int64}) AS version,
        latest_row.13 AS generation
      FROM (
        SELECT
          id,
          argMax(
            tuple(
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
              generation,
              is_deleted,
              version
            ),
            tuple(version, ingested_at)
          ) AS latest_row
        FROM ${METRIC_STREAM_TABLE}
        WHERE id IN {row_ids:Array(UUID)}
          AND user_id = {user_id:UUID}
          AND provider_id = {provider_id:String}
          AND generation < {generation:UInt64}
        GROUP BY id
      )
      WHERE latest_row.14 = 0`,
    query_params: {
      delete_version: Date.now(),
      generation: data.generation,
      provider_id: data.providerId,
      row_ids: rowIds,
      user_id: data.userId,
    },
  });
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
  await updateProgress(job, 0, "Advancing provider generation fence...");
  await advanceClickHouseGenerationFence(clickHouseClient, job.data);

  let checkpoint = job.data.checkpoint;
  while (true) {
    const rowIds = await loadNextMetricStreamBatch(clickHouseClient, job.data, checkpoint?.lastId);
    if (rowIds.length === 0) break;

    await tombstoneMetricStreamBatch(clickHouseClient, job.data, rowIds);
    const lastId = rowIds.at(-1);
    if (!lastId) {
      throw new Error("Provider data deletion batch did not produce a checkpoint id");
    }
    checkpoint = {
      batches: (checkpoint?.batches ?? 0) + 1,
      deletedRows: (checkpoint?.deletedRows ?? 0) + rowIds.length,
      lastId,
    };
    await job.updateData({ ...job.data, checkpoint });
    await updateProgress(
      job,
      50,
      `Tombstoned ${checkpoint.deletedRows} metric stream rows...`,
      checkpoint,
    );
  }

  await updateProgress(job, 90, "Acknowledging provider data deletion...", checkpoint);
  await acknowledgeProviderDataDeletion(clickHouseClient, job.data.eventId);
  await dependencies.enqueueAnalyticsRefresh(
    job.data.userId,
    job.data.providerId,
    job.data.eventId,
  );
  await dependencies.markCompleted(job.data.eventId);
  await updateProgress(job, 100, "Provider data deletion complete.", checkpoint);
}
