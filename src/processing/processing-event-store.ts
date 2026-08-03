import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/index.ts";
import { executeWithSchema, type SchemaExecutionDatabase } from "../db/typed-sql.ts";
import {
  DATASET_CONTRACTS,
  PROCESSING_DATASET_KEYS,
  PROCESSING_OUTPUT_PATHS,
  type ProcessingDatasetKey,
  type ProcessingOutputPath,
} from "./dataset-contracts.ts";
import { PROCESSING_EVENT_STATUSES, PROCESSING_STAGES } from "./processing-state.ts";

export const PROCESSING_OPERATION_KINDS = [
  "provider_sync",
  "file_import",
  "push_ingest",
  "data_deletion",
  "analytics_build",
  "cache_refresh",
] as const;

const operationKindSchema = z.enum(PROCESSING_OPERATION_KINDS);
const stageSchema = z.enum(PROCESSING_STAGES);
const eventStatusSchema = z.enum(PROCESSING_EVENT_STATUSES);
const datasetKeySchema = z.enum(PROCESSING_DATASET_KEYS);
const outputPathSchema = z.enum(PROCESSING_OUTPUT_PATHS);
const metadataValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const operationRowSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid().nullable(),
  provider_id: z.string().min(1).nullable(),
  kind: operationKindSchema,
  external_correlation_key: z.string().min(1).nullable(),
  dataset_keys: z.array(datasetKeySchema).min(1),
  created_at: z.coerce.date(),
});

const eventRowSchema = z.object({
  id: z.uuid(),
  sequence: z.coerce.number().int().positive(),
  operation_id: z.uuid(),
  stage: stageSchema,
  status: eventStatusSchema,
  dataset_key: datasetKeySchema.nullable(),
  output_path: outputPathSchema.nullable(),
  model_name: z.string().min(1).nullable(),
  occurred_at: z.coerce.date(),
  progress_percentage: z.coerce.number().int().min(0).max(100).nullable(),
  source_watermark: z.string().min(1).nullable(),
  serving_watermark: z.string().min(1).nullable(),
  message: z.string().min(1).max(500).nullable(),
  error_code: z.string().min(1).max(100).nullable(),
  error_message: z.string().min(1).max(500).nullable(),
  metadata_schema_version: z.coerce.number().int().positive(),
  metadata: z.record(z.string(), metadataValueSchema).nullable(),
  idempotency_key: z.string().min(1),
});

const createOperationInputSchema = z.object({
  userId: z.uuid().nullable(),
  providerId: z.string().min(1).nullable().optional(),
  kind: operationKindSchema,
  externalCorrelationKey: z.string().min(1).nullable().optional(),
  datasetKeys: z.array(datasetKeySchema).min(1),
});

const appendEventInputSchema = z.object({
  operationId: z.uuid(),
  stage: stageSchema,
  status: eventStatusSchema,
  datasetKey: datasetKeySchema.nullable().optional(),
  outputPath: outputPathSchema.nullable().optional(),
  modelName: z.string().min(1).max(200).nullable().optional(),
  occurredAt: z.date().optional(),
  progressPercentage: z.number().int().min(0).max(100).nullable().optional(),
  sourceWatermark: z.string().min(1).max(500).nullable().optional(),
  servingWatermark: z.string().min(1).max(500).nullable().optional(),
  message: z.string().min(1).max(500).nullable().optional(),
  errorCode: z.string().min(1).max(100).nullable().optional(),
  errorMessage: z.string().min(1).max(500).nullable().optional(),
  metadataSchemaVersion: z.number().int().positive().optional(),
  metadata: z.record(z.string(), metadataValueSchema).nullable().optional(),
  idempotencyKey: z.string().min(1).max(500),
});

const operationOutputRowSchema = z.object({
  dataset_key: datasetKeySchema,
  output_path: outputPathSchema,
});

const scopedOperationRowSchema = operationRowSchema.extend({
  events: z.array(eventRowSchema),
  output_manifest: z.array(operationOutputRowSchema),
});

const operationDatasetRowSchema = z.object({
  operation_id: z.uuid(),
  dataset_key: datasetKeySchema,
});
const cacheRefreshTargetRowSchema = operationDatasetRowSchema.extend({
  user_id: z.uuid(),
});

