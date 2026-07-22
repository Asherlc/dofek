import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { createDatabaseFromEnv } from "../db/index.ts";
import { executeWithSchema, type SchemaExecutionDatabase } from "../db/typed-sql.ts";
import {
  DATASET_CONTRACTS,
  PROCESSING_DATASET_KEYS,
  PROCESSING_OUTPUT_PATHS,
  type ProcessingDatasetKey,
  type ProcessingOutputPath,
} from "./dataset-contracts.ts";
import { appendProcessingStageEvent } from "./processing-event-store.ts";

interface ProcessingOutput {
  datasetKey: ProcessingDatasetKey;
  outputPath: ProcessingOutputPath;
}

interface RelationalMarkerExpectation {
  datasetKey: ProcessingDatasetKey;
  flowName: string;
  batchKey: string;
  sourceWatermark: string;
}

interface MetricBatchExpectation {
  batchId: string;
  datasetKeys: readonly ProcessingDatasetKey[];
  expectedEventCount: number;
}

interface ObservedRelationalMarker {
  operationId: string;
  datasetKey: ProcessingDatasetKey;
  flowName: string;
  batchKey: string;
  sourceWatermark: string;
}

interface ObservedMetricBatch {
  operationId: string;
  batchId: string;
  expectedEventCount: number;
}

export interface ReconcileProcessingEvidenceInput {
  operationId: string;
  outputs: readonly ProcessingOutput[];
  relationalMarkers: readonly RelationalMarkerExpectation[];
  metricBatches: readonly MetricBatchExpectation[];
  observedRelationalMarkers: readonly ObservedRelationalMarker[];
  observedMetricBatches: readonly ObservedMetricBatch[];
}

export interface ProcessingEvidenceDecision {
  datasetKey: ProcessingDatasetKey;
  outputPath: ProcessingOutputPath;
  status: "running" | "succeeded";
  sourceWatermark: string | null;
  servingWatermark: string | null;
  idempotencyKey: string;
}

const datasetKeySchema = z.enum(PROCESSING_DATASET_KEYS);
const outputPathSchema = z.enum(PROCESSING_OUTPUT_PATHS);
const pendingOperationRowSchema = z.object({ operation_id: z.uuid() });
const outputRowSchema = z.object({
  dataset_key: datasetKeySchema,
  output_path: outputPathSchema,
});
const relationalMarkerRowSchema = z.object({
  dataset_key: datasetKeySchema,
  flow_name: z.string().min(1),
  batch_key: z.string().min(1),
  source_watermark: z.string().min(1),
});
const metricBatchRowSchema = z.object({
  batch_id: z.string().min(1),
  dataset_keys: z.array(datasetKeySchema).min(1),
  expected_event_count: z.coerce.number().int().positive(),
});
const observedRelationalMarkerRowsSchema = z.array(
  z.object({
    operation_id: z.uuid(),
    dataset_key: datasetKeySchema,
    flow_name: z.string().min(1),
    batch_key: z.string().min(1),
    source_watermark: z.string().min(1),
  }),
);
const observedMetricBatchRowsSchema = z.array(
  z.object({
    operation_id: z.uuid(),
    batch_id: z.string().min(1),
    expected_event_count: z.coerce.number().int().positive(),
  }),
);

export interface ReconcilePendingProcessingOperationsInput {
  database: SchemaExecutionDatabase;
  clickHouseClient: Pick<ClickHouseClient, "query">;
  limit?: number;
}

export interface ProcessingReconciliationResult {
  checked: number;
  completed: number;
  waiting: number;
}

export function createProcessingReconciliationDatabaseFromEnv(): SchemaExecutionDatabase {
  return createDatabaseFromEnv();
}

function evidenceDecision(
  operationId: string,
  output: ProcessingOutput,
  complete: boolean,
  sourceWatermark: string | null,
): ProcessingEvidenceDecision {
  const status = complete ? "succeeded" : "running";
  return {
    ...output,
    status,
    sourceWatermark,
    servingWatermark: complete ? sourceWatermark : null,
    idempotencyKey: [
      "cdc",
      operationId,
      output.datasetKey,
      output.outputPath,
      status,
      sourceWatermark ?? "none",
    ].join(":"),
  };
}

function reconcileRelationalOutput(
  input: ReconcileProcessingEvidenceInput,
  output: ProcessingOutput,
  requiredFlowNames: readonly string[],
): ProcessingEvidenceDecision {
  if (requiredFlowNames.length === 0) {
    return evidenceDecision(input.operationId, output, true, null);
  }

  const requiredFlows = new Set(requiredFlowNames);
  const expectedMarkers = input.relationalMarkers.filter(
    (marker) => marker.datasetKey === output.datasetKey && requiredFlows.has(marker.flowName),
  );
  const observedMarkers = new Set(
    input.observedRelationalMarkers
      .filter(
        (marker) =>
          marker.operationId === input.operationId && marker.datasetKey === output.datasetKey,
      )
      .map((marker) => `${marker.flowName}:${marker.batchKey}:${marker.sourceWatermark}`),
  );
  const expectedFlows = new Set(expectedMarkers.map((marker) => marker.flowName));
  const hasEveryRequiredFlow = requiredFlowNames.every((flowName) => expectedFlows.has(flowName));
  const complete =
    hasEveryRequiredFlow &&
    expectedMarkers.every((marker) =>
      observedMarkers.has(`${marker.flowName}:${marker.batchKey}:${marker.sourceWatermark}`),
    );
  const sourceWatermark = expectedMarkers.at(-1)?.sourceWatermark ?? null;

  return evidenceDecision(input.operationId, output, complete, sourceWatermark);
}

