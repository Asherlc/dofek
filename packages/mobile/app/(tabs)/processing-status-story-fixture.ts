import type { QueryClient } from "@tanstack/react-query";

type ScreenshotProcessingDataset = "activity" | "sleep" | "recovery" | "training" | "body";

const DATASET_LABELS = {
  activity: "Activities",
  sleep: "Sleep",
  recovery: "Recovery",
  training: "Training",
  body: "Body",
} satisfies Record<ScreenshotProcessingDataset, string>;

export function seedReadyProcessingStatus(
  queryClient: QueryClient,
  datasets: readonly ScreenshotProcessingDataset[],
): void {
  const generatedAt = new Date().toISOString();

  queryClient.setQueryData([["processing", "status"], { input: { datasets }, type: "query" }], {
    generatedAt,
    scope: { providerId: null, datasets },
    overallStatus: "ready",
    datasets: datasets.map((key) => ({
      key,
      label: DATASET_LABELS[key],
      status: "ready",
      currentStage: null,
      progressPercentage: null,
      lastAdvancedAt: null,
      lastReadyAt: generatedAt,
    })),
    operations: [],
  });
}