const recordProcessingOutputInputSchema = z.object({
  operationId: z.uuid(),
  datasetKey: datasetKeySchema,
  outputPath: outputPathSchema,
});

const recordMetricStreamBatchInputSchema = z.object({
  operationId: z.uuid(),
  batchId: z.string().min(1).max(500),
  datasetKeys: z.array(datasetKeySchema).min(1),
  expectedEventCount: z.number().int().positive(),
});

export interface ProcessingOperation {
  id: string;
  userId: string | null;
  providerId: string | null;
  kind: z.infer<typeof operationKindSchema>;
  externalCorrelationKey: string | null;
  datasetKeys: ProcessingDatasetKey[];
  createdAt: Date;
}

export interface StoredProcessingStageEvent {
  id: string;
  sequence: number;
  operationId: string;
  stage: z.infer<typeof stageSchema>;
  status: z.infer<typeof eventStatusSchema>;
  datasetKey: ProcessingDatasetKey | null;
  outputPath: ProcessingOutputPath | null;
  modelName: string | null;
  occurredAt: Date;
  progressPercentage: number | null;
  sourceWatermark: string | null;
  servingWatermark: string | null;
  message: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  metadataSchemaVersion: number;
  metadata: Record<string, string | number | boolean | null> | null;
  idempotencyKey: string;
}

function mapOperation(row: z.infer<typeof operationRowSchema>): ProcessingOperation {
  return {
    id: row.id,
    userId: row.user_id,
    providerId: row.provider_id,
    kind: row.kind,
    externalCorrelationKey: row.external_correlation_key,
    datasetKeys: row.dataset_keys,
    createdAt: row.created_at,
  };
}

function mapEvent(row: z.infer<typeof eventRowSchema>): StoredProcessingStageEvent {
  return {
    id: row.id,
    sequence: row.sequence,
    operationId: row.operation_id,
    stage: row.stage,
    status: row.status,
    datasetKey: row.dataset_key,
    outputPath: row.output_path,
    modelName: row.model_name,
    occurredAt: row.occurred_at,
    progressPercentage: row.progress_percentage,
    sourceWatermark: row.source_watermark,
    servingWatermark: row.serving_watermark,
    message: row.message,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    metadataSchemaVersion: row.metadata_schema_version,
    metadata: row.metadata,
    idempotencyKey: row.idempotency_key,
  };
}

const operationColumns = sql`id, user_id, provider_id, kind, external_correlation_key,
  dataset_keys, created_at`;
const eventColumns = sql`id, sequence, operation_id, stage, status, dataset_key, output_path, model_name,
  occurred_at, progress_percentage, source_watermark, serving_watermark, message,
  error_code, error_message, metadata_schema_version, metadata, idempotency_key`;

export async function createProcessingOperation(
  database: SchemaExecutionDatabase,
  input: z.input<typeof createOperationInputSchema>,
): Promise<ProcessingOperation> {
  const parsed = createOperationInputSchema.parse(input);
  const datasetKeys = sql.join(
    parsed.datasetKeys.map((datasetKey) => sql`${datasetKey}`),
    sql`, `,
  );
  const inserted = await executeWithSchema(
    database,
    operationRowSchema,
    sql`INSERT INTO fitness.processing_operation
          (user_id, provider_id, kind, external_correlation_key, dataset_keys)
        VALUES (
          ${parsed.userId}::uuid,
          ${parsed.providerId ?? null},
          ${parsed.kind},
          ${parsed.externalCorrelationKey ?? null},
          ARRAY[${datasetKeys}]::text[]
        )
        ON CONFLICT DO NOTHING
        RETURNING ${operationColumns}`,
  );
  if (inserted[0]) return mapOperation(inserted[0]);
  if (!parsed.externalCorrelationKey) {
    throw new Error("Processing operation insert failed without an external correlation key");
  }

  const existing = await executeWithSchema(
    database,
    operationRowSchema,
    sql`SELECT ${operationColumns}
        FROM fitness.processing_operation
        WHERE user_id IS NOT DISTINCT FROM ${parsed.userId}::uuid
          AND kind = ${parsed.kind}
          AND external_correlation_key = ${parsed.externalCorrelationKey}`,
  );
  if (!existing[0]) throw new Error("Processing operation conflict could not be resolved");
  return mapOperation(existing[0]);
}

