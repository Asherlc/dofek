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

export function processingHeading(status: ProcessingDisplayStatus): string {
  switch (status) {
    case "failed":
    case "blocked":
      return "Your data update didn’t finish";
    case "delayed":
      return "Processing is taking longer than expected";
    case "active":
      return "Updating your data";
    case "partial":
      return "Some data is ready";
    case "waiting":
      return "Preparing to update your data";
    case "cancelled":
      return "Processing was cancelled";
    case "ready":
      return "Data is ready";
  }
}

export function processingStatusMessage(input: {
  status: ProcessingDisplayStatus;
  errorMessage: string | null;
}): string {
  if ((input.status === "failed" || input.status === "blocked") && input.errorMessage) {
    return input.errorMessage;
  }
  switch (input.status) {
    case "delayed":
      return "This update is taking longer than usual. Your existing data is still available.";
    case "failed":
    case "blocked":
      return "Try the update again. If it still fails, reconnect the data source.";
    case "partial":
      return "Ready sections are available while the remaining data finishes updating.";
    case "active":
    case "waiting":
      return "Your existing data stays available while this update finishes.";
    case "cancelled":
      return "Start the update again when you are ready.";
    case "ready":
      return "Everything is up to date.";
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

export function processingCurrentFailure(input: {
  datasets: readonly { key: string }[];
  operations: readonly {
    id: string;
    datasets: readonly string[];
    timeline: readonly {
      status: string;
      occurredAt: string;
      errorMessage: string | null;
    }[];
  }[];
}): string | null {
  const currentOperationIds = new Set<string>();
  for (const dataset of input.datasets) {
    const currentOperation = input.operations.find((operation) =>
      operation.datasets.includes(dataset.key),
    );
    if (currentOperation) currentOperationIds.add(currentOperation.id);
  }
  return (
    input.operations
      .filter((operation) => currentOperationIds.has(operation.id))
      .flatMap((operation) => operation.timeline)
      .filter((event) => event.status === "failed" && event.errorMessage !== null)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0]?.errorMessage ??
    null
  );
}
