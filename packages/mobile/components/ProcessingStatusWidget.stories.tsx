import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { type ReactNode, useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { type ProcessingStatusSnapshot, ProcessingStatusWidget } from "./ProcessingStatusWidget";

const activeSnapshot: ProcessingStatusSnapshot = {
  generatedAt: "2026-07-22T12:00:00.000Z",
  scope: { providerId: "garmin", datasets: ["activity"] },
  overallStatus: "active",
  datasets: [
    {
      key: "activity",
      label: "Activities",
      status: "active",
      currentStage: "analytics",
      progressPercentage: 60,
      lastAdvancedAt: "2026-07-22T11:59:00.000Z",
      lastReadyAt: "2026-07-21T12:00:00.000Z",
      lastFailedAt: null,
    },
  ],
  operations: [
    {
      id: "00000000-0000-4000-8000-000000001852",
      providerId: "garmin",
      kind: "provider_sync",
      createdAt: "2026-07-22T11:58:00.000Z",
      status: "active",
      datasets: ["activity"],
      dismissed: false,
      errorMessage: null,
      timeline: [
        {
          sequence: 1,
          stage: "ingest",
          status: "succeeded",
          datasetKey: "activity",
          outputPath: null,
          occurredAt: "2026-07-22T11:58:30.000Z",
          progressPercentage: 100,
          message: null,
          errorCode: null,
          errorMessage: null,
        },
      ],
    },
  ],
};
const activeDataset = activeSnapshot.datasets.at(0);
if (!activeDataset) throw new Error("Expected the processing story to include a dataset");
const activeOperation = activeSnapshot.operations.at(0);
if (!activeOperation) throw new Error("Expected the processing story to include an operation");
const activeTimelineEvent = activeOperation.timeline.at(0);
if (!activeTimelineEvent) throw new Error("Expected the processing story to include an event");

function createMockLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          if (op.path !== "processing.dismiss") {
            throw new Error(`Unhandled processing status story tRPC operation: ${op.path}`);
          }
          observer.next?.({ result: { data: { dismissed: true } } });
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

function StoryFrame({ children }: { children: ReactNode }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink()] }), []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ width: 360, padding: 16 }}>{children}</View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "State/ProcessingStatusWidget",
  component: ProcessingStatusWidget,
  decorators: [(Story) => <StoryFrame>{Story()}</StoryFrame>],
  args: { data: activeSnapshot },
} satisfies Meta<typeof ProcessingStatusWidget>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Active: Story = {
  name: "Processing",
  tags: ["review-scenario", "review-scenario-processing"],
};
export const SleepUpdate: Story = {
  name: "Sleep update",
  args: {
    data: {
      ...activeSnapshot,
      scope: { providerId: null, datasets: ["sleep"] },
      datasets: [
        {
          ...activeDataset,
          key: "sleep",
          label: "Sleep",
        },
      ],
    },
  },
};
export const TrainingUpdate: Story = {
  name: "Training update",
  args: {
    data: {
      ...activeSnapshot,
      scope: { providerId: null, datasets: ["training"] },
      datasets: [
        {
          ...activeDataset,
          key: "training",
          label: "Training",
        },
      ],
    },
  },
};
export const Delayed: Story = { args: { data: { ...activeSnapshot, overallStatus: "delayed" } } };
export const Partial: Story = {
  name: "Partial data",
  tags: ["review-scenario", "review-scenario-partial-data"],
  args: { data: { ...activeSnapshot, overallStatus: "partial" } },
};
export const Failed: Story = {
  args: {
    data: {
      ...activeSnapshot,
      overallStatus: "failed",
      datasets: [
        {
          ...activeDataset,
          status: "failed",
          progressPercentage: null,
          lastFailedAt: "2026-07-22T12:05:00.000Z",
        },
      ],
      operations: [
        {
          ...activeOperation,
          status: "failed",
          dismissed: false,
          errorMessage: "Reconnect Garmin, then start the sync again.",
          timeline: [
            {
              ...activeTimelineEvent,
              status: "failed",
              errorMessage: "Reconnect Garmin, then start the sync again.",
            },
          ],
        },
      ],
    },
  },
};
export const Ready: Story = {
  args: {
    data: {
      ...activeSnapshot,
      overallStatus: "ready",
      datasets: [
        {
          ...activeDataset,
          status: "ready",
          progressPercentage: 100,
          lastReadyAt: "2026-07-22T12:00:00.000Z",
        },
      ],
    },
    alwaysVisible: true,
  },
};
export const EmptyHistory: Story = {
  args: { data: { ...activeSnapshot, operations: [] }, alwaysVisible: true },
};
export const Loading: Story = { args: { data: undefined, loading: true } };
export const ApiError: Story = { args: { data: undefined, error: new Error("Please try again.") } };