async function appendEvent(
  database: SchemaExecutionDatabase,
  input: z.input<typeof appendEventInputSchema>,
): Promise<StoredProcessingStageEvent> {
  const parsed = appendEventInputSchema.parse(input);
  const serializedMetadata = parsed.metadata ? JSON.stringify(parsed.metadata) : null;
  const inserted = await executeWithSchema(
    database,
    eventRowSchema,
    sql`INSERT INTO fitness.processing_stage_event (
          operation_id, stage, status, dataset_key, output_path, model_name, occurred_at,
          progress_percentage, source_watermark, serving_watermark, message,
          error_code, error_message, metadata_schema_version, metadata, idempotency_key
        ) VALUES (
          ${parsed.operationId}::uuid, ${parsed.stage}, ${parsed.status},
          ${parsed.datasetKey ?? null}, ${parsed.outputPath ?? null}, ${parsed.modelName ?? null},
          ${parsed.occurredAt ?? new Date()}, ${parsed.progressPercentage ?? null},
          ${parsed.sourceWatermark ?? null}, ${parsed.servingWatermark ?? null},
          ${parsed.message ?? null}, ${parsed.errorCode ?? null}, ${parsed.errorMessage ?? null},
          ${parsed.metadataSchemaVersion ?? 1}, ${serializedMetadata}::jsonb,
          ${parsed.idempotencyKey}
        )
        ON CONFLICT ON CONSTRAINT processing_stage_event_idempotency_key DO NOTHING
        RETURNING ${eventColumns}`,
  );
  if (inserted[0]) return mapEvent(inserted[0]);

  const existing = await executeWithSchema(
    database,
    eventRowSchema,
    sql`SELECT ${eventColumns}
        FROM fitness.processing_stage_event
        WHERE operation_id = ${parsed.operationId}::uuid
          AND stage = ${parsed.stage}
          AND dataset_key IS NOT DISTINCT FROM ${parsed.datasetKey ?? null}
          AND output_path IS NOT DISTINCT FROM ${parsed.outputPath ?? null}
          AND model_name IS NOT DISTINCT FROM ${parsed.modelName ?? null}
          AND status = ${parsed.status}
          AND idempotency_key = ${parsed.idempotencyKey}`,
  );
  if (!existing[0]) throw new Error("Processing event conflict could not be resolved");
  return mapEvent(existing[0]);
}

export async function appendProcessingStageEvent(
  database: SchemaExecutionDatabase,
  input: z.input<typeof appendEventInputSchema>,
): Promise<StoredProcessingStageEvent> {
  return appendEvent(database, input);
}

export async function getLatestProcessingEvents(
  database: SchemaExecutionDatabase,
  operationId: string,
): Promise<StoredProcessingStageEvent[]> {
  const parsedOperationId = z.uuid().parse(operationId);
  const rows = await executeWithSchema(
    database,
    eventRowSchema,
    sql`SELECT DISTINCT ON (stage, dataset_key, output_path, model_name) ${eventColumns}
        FROM fitness.processing_stage_event
        WHERE operation_id = ${parsedOperationId}::uuid
        ORDER BY stage, dataset_key, output_path, model_name, sequence DESC`,
  );
  return rows.map(mapEvent).sort((left, right) => left.sequence - right.sequence);
}

export async function recordProcessingOutput(
  database: SchemaExecutionDatabase,
  input: z.input<typeof recordProcessingOutputInputSchema>,
): Promise<void> {
  const parsed = recordProcessingOutputInputSchema.parse(input);
  await executeWithSchema(
    database,
    operationOutputRowSchema,
    sql`INSERT INTO fitness.processing_operation_output
          (operation_id, dataset_key, output_path)
        VALUES (${parsed.operationId}::uuid, ${parsed.datasetKey}, ${parsed.outputPath})
        ON CONFLICT (operation_id, dataset_key, output_path) DO NOTHING
        RETURNING dataset_key, output_path`,
  );
}