function reconcileMetricOutput(
  input: ReconcileProcessingEvidenceInput,
  output: ProcessingOutput,
): ProcessingEvidenceDecision {
  const expectedBatches = input.metricBatches.filter((batch) =>
    batch.datasetKeys.includes(output.datasetKey),
  );
  const observedBatches = new Map(
    input.observedMetricBatches
      .filter((batch) => batch.operationId === input.operationId)
      .map((batch) => [batch.batchId, batch.expectedEventCount]),
  );
  const complete =
    expectedBatches.length > 0 &&
    expectedBatches.every(
      (batch) => observedBatches.get(batch.batchId) === batch.expectedEventCount,
    );
  const sourceWatermark = expectedBatches.at(-1)?.batchId ?? null;

  return evidenceDecision(input.operationId, output, complete, sourceWatermark);
}

export function reconcileProcessingEvidence(
  input: ReconcileProcessingEvidenceInput,
): ProcessingEvidenceDecision[] {
  return input.outputs.map((output) => {
    const contract = DATASET_CONTRACTS.find(
      (candidateContract) => candidateContract.key === output.datasetKey,
    );
    const outputContract = contract?.outputPaths.find(
      (candidateOutput) => candidateOutput.path === output.outputPath,
    );
    if (!outputContract) {
      throw new Error(
        `Dataset ${output.datasetKey} does not define output path ${output.outputPath}`,
      );
    }

    if (output.outputPath === "metric_stream") {
      if (outputContract.cdcEvidence.length === 0) {
        return evidenceDecision(input.operationId, output, true, null);
      }
      return reconcileMetricOutput(input, output);
    }

    const requiredFlowNames = outputContract.cdcEvidence
      .filter((dependency) => dependency.kind === "peerdb_marker")
      .map((dependency) => dependency.flowName);
    return reconcileRelationalOutput(input, output, requiredFlowNames);
  });
}

async function loadReconciliationInput(
  database: SchemaExecutionDatabase,
  clickHouseClient: Pick<ClickHouseClient, "query">,
  operationId: string,
): Promise<ReconcileProcessingEvidenceInput> {
  const [outputs, relationalMarkers, metricBatches, relationalResult, metricResult] =
    await Promise.all([
      executeWithSchema(
        database,
        outputRowSchema,
        sql`SELECT dataset_key, output_path
            FROM fitness.processing_operation_output
            WHERE operation_id = ${operationId}::uuid
            ORDER BY dataset_key, output_path`,
      ),
      executeWithSchema(
        database,
        relationalMarkerRowSchema,
        sql`SELECT dataset_key, flow_name, batch_key, source_watermark
            FROM fitness.processing_flow_marker
            WHERE operation_id = ${operationId}::uuid
            ORDER BY created_at, id`,
      ),
      executeWithSchema(
        database,
        metricBatchRowSchema,
        sql`SELECT batch_id, dataset_keys, expected_event_count
            FROM fitness.processing_metric_stream_batch
            WHERE operation_id = ${operationId}::uuid
            ORDER BY published_at, id`,
      ),
      clickHouseClient.query({
        query: `SELECT operation_id, dataset_key, flow_name, batch_key, source_watermark
          FROM (
            SELECT
              toString(raw_marker.operation_id) AS operation_id,
              raw_marker.dataset_key AS dataset_key,
              raw_marker.flow_name AS flow_name,
              raw_marker.batch_key AS batch_key,
              raw_marker.source_watermark AS source_watermark
            FROM postgres_fitness.processing_flow_marker AS raw_marker FINAL
            WHERE raw_marker.operation_id = {operation_id:UUID}
              AND raw_marker.flow_name = 'dofek_fitness_raw_analytics'
              AND raw_marker._peerdb_is_deleted = 0
            UNION ALL
            SELECT
              toString(inventory_marker.operation_id) AS operation_id,
              inventory_marker.dataset_key AS dataset_key,
              inventory_marker.flow_name AS flow_name,
              inventory_marker.batch_key AS batch_key,
              inventory_marker.source_watermark AS source_watermark
            FROM postgres_fitness.processing_flow_marker_provider_inventory AS inventory_marker FINAL
            WHERE inventory_marker.operation_id = {operation_id:UUID}
              AND inventory_marker.flow_name = 'dofek_provider_inventory_raw_analytics'
              AND inventory_marker._peerdb_is_deleted = 0
          )`,
        query_params: { operation_id: operationId },
        format: "JSONEachRow",
      }),
      clickHouseClient.query({
        query: `SELECT
            toString(acknowledgement.operation_id) AS operation_id,
            acknowledgement.batch_id,
            acknowledgement.expected_event_count
          FROM ingest.metric_stream_processing_acknowledgement AS acknowledgement
          WHERE acknowledgement.operation_id = {operation_id:UUID}`,
        query_params: { operation_id: operationId },
        format: "JSONEachRow",
      }),
    ]);

  const observedRelationalMarkers = observedRelationalMarkerRowsSchema.parse(
    await relationalResult.json(),
  );
  const observedMetricBatches = observedMetricBatchRowsSchema.parse(await metricResult.json());

  return {
    operationId,
    outputs: outputs.map((output) => ({
      datasetKey: output.dataset_key,
      outputPath: output.output_path,
    })),
    relationalMarkers: relationalMarkers.map((marker) => ({
      datasetKey: marker.dataset_key,
      flowName: marker.flow_name,
      batchKey: marker.batch_key,
      sourceWatermark: marker.source_watermark,
    })),
    metricBatches: metricBatches.map((batch) => ({
      batchId: batch.batch_id,
      datasetKeys: batch.dataset_keys,
      expectedEventCount: batch.expected_event_count,
    })),
    observedRelationalMarkers: observedRelationalMarkers.map((marker) => ({
      operationId: marker.operation_id,
      datasetKey: marker.dataset_key,
      flowName: marker.flow_name,
      batchKey: marker.batch_key,
      sourceWatermark: marker.source_watermark,
    })),
    observedMetricBatches: observedMetricBatches.map((batch) => ({
      operationId: batch.operation_id,
      batchId: batch.batch_id,
      expectedEventCount: batch.expected_event_count,
    })),
  };
}

