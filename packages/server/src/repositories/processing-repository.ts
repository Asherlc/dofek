import { TRPCError } from "@trpc/server";
import type { ProcessingAlert } from "@dofek/providers/processing-alerts";
import { providerLabel } from "@dofek/providers/providers";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
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
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

const DEFAULT_DELAY_MS = 15 * 60 * 1_000;
const dismissalRowSchema = z.object({ operation_id: z.uuid() });

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
  lastFailedAt: string | null;
  lastReadyAt: string | null;
}

export interface ProcessingStatusOperation {
  id: string;
  providerId: string | null;
  kind: ProcessingOperationWithEvents["kind"];
  createdAt: string;
  status: DerivedProcessingStatus;
  datasets: ProcessingDatasetKey[];
  dismissed: boolean;
  errorMessage: string | null;
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
  datasetKeys: ProcessingDatasetKey[];
}

export interface ProcessingAlertsSnapshot {
  generatedAt: string;
  alerts: ServerProcessingAlert[];
}

function datasetSubject(datasetKey: ProcessingDatasetKey, label: string): string {
  if (datasetKey === "providers") return "summary";
  return label.toLowerCase();
}

function processingOperationNotFoundError(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Processing operation not found" });
}

function compareByOccurredAtDescending<T extends { occurredAt: Date | string; sequence: number }>(
  left: T,
  right: T,
) {
  const timeDifference =
    new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime();
  return timeDifference === 0 ? right.sequence - left.sequence : timeDifference;
}

function latestFailedEventForDatasets<
  T extends {
    sequence: number;
    stage: ProcessingStage;
    status: ProcessingEventStatus;
    datasetKey: ProcessingDatasetKey | null;
    occurredAt: Date | string;
    errorCode: string | null;
    errorMessage: string | null;
  },
>(events: readonly T[], datasetKeys: readonly ProcessingDatasetKey[]) {
  const datasetKeySet = new Set(datasetKeys);
  return [...events]
    .filter(
      (event) =>
        event.status === "failed" &&
        (event.datasetKey === null || datasetKeySet.has(event.datasetKey)),
    )
    .sort(compareByOccurredAtDescending)[0];
}