export async function getProcessingOutputManifest(
  database: SchemaExecutionDatabase,
  operationId: string,
): Promise<Partial<Record<ProcessingDatasetKey, ProcessingOutputPath[]>>> {
  const parsedOperationId = z.uuid().parse(operationId);
  const rows = await executeWithSchema(
    database,
    operationOutputRowSchema,
    sql`SELECT dataset_key, output_path
        FROM fitness.processing_operation_output
        WHERE operation_id = ${parsedOperationId}::uuid
        ORDER BY dataset_key, output_path`,
  );
  return mapProcessingOutputManifest(rows);
}

function mapProcessingOutputManifest(
  rows: readonly z.infer<typeof operationOutputRowSchema>[],
): Partial<Record<ProcessingDatasetKey, ProcessingOutputPath[]>> {
  const manifest: Partial<Record<ProcessingDatasetKey, ProcessingOutputPath[]>> = {};
  for (const row of rows) {
    const outputPaths = manifest[row.dataset_key] ?? [];
    outputPaths.push(row.output_path);
    manifest[row.dataset_key] = outputPaths;
  }
  for (const outputPaths of Object.values(manifest)) {
    outputPaths.sort(
      (left, right) =>
        PROCESSING_OUTPUT_PATHS.indexOf(left) - PROCESSING_OUTPUT_PATHS.indexOf(right),
    );
  }
  return manifest;
}

export interface ProcessingOperationDataset {
  operationId: string;
  datasetKey: ProcessingDatasetKey;
}

export interface ProcessingCacheRefreshTarget extends ProcessingOperationDataset {
  userId: string;
}

function mapOperationDataset(
  row: z.infer<typeof operationDatasetRowSchema>,
): ProcessingOperationDataset {
  return { operationId: row.operation_id, datasetKey: row.dataset_key };
}

export async function listProcessingDatasetsAwaitingAnalytics(
  database: SchemaExecutionDatabase,
): Promise<ProcessingOperationDataset[]> {
  const rows = await executeWithSchema(
    database,
    operationDatasetRowSchema,
    sql`SELECT DISTINCT output.operation_id, output.dataset_key
        FROM fitness.processing_operation_output output
        WHERE (
          SELECT ingest.status
          FROM fitness.processing_stage_event ingest
          WHERE ingest.operation_id = output.operation_id
            AND ingest.stage = 'ingest'
            AND (ingest.dataset_key IS NULL OR ingest.dataset_key = output.dataset_key)
          ORDER BY ingest.sequence DESC
          LIMIT 1
        ) = 'succeeded'
          AND NOT EXISTS (
            SELECT 1
            FROM fitness.processing_operation_output required_output
            WHERE required_output.operation_id = output.operation_id
              AND required_output.dataset_key = output.dataset_key
              AND coalesce((
                SELECT cdc.status
                FROM fitness.processing_stage_event cdc
                WHERE cdc.operation_id = required_output.operation_id
                  AND cdc.dataset_key = required_output.dataset_key
                  AND cdc.output_path = required_output.output_path
                  AND cdc.stage = 'cdc'
                ORDER BY cdc.sequence DESC
                LIMIT 1
              ), '') NOT IN ('succeeded', 'skipped')
          )
          AND coalesce((
            SELECT analytics.status
            FROM fitness.processing_stage_event analytics
            WHERE analytics.operation_id = output.operation_id
              AND analytics.dataset_key = output.dataset_key
              AND analytics.stage = 'analytics'
              AND analytics.model_name IS NULL
            ORDER BY analytics.sequence DESC
            LIMIT 1
          ), '') NOT IN ('succeeded', 'failed', 'cancelled', 'skipped')
        ORDER BY output.operation_id, output.dataset_key`,
  );
  return rows.map(mapOperationDataset);
}

