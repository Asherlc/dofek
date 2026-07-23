export type ProcessingDisplayStatus =
  | "ready"
  | "waiting"
  | "active"
  | "partial"
  | "delayed"
  | "blocked"
  | "failed"
  | "cancelled";

const stageLabels = {
  ingest: "Receiving data",
  canonical_commit: "Saving data",
  cdc: "Preparing data",
  analytics: "Updating insights",
  cache_refresh: "Refreshing screens",
} as const;

export type ProcessingDisplayStage = keyof typeof stageLabels;

export function processingStageLabel(stage: ProcessingDisplayStage): string {
  return stageLabels[stage];
}

export function processingHeading(status: ProcessingDisplayStatus): string {
  switch (status) {
    case "failed":
    case "blocked":
      return "Processing needs attention";
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
