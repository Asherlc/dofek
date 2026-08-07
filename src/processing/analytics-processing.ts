import type { SchemaExecutionDatabase } from "../db/typed-sql.ts";
import { DATASET_CONTRACTS, type ProcessingDatasetKey } from "./dataset-contracts.ts";
import {
  appendProcessingStageEvent,
  listProcessingDatasetsAwaitingAnalytics,
  type ProcessingOperationDataset,
} from "./processing-event-store.ts";

interface ProcessingDbtModelResult {
  name: string;
  status: "succeeded" | "failed" | "skipped";
  errorCode: string | null;
  message: string | null;
}

interface BuildProcessingAnalyticsEventsInput {
  runId: string;
  pendingDatasets: readonly ProcessingOperationDataset[];
  modelResults: readonly ProcessingDbtModelResult[];
}

export interface ProcessingAnalyticsEvent {
  operationId: string;
  datasetKey: ProcessingDatasetKey;
  modelName: string | null;
  status: "succeeded" | "failed" | "skipped";
  errorCode: string | null;
  errorMessage: string | null;
  message: string;
  servingWatermark: string;
  idempotencyKey: string;
}

export function buildProcessingAnalyticsEvents({
  runId,
  pendingDatasets,
  modelResults,
}: BuildProcessingAnalyticsEventsInput): ProcessingAnalyticsEvent[] {
  const resultsByName = new Map(modelResults.map((result) => [result.name, result]));
  const events: ProcessingAnalyticsEvent[] = [];

  for (const pendingDataset of pendingDatasets) {
    const contract = DATASET_CONTRACTS.find(
      (candidate) => candidate.key === pendingDataset.datasetKey,
    );
    if (!contract) {
      throw new Error(`Missing processing dataset contract for ${pendingDataset.datasetKey}`);
    }
    if (contract.analyticsModels.length === 0) {
      events.push({
        ...pendingDataset,
        modelName: null,
        status: "skipped",
        errorCode: null,
        errorMessage: null,
        message: "No analytics build is required for this dataset",
        servingWatermark: runId,
        idempotencyKey: `${runId}:${pendingDataset.operationId}:${pendingDataset.datasetKey}:skipped`,
      });
      continue;
    }

    const datasetModelEvents = contract.analyticsModels.map((modelName) => {
      const result = resultsByName.get(modelName);
      if (!result) {
        return {
          ...pendingDataset,
          modelName,
          status: "failed" as const,
          errorCode: "required_model_unattempted",
          errorMessage: `Required analytics model ${modelName} was not attempted`,
          message: "A required analytics calculation did not run",
          servingWatermark: runId,
          idempotencyKey: `${runId}:${pendingDataset.operationId}:${pendingDataset.datasetKey}:${modelName}:failed`,
        };
      }
      return {
        ...pendingDataset,
        modelName,
        status: result.status,
        errorCode: result.errorCode,
        errorMessage: result.message,
        message:
          result.status === "succeeded"
            ? "Analytics calculation completed"
            : "Analytics calculation did not complete",
        servingWatermark: runId,
        idempotencyKey: `${runId}:${pendingDataset.operationId}:${pendingDataset.datasetKey}:${modelName}:${result.status}`,
      };
    });
    events.push(...datasetModelEvents);

    const firstIncomplete = datasetModelEvents.find((event) => event.status !== "succeeded");
    events.push({
      ...pendingDataset,
      modelName: null,
      status: firstIncomplete ? "failed" : "succeeded",
      errorCode: firstIncomplete?.errorCode ?? null,
      errorMessage: firstIncomplete
        ? "Some analytics calculations could not be completed. Try the update again."
        : null,
      message: firstIncomplete
        ? "Some analytics calculations did not complete"
        : "Analytics calculations completed",
      servingWatermark: runId,
      idempotencyKey: `${runId}:${pendingDataset.operationId}:${pendingDataset.datasetKey}:aggregate:${firstIncomplete ? "failed" : "succeeded"}`,
    });
  }

  return events;
}

export async function recordAnalyticsRunForPendingProcessing(
  database: SchemaExecutionDatabase,
  input: { runId: string; modelResults: readonly ProcessingDbtModelResult[] },
): Promise<{ datasets: number; failed: number }> {
  const pendingDatasets = await listProcessingDatasetsAwaitingAnalytics(database);
  const events = buildProcessingAnalyticsEvents({ ...input, pendingDatasets });
  for (const event of events) {
    await appendProcessingStageEvent(database, {
      operationId: event.operationId,
      stage: "analytics",
      status: event.status,
      datasetKey: event.datasetKey,
      modelName: event.modelName,
      servingWatermark: event.servingWatermark,
      message: event.message,
      errorCode: event.errorCode,
      errorMessage: event.errorMessage,
      idempotencyKey: event.idempotencyKey,
    });
    if (event.modelName === null && (event.status === "succeeded" || event.status === "skipped")) {
      await appendProcessingStageEvent(database, {
        operationId: event.operationId,
        stage: "cache_refresh",
        status: "queued",
        datasetKey: event.datasetKey,
        servingWatermark: event.servingWatermark,
        message: "Waiting for cached views to refresh",
        idempotencyKey: `cache:${event.idempotencyKey}`,
      });
    }
  }

  const aggregateEvents = events.filter((event) => event.modelName === null);
  return {
    datasets: aggregateEvents.length,
    failed: aggregateEvents.filter((event) => event.status === "failed").length,
  };
}