export async function listProcessingDatasetsAwaitingCacheRefresh(
  database: SchemaExecutionDatabase,
): Promise<ProcessingCacheRefreshTarget[]> {
  const rows = await executeWithSchema(
    database,
    cacheRefreshTargetRowSchema,
    sql`SELECT DISTINCT output.operation_id, output.dataset_key, operation.user_id
        FROM fitness.processing_operation_output output
        INNER JOIN fitness.processing_operation operation ON operation.id = output.operation_id
        WHERE operation.user_id IS NOT NULL
          AND (
          SELECT analytics.status
          FROM fitness.processing_stage_event analytics
          WHERE analytics.operation_id = output.operation_id
            AND analytics.dataset_key = output.dataset_key
            AND analytics.stage = 'analytics'
            AND analytics.model_name IS NULL
          ORDER BY analytics.sequence DESC
          LIMIT 1
        ) IN ('succeeded', 'skipped')
          AND coalesce((
            SELECT cache_refresh.status
            FROM fitness.processing_stage_event cache_refresh
            WHERE cache_refresh.operation_id = output.operation_id
              AND cache_refresh.dataset_key = output.dataset_key
              AND cache_refresh.stage = 'cache_refresh'
              AND cache_refresh.model_name IS NULL
            ORDER BY cache_refresh.sequence DESC
            LIMIT 1
          ), '') NOT IN ('succeeded', 'failed', 'cancelled', 'skipped')
        ORDER BY output.operation_id, output.dataset_key`,
  );
  return rows.map((row) => ({ ...mapOperationDataset(row), userId: row.user_id }));
}

const canonicalCommitInputSchema = z.object({
  operationId: z.uuid(),
  datasetKey: datasetKeySchema,
  sourceWatermark: z.string().min(1).max(500),
  flowNames: z.array(z.string().min(1).max(200)),
  idempotencyKey: z.string().min(1).max(500),
});

const relationalCanonicalCommitsInputSchema = z.object({
  operationId: z.uuid(),
  datasetKeys: z.array(datasetKeySchema).min(1),
  idempotencyKey: z.string().min(1).max(400),
});

const postgresWriteWatermarkRowSchema = z.object({
  source_watermark: z.string().min(1),
});

export async function recordCanonicalCommitInTransaction(
  database: SchemaExecutionDatabase,
  input: z.input<typeof canonicalCommitInputSchema>,
): Promise<StoredProcessingStageEvent> {
  const parsed = canonicalCommitInputSchema.parse(input);
  await recordProcessingOutput(database, {
    operationId: parsed.operationId,
    datasetKey: parsed.datasetKey,
    outputPath: "relational",
  });
  const commitEvent = await appendEvent(database, {
    operationId: parsed.operationId,
    stage: "canonical_commit",
    status: "succeeded",
    datasetKey: parsed.datasetKey,
    outputPath: "relational",
    sourceWatermark: parsed.sourceWatermark,
    idempotencyKey: parsed.idempotencyKey,
  });
  await appendEvent(database, {
    operationId: parsed.operationId,
    stage: "cdc",
    status: "queued",
    datasetKey: parsed.datasetKey,
    outputPath: "relational",
    sourceWatermark: parsed.sourceWatermark,
    message: "Waiting for stored data to become available for analysis",
    idempotencyKey: `cdc:${parsed.idempotencyKey}`,
  });
  for (const flowName of parsed.flowNames) {
    await database.execute(sql`INSERT INTO fitness.processing_flow_marker
        (operation_id, dataset_key, flow_name, batch_key, source_watermark)
      VALUES (
        ${parsed.operationId}::uuid,
        ${parsed.datasetKey},
        ${flowName},
        ${parsed.idempotencyKey},
        ${commitEvent.sourceWatermark}
      )
      ON CONFLICT (operation_id, dataset_key, flow_name, batch_key) DO NOTHING`);
  }
  await database.execute(sql`INSERT INTO fitness.processing_queue_outbox
      (operation_id, queue_name, job_id)
    VALUES (
      ${parsed.operationId}::uuid,
      'processing-reconcile',
      ${`${parsed.operationId}:${parsed.idempotencyKey}`}
    )
    ON CONFLICT (queue_name, job_id) DO NOTHING`);
  return commitEvent;
}

