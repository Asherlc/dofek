import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunningDynamics } from "./RunningDynamics.tsx";
import {
  emptyRunning,
  emptyRunningForm,
  intervalRun,
  runningData,
} from "./running-dynamics-test-helpers.ts";

const meta = {
  title: "Training/RunningDynamics",
  component: RunningDynamics,
  args: { data: runningData, loading: false, error: null },
} satisfies Meta<typeof RunningDynamics>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RecordedAndIntervals: Story = {};
export const PartialCoverage: Story = { args: { data: { ...runningData, data: [intervalRun] } } };
export const MissingCadence: Story = {
  args: {
    data: {
      ...runningData,
      data: [
        {
          ...intervalRun,
          cadence: null,
          cadenceBasis: "unknown",
          cadenceCoveragePercent: null,
          cadenceObservedSeconds: null,
          paceSecondsPerKm: null,
          distanceKm: null,
        },
      ],
      cadenceAvailability: emptyRunning,
    },
  },
};
export const Empty: Story = {
  args: { data: { data: [], availability: emptyRunningForm, cadenceAvailability: emptyRunning } },
};
export const Loading: Story = { args: { data: undefined, loading: true } };
export const RefetchError: Story = {
  args: {
    loading: true,
    error: new Error("Running analytics is refreshing. Retry after sync finishes."),
  },
};
export const InitialError: Story = {
  args: {
    data: undefined,
    error: new Error("Running analytics requires the activity store. Retry after sync finishes."),
  },
};

export const MalformedResponse: Story = {
  args: { data: { data: runningData.data, availability: runningData.availability } },
};
export const MalformedResponseWithError: Story = {
  args: { data: null, error: new Error("Running sync is still processing. Try again shortly.") },
};
