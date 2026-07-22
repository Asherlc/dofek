import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  type ProcessingStatusSnapshot,
  ProcessingStatusWidget,
} from "./ProcessingStatusWidget.tsx";

const activeSnapshot: ProcessingStatusSnapshot = {
  generatedAt: "2026-07-22T12:00:00.000Z",
  scope: { providerId: "kaya", datasets: ["activity"] },
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
    },
  ],
  operations: [
    {
      id: "00000000-0000-4000-8000-000000001852",
      providerId: "kaya",
      kind: "provider_sync",
      createdAt: "2026-07-22T11:58:00.000Z",
      status: "active",
      datasets: ["activity"],
      timeline: [
        {
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

const meta = {
  title: "State/ProcessingStatusWidget",
  component: ProcessingStatusWidget,
  decorators: [(Story) => <div className="w-[760px] p-4">{Story()}</div>],
  args: { data: activeSnapshot },
} satisfies Meta<typeof ProcessingStatusWidget>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Active: Story = {};
export const Delayed: Story = { args: { data: { ...activeSnapshot, overallStatus: "delayed" } } };
export const Partial: Story = { args: { data: { ...activeSnapshot, overallStatus: "partial" } } };
export const Failed: Story = { args: { data: { ...activeSnapshot, overallStatus: "failed" } } };
export const Ready: Story = {
  args: { data: { ...activeSnapshot, overallStatus: "ready" }, alwaysVisible: true },
};
export const EmptyHistory: Story = {
  args: { data: { ...activeSnapshot, operations: [] }, alwaysVisible: true },
};
export const Loading: Story = { args: { data: undefined, loading: true } };
export const ApiError: Story = { args: { data: undefined, error: new Error("Please try again.") } };