async function persistEvidenceDecision(
  database: SchemaExecutionDatabase,
  decision: ProcessingEvidenceDecision,
  operationId: string,
): Promise<void> {
  await appendProcessingStageEvent(database, {
    operationId,
    stage: "cdc",
    status: decision.status,
    datasetKey: decision.datasetKey,
    outputPath: decision.outputPath,
    sourceWatermark: decision.sourceWatermark,
    servingWatermark: decision.servingWatermark,
    message:
      decision.status === "succeeded"
        ? "Stored data is available for analysis"
        : "Waiting for stored data to become available for analysis",
    idempotencyKey: decision.idempotencyKey,
  });
}

export async function reconcilePendingProcessingOperations({
  database,
  clickHouseClient,
  limit = 100,
}: ReconcilePendingProcessingOperationsInput): Promise<ProcessingReconciliationResult> {
  const parsedLimit = z.number().int().min(1).max(1_000).parse(limit);
  const pendingOperations = await executeWithSchema(
    database,
    pendingOperationRowSchema,
    sql`SELECT operation_id
        FROM fitness.processing_queue_outbox
        WHERE queue_name = 'processing-reconcile'
          AND status IN ('pending', 'dispatched', 'failed')
        GROUP BY operation_id
        ORDER BY min(created_at), operation_id
        LIMIT ${parsedLimit}`,
  );

  let completed = 0;
  for (const pendingOperation of pendingOperations) {
    const reconciliationInput = await loadReconciliationInput(
      database,
      clickHouseClient,
      pendingOperation.operation_id,
    );
    const decisions = reconcileProcessingEvidence(reconciliationInput);
    for (const decision of decisions) {
      await persistEvidenceDecision(database, decision, pendingOperation.operation_id);
    }

    const datasetKeys = new Set(decisions.map((decision) => decision.datasetKey));
    for (const datasetKey of datasetKeys) {
      const datasetDecisions = decisions.filter((decision) => decision.datasetKey === datasetKey);
      if (datasetDecisions.every((decision) => decision.status === "succeeded")) {
        const servingWatermark = datasetDecisions
          .map((decision) => decision.servingWatermark)
          .filter((watermark): watermark is string => watermark !== null)
          .join(":");
        await appendProcessingStageEvent(database, {
          operationId: pendingOperation.operation_id,
          stage: "analytics",
          status: "queued",
          datasetKey,
          servingWatermark: servingWatermark || undefined,
          message: "Waiting for analytics calculations",
          idempotencyKey: `analytics:${datasetKey}:${servingWatermark || "no-cdc-transport"}`,
        });
      }
    }

    if (decisions.length > 0 && decisions.every((decision) => decision.status === "succeeded")) {
      await database.execute(sql`UPDATE fitness.processing_queue_outbox
          SET status = 'completed', dispatched_at = coalesce(dispatched_at, now())
          WHERE operation_id = ${pendingOperation.operation_id}::uuid
            AND queue_name = 'processing-reconcile'
            AND status IN ('pending', 'dispatched', 'failed')`);
      completed += 1;
    }
  }

  return {
    checked: pendingOperations.length,
    completed,
    waiting: pendingOperations.length - completed,
  };
}
