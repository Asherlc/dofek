import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-native";
import { RunningTrainingCard } from "./RunningTrainingCard";
import {
  emptyRunning,
  emptyRunningForm,
  intervalRun,
  recordedRun,
  runningData,
} from "./running-training-test-helpers";

const meta = {
  title: "Training/RunningTrainingCard",
  component: RunningTrainingCard,
  args: {
    data: runningData,
    loading: false,
    error: null,
    units: new UnitConverter("metric"),
    onOpenActivity: () => {},
  },
} satisfies Meta<typeof RunningTrainingCard>;
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
    error: new Error("Running analytics is refreshing. Pull to refresh to retry."),
  },
};
export const InitialError: Story = {
  args: {
    data: undefined,
    error: new Error("Running analytics requires the activity store. Retry after sync finishes."),
  },
};

export const IsolatedCadence: Story = {
  args: {
    data: {
      ...runningData,
      data: [
        recordedRun,
        {
          ...recordedRun,
          activityId: "form-only",
          date: "2026-10-02",
          activityName: "Form only",
          cadence: null,
          cadenceBasis: "unknown",
          cadenceObservedSeconds: null,
          cadenceCoveragePercent: null,
        },
        intervalRun,
      ],
    },
  },
};
export const ZeroCadence: Story = {
  args: {
    data: {
      ...runningData,
      data: [{ ...intervalRun, cadence: 0, cadenceCoveragePercent: 100 }],
      cadenceAvailability: { ...runningData.cadenceAvailability, observedCount: 1 },
    },
  },
};

export const MalformedResponse: Story = {
  args: { data: { data: runningData.data, availability: runningData.availability } },
};
export const MalformedResponseWithError: Story = {
  args: { data: null, error: new Error("Running sync is still processing. Try again shortly.") },
};