export async function recordCanonicalCommit(
  database: Pick<Database, "transaction">,
  input: z.input<typeof canonicalCommitInputSchema>,
): Promise<StoredProcessingStageEvent> {
  const parsed = canonicalCommitInputSchema.parse(input);
  return database.transaction((transaction) =>
    recordCanonicalCommitInTransaction(transaction, parsed),
  );
}

export async function recordRelationalCanonicalCommits(
  database: Pick<Database, "transaction">,
  input: z.input<typeof relationalCanonicalCommitsInputSchema>,
): Promise<void> {
  const parsed = relationalCanonicalCommitsInputSchema.parse(input);
  await database.transaction(async (transaction) => {
    const watermarkRows = await executeWithSchema(
      transaction,
      postgresWriteWatermarkRowSchema,
      sql`SELECT pg_current_wal_lsn()::text AS source_watermark`,
    );
    const sourceWatermark = watermarkRows[0]?.source_watermark;
    if (!sourceWatermark) {
      throw new Error("Postgres did not return a write watermark");
    }

    for (const datasetKey of parsed.datasetKeys) {
      const contract = DATASET_CONTRACTS.find((candidate) => candidate.key === datasetKey);
      const relationalContract = contract?.outputPaths.find(
        (outputPath) => outputPath.path === "relational",
      );
      if (!relationalContract) {
        throw new Error(`Dataset ${datasetKey} does not define relational output`);
      }
      const flowNames = relationalContract.cdcEvidence
        .filter((dependency) => dependency.kind === "peerdb_marker")
        .map((dependency) => dependency.flowName);
      await recordCanonicalCommitInTransaction(transaction, {
        operationId: parsed.operationId,
        datasetKey,
        sourceWatermark,
        flowNames,
        idempotencyKey: `${parsed.idempotencyKey}:${datasetKey}`,
      });
    }
  });
}

export async function recordMetricStreamBatchPublished(
  database: Pick<Database, "transaction">,
  input: z.input<typeof recordMetricStreamBatchInputSchema>,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await recordMetricStreamBatchPublishedInTransaction(transaction, input);
  });
}

export async function recordMetricStreamBatchPublishedInTransaction(
  database: SchemaExecutionDatabase,
  input: z.input<typeof recordMetricStreamBatchInputSchema>,
): Promise<void> {
  const parsed = recordMetricStreamBatchInputSchema.parse(input);
  const datasetKeys = sql.join(
    parsed.datasetKeys.map((datasetKey) => sql`${datasetKey}`),
    sql`, `,
  );
  await database.execute(sql`INSERT INTO fitness.processing_metric_stream_batch
        (operation_id, batch_id, dataset_keys, expected_event_count)
      VALUES (
        ${parsed.operationId}::uuid,
        ${parsed.batchId},
        ARRAY[${datasetKeys}]::text[],
        ${parsed.expectedEventCount}
      )
      ON CONFLICT (operation_id, batch_id) DO NOTHING`);

  for (const datasetKey of parsed.datasetKeys) {
    await recordProcessingOutput(database, {
      operationId: parsed.operationId,
      datasetKey,
      outputPath: "metric_stream",
    });
    await appendEvent(database, {
      operationId: parsed.operationId,
      stage: "canonical_commit",
      status: "succeeded",
      datasetKey,
      outputPath: "metric_stream",
      sourceWatermark: parsed.batchId,
      idempotencyKey: parsed.batchId,
    });
    await appendEvent(database, {
      operationId: parsed.operationId,
      stage: "cdc",
      status: "queued",
      datasetKey,
      outputPath: "metric_stream",
      sourceWatermark: parsed.batchId,
      message: "Waiting for stored data to become available for analysis",
      idempotencyKey: `cdc:${parsed.batchId}`,
    });
  }

  await database.execute(sql`INSERT INTO fitness.processing_queue_outbox
        (operation_id, queue_name, job_id)
      VALUES (
        ${parsed.operationId}::uuid,
        'processing-reconcile',
        ${`${parsed.operationId}:${parsed.batchId}`}
      )
      ON CONFLICT (queue_name, job_id) DO NOTHING`);
}

interface ProcessingHistoryInput {
  userId: string;
  limit: number;
  cursor?: string | null;
}

export interface ProcessingHistoryPage {
  operations: ProcessingOperation[];
  nextCursor: string | null;
}