function formatList(values: readonly string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function groupedDatasetSubject(datasets: readonly ProcessingStatusDataset[]): string {
  return formatList(datasets.map((dataset) => datasetSubject(dataset.key, dataset.label)));
}

function groupedDatasetTitle(datasets: readonly ProcessingStatusDataset[]): string {
  if (datasets.length === 1) return datasets[0]?.label ?? "";
  return formatList(
    datasets.map((dataset) =>
      dataset.key === "providers" ? "summary" : dataset.label.toLowerCase(),
    ),
  );
}

function buildProcessingAlert(
  datasets: readonly ProcessingStatusDataset[],
  operation: ProcessingStatusOperation,
): ServerProcessingAlert {
  const primaryDataset = datasets[0];
  if (!primaryDataset) {
    throw new Error("Processing alerts require at least one dataset");
  }
  const failedEvent = latestFailedEventForDatasets(
    operation.timeline,
    datasets.map((dataset) => dataset.key),
  );
  const sourceLabel = operation.providerId ? providerLabel(operation.providerId) : null;
  const subject =
    datasets.length === 1
      ? datasetSubject(primaryDataset.key, primaryDataset.label)
      : groupedDatasetSubject(datasets);
  const titleLabel =
    datasets.length === 1 ? primaryDataset.label : groupedDatasetTitle(datasets);
  const titleSuffix = datasets.length === 1 ? "wasn’t updated" : "weren’t updated";
  const occurredAt =
    failedEvent?.occurredAt ??
    datasets
      .map((dataset) => dataset.lastFailedAt ?? dataset.lastAdvancedAt)
      .find((value): value is string => value !== null) ??
    operation.createdAt;
  const datasetKeys = datasets.map((dataset) => dataset.key);
  const alertId = `${operation.id}:${datasetKeys.join(",")}`;

  if (operation.kind === "file_import") {
    const importedFile = sourceLabel ? `the ${sourceLabel} file` : "your file";
    return {
      id: alertId,
      providerId: operation.providerId,
      providerLabel: sourceLabel,
      datasetKey: primaryDataset.key,
      datasetKeys,
      occurredAt,
      title:
        failedEvent?.stage === "ingest"
          ? sourceLabel
            ? `${sourceLabel} file wasn’t imported`
            : "Your file wasn’t imported"
          : sourceLabel
            ? `${sourceLabel} ${subject} ${titleSuffix}`
            : `${titleLabel} ${titleSuffix}`,
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
        id: alertId,
        providerId: operation.providerId,
        providerLabel: sourceLabel,
        datasetKey: primaryDataset.key,
        datasetKeys,
        occurredAt,
        title: `${sourceLabel} couldn’t sync`,
        message: `Dofek couldn’t get the latest data from ${sourceLabel}. Reconnect ${sourceLabel}, then start the sync again.`,
        action: "reconnect",
        actionLabel: `Reconnect ${sourceLabel}`,
      };
    }

    return {
      id: alertId,
      providerId: operation.providerId,
      providerLabel: sourceLabel,
      datasetKey: primaryDataset.key,
      datasetKeys,
      occurredAt,
      title: `${sourceLabel} ${subject} ${titleSuffix}`,
      message:
        datasets.length === 1 && primaryDataset.key === "providers"
          ? `Your ${sourceLabel} data synced, but its totals and latest-sync information couldn’t be refreshed. Your previously synced data is still available.`
          : `Your ${sourceLabel} data synced, but Dofek couldn’t update ${subject}. Your previously synced data is still available.`,
      action: "retry_sync",
      actionLabel: `Retry ${sourceLabel} sync`,
    };
  }

  return {
    id: alertId,
    providerId: operation.providerId,
    providerLabel: sourceLabel,
    datasetKey: primaryDataset.key,
    datasetKeys,
    occurredAt,
    title: `${titleLabel} ${titleSuffix}`,
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

  async #loadDismissedOperationIds(operationIds: readonly string[]): Promise<Set<string>> {
    if (operationIds.length === 0) return new Set();
    const rows = await executeWithSchema(
      this.#database,
      dismissalRowSchema,
      sql`
        SELECT operation_id
        FROM fitness.processing_alert_dismissal
        WHERE user_id = ${this.#userId}::uuid
          AND operation_id = ANY(
            ARRAY[${sql.join(
              operationIds.map((operationId) => sql`${operationId}::uuid`),
              sql`, `,
            )}]::uuid[]
          )
      `,
    );
    return new Set(rows.map((row) => row.operation_id));
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
    const dismissedOperationIds = await this.#loadDismissedOperationIds(
      operations.map((operation) => operation.id),
    );
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
      const lastFailedEvent = relevant
        .flatMap(({ operation }) => operation.events)
        .filter(
          (event) =>
            event.status === "failed" &&
            (event.datasetKey === null || event.datasetKey === datasetKey),
        )
        .sort(compareByOccurredAtDescending)[0];
      const contract = DATASET_CONTRACTS.find((candidate) => candidate.key === datasetKey);
      if (!contract) throw new Error(`Missing processing dataset contract for ${datasetKey}`);
      return {
        key: datasetKey,
        label: contract.label,
        status: latest?.status ?? "ready",
        currentStage: latest?.currentStage ?? null,
        progressPercentage: latest?.progressPercentage ?? null,
        lastAdvancedAt: latest?.lastAdvancedAt?.toISOString() ?? null,
        lastFailedAt: lastFailedEvent?.occurredAt.toISOString() ?? null,
        lastReadyAt: lastReadyDataset?.lastAdvancedAt?.toISOString() ?? null,
      };
    });
    return {
      generatedAt: now.toISOString(),
      scope: { providerId: input.providerId ?? null, datasets: requestedDatasets },
      overallStatus: aggregateStatus(datasets.map((dataset) => dataset.status)),
      datasets,
      operations: operationsWithState.map(({ operation, state }) => {
        const operationDatasetKeys = operation.datasetKeys.filter((datasetKey) =>
          requestedDatasetSet.has(datasetKey),
        );
        const operationError = latestFailedEventForDatasets(operation.events, operationDatasetKeys);
        return {
          id: operation.id,
          providerId: operation.providerId,
          kind: operation.kind,
          createdAt: operation.createdAt.toISOString(),
          status: aggregateStatus(
            state.datasets
              .filter((dataset) => requestedDatasetSet.has(dataset.datasetKey))
              .map((dataset) => dataset.status),
          ),
          datasets: operationDatasetKeys,
          dismissed: dismissedOperationIds.has(operation.id),
          errorMessage: operationError?.errorMessage ?? null,
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
        };
      }),
    };
  }

  async alerts(): Promise<ProcessingAlertsSnapshot> {
    const snapshot = await this.status({});
    const currentOperationIdsByDataset = new Map<ProcessingDatasetKey, string>();
    for (const operation of snapshot.operations) {
      for (const datasetKey of operation.datasets) {
        if (!currentOperationIdsByDataset.has(datasetKey)) {
          currentOperationIdsByDataset.set(datasetKey, operation.id);
        }
      }
    }
    const alertableDatasets = new Map(
      snapshot.datasets
        .filter((dataset) => dataset.status === "failed" || dataset.status === "blocked")
        .map((dataset) => [dataset.key, dataset] as const),
    );
    const alerts = snapshot.operations.flatMap((operation) => {
      if (operation.dismissed) return [];
      const groupedDatasets = operation.datasets
        .filter((datasetKey) => currentOperationIdsByDataset.get(datasetKey) === operation.id)
        .map((datasetKey) => alertableDatasets.get(datasetKey))
        .filter((dataset): dataset is ProcessingStatusDataset => dataset !== undefined);
      return groupedDatasets.length === 0 ? [] : [buildProcessingAlert(groupedDatasets, operation)];
    });
    return { generatedAt: snapshot.generatedAt, alerts };
  }

  async dismiss(operationId: string): Promise<{ dismissed: true }> {
    const insertedRows = await executeWithSchema(
      this.#database,
      dismissalRowSchema,
      sql`
        INSERT INTO fitness.processing_alert_dismissal (user_id, operation_id)
        SELECT ${this.#userId}::uuid, operation.id
        FROM fitness.processing_operation operation
        WHERE operation.id = ${operationId}::uuid
          AND operation.user_id = ${this.#userId}::uuid
        ON CONFLICT (user_id, operation_id) DO NOTHING
        RETURNING operation_id
      `,
    );
    if (insertedRows.length > 0) return { dismissed: true };
    const dismissedOperationIds = await this.#loadDismissedOperationIds([operationId]);
    if (dismissedOperationIds.has(operationId)) return { dismissed: true };
    throw processingOperationNotFoundError();
  }

  async history(input: { cursor?: string | null; limit: number }) {
    return listProcessingHistory(this.#database, {
      userId: this.#userId,
      cursor: input.cursor,
      limit: input.limit,
    });
  }
}
