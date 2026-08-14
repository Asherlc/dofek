import type { SchemaExecutionDatabase } from "../db/typed-sql.ts";
import { DATASET_CONTRACTS, type ProcessingDatasetKey } from "./dataset-contracts.ts";
import {
  appendProcessingStageEvent,
  listProcessingDatasetsAwaitingCacheRefresh,
  type ProcessingCacheRefreshTarget,
} from "./processing-event-store.ts";

export interface ProcessingCacheOutcome {
  userId: string;
  path: string;
  status: "succeeded" | "failed";
  errorMessage: string | null;
}

interface BuildProcessingCacheEventsInput {
  runId: string;
  targets: readonly ProcessingCacheRefreshTarget[];
  outcomes: readonly ProcessingCacheOutcome[];
}

export interface ProcessingCacheEvent {
  operationId: string;
  datasetKey: ProcessingDatasetKey;
  status: "succeeded" | "failed" | "skipped";
  errorMessage: string | null;
  message: string;
  servingWatermark: string;
  idempotencyKey: string;
}

function pathBelongsToFamily(path: string, family: string): boolean {
  return path === family || path.startsWith(`${family}.`);
}

export function buildProcessingCacheEvents({
  runId,
  targets,
  outcomes,
}: BuildProcessingCacheEventsInput): ProcessingCacheEvent[] {
  return targets.map((target) => {
    const contract = DATASET_CONTRACTS.find((candidate) => candidate.key === target.datasetKey);
    if (!contract) {
      throw new Error(`Missing processing dataset contract for ${target.datasetKey}`);
    }
    const relevantOutcomes = outcomes.filter(
      (outcome) =>
        outcome.userId === target.userId &&
        contract.cacheQueryFamilies.some((family) => pathBelongsToFamily(outcome.path, family)),
    );
    const firstFailure = relevantOutcomes.find((outcome) => outcome.status === "failed");
    const status = firstFailure ? "failed" : relevantOutcomes.length > 0 ? "succeeded" : "skipped";
    return {
      operationId: target.operationId,
      datasetKey: target.datasetKey,
      status,
      errorMessage: firstFailure
        ? "Some screens could not be refreshed. Refresh the app and try again."
        : null,
      message:
        status === "succeeded"
          ? "Cached views refreshed"
          : status === "skipped"
            ? "No cached views required a refresh"
            : "A cached view could not be refreshed",
      servingWatermark: runId,
      idempotencyKey: `${runId}:${target.datasetKey}:${status}`,
    };
  });
}

export async function recordCacheRunForPendingProcessing(
  database: SchemaExecutionDatabase,
  input: { runId: string; outcomes: readonly ProcessingCacheOutcome[] },
): Promise<{ datasets: number; failed: number }> {
  const targets = await listProcessingDatasetsAwaitingCacheRefresh(database);
  const events = buildProcessingCacheEvents({ ...input, targets });
  for (const event of events) {
    await appendProcessingStageEvent(database, {
      operationId: event.operationId,
      stage: "cache_refresh",
      status: event.status,
      datasetKey: event.datasetKey,
      servingWatermark: event.servingWatermark,
      message: event.message,
      errorCode: event.status === "failed" ? "cache_refresh_failed" : null,
      errorMessage: event.errorMessage,
      idempotencyKey: event.idempotencyKey,
    });
  }
  return {
    datasets: events.length,
    failed: events.filter((event) => event.status === "failed").length,
  };
}
