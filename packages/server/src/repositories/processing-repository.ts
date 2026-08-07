import type { ProcessingAlert } from "@dofek/providers/processing-alerts";
import { providerLabel } from "@dofek/providers/providers";
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
    sequence: number;
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

interface ServerProcessingAlert extends Omit<ProcessingAlert, "datasetKey"> {
  datasetKey: ProcessingDatasetKey;
}

export interface ProcessingAlertsSnapshot {
  generatedAt: string;
  alerts: ServerProcessingAlert[];
}

function datasetSubject(datasetKey: ProcessingDatasetKey, label: string): string {
  if (datasetKey === "providers") return "summary";
  return label.toLowerCase();
}

function buildProcessingAlert(
  dataset: ProcessingStatusDataset,
  operation: ProcessingStatusOperation,
): ServerProcessingAlert {
  const failedEvent = [...operation.timeline]
    .filter(
      (event) =>
        event.status === "failed" &&
        (event.datasetKey === null || event.datasetKey === dataset.key),
    )
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0];
  const sourceLabel = operation.providerId ? providerLabel(operation.providerId) : null;
  const subject = datasetSubject(dataset.key, dataset.label);
  const occurredAt = failedEvent?.occurredAt ?? dataset.lastAdvancedAt ?? operation.createdAt;

  if (operation.kind === "file_import") {
    const importedFile = sourceLabel ? `the ${sourceLabel} file` : "your file";
    return {
      id: `${operation.id}:${dataset.key}`,
      providerId: operation.providerId,
      providerLabel: sourceLabel,
      datasetKey: dataset.key,
      occurredAt,
      title:
        failedEvent?.stage === "ingest"
          ? sourceLabel
            ? `${sourceLabel} file wasn’t imported`
            : "Your file wasn’t imported"
          : sourceLabel
            ? `${sourceLabel} ${subject} wasn’t updated`
            : `${dataset.label} wasn’t updated`,
      message:
        failedEvent?.stage === "ingest"
          ? `Dofek couldn’t finish importing ${importedFile}. Check that you selected the correct file, then import it again.`
          : `Dofek imported ${importedFile}, but couldn’t update ${subject}. Your previously imported data is still available.`,
      action: "retry_import",
      actionLabel: sourceLabel ? `Import ${sourceLabel} again` : "Import the file again",
    };
  }

  if (operation.kind === "provider_sync" && sourceLabel) {
    if (failedEvent?.stage === "ingest" || failedEvent?.errorCode === "provider_sync_failed") {
      return {
        id: `${operation.id}:${dataset.key}`,
        providerId: operation.providerId,
        providerLabel: sourceLabel,
        datasetKey: dataset.key,
        occurredAt,
        title: `${sourceLabel} couldn’t sync`,
        message: `Dofek couldn’t get the latest data from ${sourceLabel}. Reconnect ${sourceLabel}, then start the sync again.`,
        action: "reconnect",
        actionLabel: `Reconnect ${sourceLabel}`,
      };
    }

    return {
      id: `${operation.id}:${dataset.key}`,
      providerId: operation.providerId,
      providerLabel: sourceLabel,
      datasetKey: dataset.key,
      occurredAt,
      title: `${sourceLabel} ${subject} wasn’t updated`,
      message:
        dataset.key === "providers"
          ? `Your ${sourceLabel} data synced, but its totals and latest-sync information couldn’t be refreshed. Your previously synced data is still available.`
          : `Your ${sourceLabel} data synced, but Dofek couldn’t update ${subject}. Your previously synced data is still available.`,
      action: "retry_sync",
      actionLabel: `Retry ${sourceLabel} sync`,
    };
  }

  return {
    id: `${operation.id}:${dataset.key}`,
    providerId: operation.providerId,
    providerLabel: sourceLabel,
    datasetKey: dataset.key,
    occurredAt,
    title: `${dataset.label} wasn’t updated`,
    message: `Dofek couldn’t update ${subject}. Your existing data is still available. Contact support for help.`,
    action: "contact_support",
    actionLabel: "Contact support",
  };
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
  if (statuses.includes("cancelled")) return "cancelled";
  if (statuses.includes("delayed")) return "delayed";
  if (statuses.includes("partial")) return "partial";
  if (statuses.includes("active")) return "active";
  if (statuses.includes("waiting")) return "waiting";
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
    const requestedDatasetSet: ReadonlySet<string> = new Set(requestedDatasets);
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
      const lastReadyDataset = relevant
        .flatMap(({ state }) => state.datasets)
        .find((dataset) => dataset.datasetKey === datasetKey && dataset.status === "ready");
      const contract = DATASET_CONTRACTS.find((candidate) => candidate.key === datasetKey);
      if (!contract) throw new Error(`Missing processing dataset contract for ${datasetKey}`);
      return {
        key: datasetKey,
        label: contract.label,
        status: latest?.status ?? "ready",
        currentStage: latest?.currentStage ?? null,
        progressPercentage: latest?.progressPercentage ?? null,
        lastAdvancedAt: latest?.lastAdvancedAt?.toISOString() ?? null,
        lastReadyAt: lastReadyDataset?.lastAdvancedAt?.toISOString() ?? null,
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
        status: aggregateStatus(
          state.datasets
            .filter((dataset) => requestedDatasetSet.has(dataset.datasetKey))
            .map((dataset) => dataset.status),
        ),
        datasets: operation.datasetKeys.filter((datasetKey) => requestedDatasetSet.has(datasetKey)),
        timeline: operation.events
          .filter(
            (event) =>
              event.modelName === null &&
              (event.datasetKey === null || requestedDatasetSet.has(event.datasetKey)),
          )
          .map((event) => ({
            sequence: event.sequence,
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

  async alerts(): Promise<ProcessingAlertsSnapshot> {
    const snapshot = await this.status({});
    const alerts = snapshot.datasets.flatMap((dataset) => {
      if (dataset.status !== "failed" && dataset.status !== "blocked") return [];
      const currentOperation = snapshot.operations.find((operation) =>
        operation.datasets.includes(dataset.key),
      );
      return currentOperation ? [buildProcessingAlert(dataset, currentOperation)] : [];
    });
    return { generatedAt: snapshot.generatedAt, alerts };
  }

  async history(input: { cursor?: string | null; limit: number }) {
    return listProcessingHistory(this.#database, {
      userId: this.#userId,
      cursor: input.cursor,
      limit: input.limit,
    });
  }
}
