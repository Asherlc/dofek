import type { QueryClient } from "@tanstack/react-query";
import type { inferRouterClient, OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";

type ScreenshotProcessingDataset = "activity" | "sleep" | "recovery" | "training" | "body";
type AppRouterClient = inferRouterClient<AppRouter>;
type ProcessingStatusStoryCompanionResponses = {
  "training.hrZones"?: Awaited<ReturnType<AppRouterClient["training"]["hrZones"]["query"]>>;
  "efficiency.polarizationTrend"?: Awaited<
    ReturnType<AppRouterClient["efficiency"]["polarizationTrend"]["query"]>
  >;
  "cyclingAdvanced.trainingMonotony"?: Awaited<
    ReturnType<AppRouterClient["cyclingAdvanced"]["trainingMonotony"]["query"]>
  >;
};
type ProcessingStatusStoryCompanionPath = keyof ProcessingStatusStoryCompanionResponses;

const PROCESSING_STATUS_STORY_COMPANION_PATHS = [
  "training.hrZones",
  "efficiency.polarizationTrend",
  "cyclingAdvanced.trainingMonotony",
] satisfies readonly ProcessingStatusStoryCompanionPath[];

function isProcessingStatusStoryCompanionPath(
  path: string,
): path is ProcessingStatusStoryCompanionPath {
  return PROCESSING_STATUS_STORY_COMPANION_PATHS.some((companionPath) => companionPath === path);
}

const DATASET_LABELS = {
  activity: "Activities",
  sleep: "Sleep",
  recovery: "Recovery",
  training: "Training",
  body: "Body",
} satisfies Record<ScreenshotProcessingDataset, string>;

interface ProcessingStatusStorySnapshot {
  generatedAt: string;
  scope: {
    providerId: null;
    datasets: ScreenshotProcessingDataset[];
  };
  overallStatus: "ready";
  datasets: Array<{
    key: ScreenshotProcessingDataset;
    label: string;
    status: "ready";
    currentStage: null;
    progressPercentage: null;
    lastAdvancedAt: null;
    lastReadyAt: string;
  }>;
  operations: [];
}

export function seedReadyProcessingStatus(
  queryClient: QueryClient,
  datasets: readonly ScreenshotProcessingDataset[],
): ProcessingStatusStorySnapshot {
  const generatedAt = new Date().toISOString();
  const snapshot: ProcessingStatusStorySnapshot = {
    generatedAt,
    scope: { providerId: null, datasets: [...datasets] },
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
  };

  queryClient.setQueryData(
    [["processing", "status"], { input: { datasets }, type: "query" }],
    snapshot,
  );
  return snapshot;
}

export function createProcessingStatusStoryLink(
  snapshot: ProcessingStatusStorySnapshot,
  companionResponses: Readonly<ProcessingStatusStoryCompanionResponses> = {},
): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          let data: unknown;
          if (op.path === "processing.status") {
            data = snapshot;
          } else if (
            isProcessingStatusStoryCompanionPath(op.path) &&
            Object.hasOwn(companionResponses, op.path)
          ) {
            data = companionResponses[op.path];
          } else {
            throw new Error(`Unhandled processing-status story tRPC operation: ${op.path}`);
          }
          observer.next?.({ result: { data } });
          observer.complete?.();
          return { unsubscribe: () => {} };
        },
        pipe() {
          return result;
        },
      };
      return result;
    };
}
