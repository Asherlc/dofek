import type { Database } from "dofek/db";
import {
  DATASET_CONTRACTS,
  PROCESSING_DATASET_KEYS,
  type ProcessingDatasetKey,
  type ProcessingOutputPath,
} from "dofek/processing/dataset-contracts";
import {
  listProcessingHistory,
  listScopedProcessingOperations,
  type ProcessingOperationWithEvents,
} from "dofek/processing/processing-event-store";
import {
  type DerivedProcessingStatus,
  deriveProcessingState,
  type ProcessingEventStatus,
  type ProcessingStage,
} from "dofek/processing/processing-state";

const DEFAULT_DELAY_MS = 15 * 60 * 1_000;

export interface ProcessingStatusScope {
  providerId: string | null;
  datasets: ProcessingDatasetKey[];
}

export interface ProcessingStatusDataset {
  key: ProcessingDatasetKey;
  label: string;
  status: DerivedProcessingStatus;
  currentStage: ProcessingStage | null;
  progressPercentage: number | null;
  lastAdvancedAt: string | null;
  lastReadyAt: string | null;
}

export interface ProcessingStatusOperation {
  id: string;
  providerId: string | null;
  kind: ProcessingOperationWithEvents["kind"];
  createdAt: string;
  status: DerivedProcessingStatus;
  datasets: ProcessingDatasetKey[];
  timeline: Array<{
    stage: ProcessingStage;
    status: ProcessingEventStatus;
    datasetKey: ProcessingDatasetKey | null;
    outputPath: ProcessingOutputPath | null;
    occurredAt: string;
    progressPercentage: number | null;
    message: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  }>;
}

export interface ProcessingStatusSnapshot {
  generatedAt: string;
  scope: ProcessingStatusScope;
  overallStatus: DerivedProcessingStatus;
  datasets: ProcessingStatusDataset[];
  operations: ProcessingStatusOperation[];
}

function operationState(operation: ProcessingOperationWithEvents, now: Date) {
  const ingestStatus = [...operation.events]
    .filter((event) => event.stage === "ingest")
    .sort((left, right) => right.sequence - left.sequence)[0]?.status;
  const operationStatus =
    ingestStatus === "queued" ||
    ingestStatus === "running" ||
    ingestStatus === "succeeded" ||
    ingestStatus === "failed" ||
    ingestStatus === "cancelled"
      ? ingestStatus
      : ingestStatus === "skipped"
        ? "succeeded"
        : undefined;
  return deriveProcessingState({
    datasetKeys: operation.datasetKeys,
    outputManifest: operation.outputManifest,
    events: operation.events.map((event) => ({
      sequence: event.sequence,
      stage: event.stage,
      status: event.status,
      datasetKey: event.datasetKey,
      outputPath: event.outputPath,
      occurredAt: event.occurredAt,
      progressPercentage: event.progressPercentage,
    })),
    operationStatus,
    now,
    delayedAfterMs: DEFAULT_DELAY_MS,
  });
}

function aggregateStatus(statuses: readonly DerivedProcessingStatus[]): DerivedProcessingStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("delayed")) return "delayed";
  if (statuses.includes("partial")) return "partial";
  if (statuses.includes("active")) return "active";
  if (statuses.includes("waiting")) return "waiting";
  if (statuses.includes("cancelled")) return "cancelled";
  return "ready";
}

export class ProcessingRepository {
  readonly #database: Database;
  readonly #userId: string;

  constructor(database: Database, userId: string) {
    this.#database = database;
    this.#userId = userId;
  }

  async status(input: {
    providerId?: string;
    datasets?: readonly ProcessingDatasetKey[];
  }): Promise<ProcessingStatusSnapshot> {
    const now = new Date();
    const requestedDatasets = [...(input.datasets ?? PROCESSING_DATASET_KEYS)];
    const operations = await listScopedProcessingOperations(this.#database, {
      userId: this.#userId,
      providerId: input.providerId,
      datasetKeys: requestedDatasets,
    });
    const operationsWithState = operations.map((operation) => ({
      operation,
      state: operationState(operation, now),
    }));
    const datasets = requestedDatasets.map((datasetKey): ProcessingStatusDataset => {
      const relevant = operationsWithState.filter(({ operation }) =>
        operation.datasetKeys.includes(datasetKey),
      );
      const latest = relevant[0]?.state.datasets.find(
        (dataset) => dataset.datasetKey === datasetKey,
      );
      const lastReady = relevant.find(({ state }) =>
        state.datasets.some(
          (dataset) => dataset.datasetKey === datasetKey && dataset.status === "ready",
        ),
      );
      const contract = DATASET_CONTRACTS.find((candidate) => candidate.key === datasetKey);
      if (!contract) throw new Error(`Missing processing dataset contract for ${datasetKey}`);
      return {
        key: datasetKey,
        label: contract.label,
        status: latest?.status ?? "ready",
        currentStage: latest?.currentStage ?? null,
        progressPercentage: latest?.progressPercentage ?? null,
        lastAdvancedAt: latest?.lastAdvancedAt?.toISOString() ?? null,
        lastReadyAt:
          lastReady?.state.datasets
            .find((dataset) => dataset.datasetKey === datasetKey)
            ?.lastAdvancedAt?.toISOString() ?? null,
      };
    });
    return {
      generatedAt: now.toISOString(),
      scope: { providerId: input.providerId ?? null, datasets: requestedDatasets },
      overallStatus: aggregateStatus(datasets.map((dataset) => dataset.status)),
      datasets,
      operations: operationsWithState.map(({ operation, state }) => ({
        id: operation.id,
        providerId: operation.providerId,
        kind: operation.kind,
        createdAt: operation.createdAt.toISOString(),
        status: state.overallStatus,
        datasets: operation.datasetKeys,
        timeline: operation.events
          .filter((event) => event.modelName === null)
          .map((event) => ({
            stage: event.stage,
            status: event.status,
            datasetKey: event.datasetKey,
            outputPath: event.outputPath,
            occurredAt: event.occurredAt.toISOString(),
            progressPercentage: event.progressPercentage,
            message: event.message,
            errorCode: event.errorCode,
            errorMessage: event.errorMessage,
          })),
      })),
    };
  }

  async history(input: { cursor?: string | null; limit: number }) {
    return listProcessingHistory(this.#database, {
      userId: this.#userId,
      cursor: input.cursor,
      limit: input.limit,
    });
  }
}