export interface ProcessingOperationWithEvents extends ProcessingOperation {
  events: StoredProcessingStageEvent[];
  outputManifest: Partial<Record<ProcessingDatasetKey, ProcessingOutputPath[]>>;
}

interface ScopedProcessingOperationsInput {
  userId: string;
  providerId?: string;
  datasetKeys?: readonly ProcessingDatasetKey[];
  limit?: number;
}

export async function listScopedProcessingOperations(
  database: SchemaExecutionDatabase,
  input: ScopedProcessingOperationsInput,
): Promise<ProcessingOperationWithEvents[]> {
  const userId = z.uuid().parse(input.userId);
  const providerId = z.string().min(1).optional().parse(input.providerId);
  const datasetKeys = z.array(datasetKeySchema).optional().parse(input.datasetKeys);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(input.limit ?? 20);
  const datasetPredicate = datasetKeys
    ? sql`AND operation.dataset_keys && ARRAY[${sql.join(
        datasetKeys.map((datasetKey) => sql`${datasetKey}`),
        sql`, `,
      )}]::text[]`
    : sql``;
  const rows = await executeWithSchema(
    database,
    scopedOperationRowSchema,
    sql`WITH scoped_operations AS (
          SELECT ${operationColumns}
          FROM fitness.processing_operation operation
          WHERE operation.user_id = ${userId}::uuid
            AND (${providerId ?? null}::text IS NULL OR operation.provider_id = ${providerId ?? null})
            ${datasetPredicate}
            AND operation.created_at >= now() - interval '90 days'
          ORDER BY operation.created_at DESC, operation.id DESC
          LIMIT ${limit}
        )
        SELECT operation.*,
          coalesce(event_rows.events, '[]'::jsonb) AS events,
          coalesce(output_rows.output_manifest, '[]'::jsonb) AS output_manifest
        FROM scoped_operations operation
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(to_jsonb(latest_event) ORDER BY latest_event.sequence) AS events
          FROM (
            SELECT DISTINCT ON (stage, dataset_key, output_path, model_name) ${eventColumns}
            FROM fitness.processing_stage_event event
            WHERE event.operation_id = operation.id
            ORDER BY stage, dataset_key, output_path, model_name, sequence DESC
          ) latest_event
        ) event_rows ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            jsonb_build_object(
              'dataset_key', output.dataset_key,
              'output_path', output.output_path
            ) ORDER BY output.dataset_key, output.output_path
          ) AS output_manifest
          FROM fitness.processing_operation_output output
          WHERE output.operation_id = operation.id
        ) output_rows ON true
        ORDER BY operation.created_at DESC, operation.id DESC`,
  );
  return rows.map((row) => ({
    ...mapOperation(row),
    events: row.events.map(mapEvent).sort((left, right) => left.sequence - right.sequence),
    outputManifest: mapProcessingOutputManifest(row.output_manifest),
  }));
}

export async function listProcessingHistory(
  database: SchemaExecutionDatabase,
  input: ProcessingHistoryInput,
): Promise<ProcessingHistoryPage> {
  const userId = z.uuid().parse(input.userId);
  const limit = z.number().int().min(1).max(100).parse(input.limit);
  const cursor = z
    .uuid()
    .nullable()
    .parse(input.cursor ?? null);
  const rows = await executeWithSchema(
    database,
    operationRowSchema,
    sql`SELECT ${operationColumns}
        FROM fitness.processing_operation operation
        WHERE operation.user_id = ${userId}::uuid
          AND (
            ${cursor}::uuid IS NULL
            OR (operation.created_at, operation.id) < (
              SELECT cursor_operation.created_at, cursor_operation.id
              FROM fitness.processing_operation cursor_operation
              WHERE cursor_operation.id = ${cursor}::uuid
                AND cursor_operation.user_id = ${userId}::uuid
            )
          )
        ORDER BY operation.created_at DESC, operation.id DESC
        LIMIT ${limit}`,
  );
  const operations = rows.map(mapOperation);
  return {
    operations,
    nextCursor: operations.length === limit ? (operations.at(-1)?.id ?? null) : null,
  };
}
