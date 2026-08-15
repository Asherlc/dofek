import { providerLabel } from "./providers.ts";

export type ProcessingDisplayStatus =
  | "ready"
  | "waiting"
  | "active"
  | "partial"
  | "delayed"
  | "blocked"
  | "failed"
  | "cancelled";

export type ProcessingDisplayStage =
  | "ingest"
  | "canonical_commit"
  | "cdc"
  | "analytics"
  | "cache_refresh";

export interface ProcessingTarget {
  action: "import" | "recompute" | "sync";
  label: string;
}

function activeHeading(target: ProcessingTarget): string {
  switch (target.action) {
    case "import":
      return `Importing ${target.label}`;
    case "recompute":
      return `Recomputing ${target.label}`;
    case "sync":
      return `Syncing ${target.label}`;
  }
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function processingHeading(
  status: ProcessingDisplayStatus,
  target?: ProcessingTarget,
): string {
  if (target) {
    switch (status) {
      case "failed":
      case "blocked":
        return `${capitalize(target.label)} ${target.action} didn’t finish`;
      case "delayed":
        return `${activeHeading(target)} is taking longer than expected`;
      case "active":
      case "partial":
        return activeHeading(target);
      case "waiting":
        return `Preparing to ${target.action} ${target.label}`;
      case "cancelled":
        return `${capitalize(target.label)} ${target.action} was cancelled`;
      case "ready":
        return `${capitalize(target.label)} ${target.action} complete`;
    }
  }
  switch (status) {
    case "failed":
    case "blocked":
      return "Your data update didn’t finish";
    case "delayed":
      return "Processing is taking longer than expected";
    case "active":
      return "Updating your data";
    case "partial":
      return "Finishing your data update";
    case "waiting":
      return "Preparing to update your data";
    case "cancelled":
      return "Processing was cancelled";
    case "ready":
      return "Data is ready";
  }
}

interface ProcessingTargetDataset {
  key: string;
  label: string;
  status: ProcessingDisplayStatus;
}

function formatList(items: readonly string[]): string {
  if (items.length === 0) return "your data";
  if (items.length === 1) return items[0] ?? "your data";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function datasetTarget(dataset: ProcessingTargetDataset): string {
  if (dataset.key === "providers") {
    return "provider summaries";
  }
  return dataset.label.toLowerCase();
}

export function processingTarget(input: {
  providerId: string | null;
  datasets: readonly ProcessingTargetDataset[];
  operationKind?: string | null;
}): ProcessingTarget {
  if (input.providerId) {
    return {
      action: input.operationKind === "file_import" ? "import" : "sync",
      label: providerLabel(input.providerId),
    };
  }

  const unfinishedDatasets = input.datasets.filter((dataset) => dataset.status !== "ready");
  const relevantDatasets = unfinishedDatasets.length > 0 ? unfinishedDatasets : input.datasets;
  const targets = [...new Set(relevantDatasets.map(datasetTarget))];

  return { action: "recompute", label: formatList(targets) };
}

export function processingStatusMessage(input: {
  status: ProcessingDisplayStatus;
  errorMessage: string | null;
}): string | null {
  if ((input.status === "failed" || input.status === "blocked") && input.errorMessage) {
    return input.errorMessage;
  }
  switch (input.status) {
    case "delayed":
      return "Your existing data is still available.";
    case "failed":
    case "blocked":
      return "Try the update again. If it still fails, reconnect the data source.";
    case "partial":
    case "active":
    case "waiting":
      return null;
    case "cancelled":
      return "Start the update again when you are ready.";
    case "ready":
      return null;
  }
}

export function processingPollInterval(status: ProcessingDisplayStatus): number {
  if (status === "active" || status === "partial" || status === "waiting") return 3_000;
  return 15_000;
}

export function processingAggregateProgress(
  datasets: readonly {
    status: ProcessingDisplayStatus;
    progressPercentage: number | null;
  }[],
): number | null {
  const progressValues = datasets.flatMap((dataset) => {
    if (dataset.status === "ready") return [100];
    return dataset.progressPercentage === null ? [] : [dataset.progressPercentage];
  });
  if (progressValues.length === 0 || progressValues.length !== datasets.length) return null;
  return Math.min(...progressValues);
}

interface ProcessingFailureDataset {
  key: string;
  label: string;
  status: ProcessingDisplayStatus;
  lastFailedAt: string | null;
  lastReadyAt: string | null;
}

interface ProcessingFailureOperation {
  id: string;
  providerId: string | null;
  status: ProcessingDisplayStatus;
  datasets: readonly string[];
  dismissed: boolean;
  errorMessage: string | null;
  errorCode?: string | null;
}

export interface ProcessingFailureGroup {
  operationId: string;
  providerId: string | null;
  providerLabel: string | null;
  datasetLabels: string[];
  status: "blocked" | "failed";
  failedAt: string | null;
  lastReadyAt: string | null;
  errorMessage: string | null;
  requiresReconnect: boolean;
  dismissed: boolean;
}

function isFailureStatus(status: ProcessingDisplayStatus): status is "blocked" | "failed" {
  return status === "blocked" || status === "failed";
}

function latestTimestamp(values: readonly (string | null)[]): string | null {
  return (
    values
      .filter((value): value is string => value !== null)
      .sort((left, right) => right.localeCompare(left))[0] ?? null
  );
}

export function processingFailureGroups(input: {
  datasets: readonly ProcessingFailureDataset[];
  operations: readonly ProcessingFailureOperation[];
}): ProcessingFailureGroup[] {
  const currentOperationIdsByDataset = new Map<string, string>();
  for (const operation of input.operations) {
    for (const datasetKey of operation.datasets) {
      if (!currentOperationIdsByDataset.has(datasetKey)) {
        currentOperationIdsByDataset.set(datasetKey, operation.id);
      }
    }
  }

  const alertableDatasets = input.datasets.filter((dataset) => isFailureStatus(dataset.status));
  return input.operations.flatMap((operation) => {
    if (operation.dismissed || !isFailureStatus(operation.status)) return [];
    const operationDatasetKeys = new Set(operation.datasets);
    const groupedDatasets = alertableDatasets.filter(
      (dataset) =>
        operationDatasetKeys.has(dataset.key) &&
        currentOperationIdsByDataset.get(dataset.key) === operation.id,
    );
    if (groupedDatasets.length === 0) return [];

    return [
      {
        operationId: operation.id,
        providerId: operation.providerId,
        providerLabel: operation.providerId ? providerLabel(operation.providerId) : null,
        datasetLabels: groupedDatasets.map((dataset) => dataset.label),
        status: operation.status,
        failedAt: latestTimestamp(groupedDatasets.map((dataset) => dataset.lastFailedAt)),
        lastReadyAt: latestTimestamp(groupedDatasets.map((dataset) => dataset.lastReadyAt)),
        errorMessage: operation.errorMessage,
        requiresReconnect: operation.errorCode === "provider_auth_failed",
        dismissed: operation.dismissed,
      },
    ];
  });
}

export function processingDatasetStatusLabel(status: ProcessingDisplayStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "waiting":
      return "Waiting";
    case "active":
      return "Updating";
    case "partial":
      return "Finishing";
    case "delayed":
      return "Delayed";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}
