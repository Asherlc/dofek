import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AppRouterOutputs } from "dofek-server/router";
import { CyclingProgressionEvidence } from "./CyclingProgressionEvidence.tsx";

export const cyclingProgressionFixture: NonNullable<
  AppRouterOutputs["trainingProgression"]["cycling"]
> = {
  status: "ready",
  basis: "recorded_work_protocol",
  comparison: {
    intervalCount: 2,
    largestDurationDifferencePct: 2,
    largestMeanPowerDifferencePct: 3,
  },
  rides: [
    {
      role: "selected",
      activityId: "00000000-0000-4000-8000-000000000001",
      date: "2026-11-20",
      sessionEffort: 4,
      modality: "indoor_cycling",
      exactWorkoutIdentities: [],
      intervalCount: 2,
      intervals: [
        {
          index: 1,
          workDurationSeconds: 120,
          meanPowerWatts: 220,
          powerCoveragePct: 98,
          sourceProvider: "zwift",
          sourceActivityId: null,
          sourceMemberActivityIds: [],
        },
        {
          index: 2,
          workDurationSeconds: 180,
          meanPowerWatts: 210,
          powerCoveragePct: 96,
          sourceProvider: "zwift",
          sourceActivityId: null,
          sourceMemberActivityIds: [],
        },
      ],
      powerProvenance: {
        measurementKind: "direct",
        providers: ["zwift"],
        devices: ["kickr"],
      },
    },
    {
      role: "comparison",
      activityId: "00000000-0000-4000-8000-000000000002",
      date: "2026-11-06",
      sessionEffort: 4,
      modality: "indoor_cycling",
      exactWorkoutIdentities: [],
      intervalCount: 2,
      intervals: [
        {
          index: 1,
          workDurationSeconds: 121,
          meanPowerWatts: 218,
          powerCoveragePct: 97,
          sourceProvider: "zwift",
          sourceActivityId: null,
          sourceMemberActivityIds: [],
        },
        {
          index: 2,
          workDurationSeconds: 179,
          meanPowerWatts: 212,
          powerCoveragePct: 99,
          sourceProvider: "zwift",
          sourceActivityId: null,
          sourceMemberActivityIds: [],
        },
      ],
      powerProvenance: {
        measurementKind: "direct",
        providers: ["zwift"],
        devices: ["kickr"],
      },
    },
  ],
};

const meta = {
  title: "Training/CyclingProgressionEvidence",
  component: CyclingProgressionEvidence,
  args: { result: cyclingProgressionFixture },
} satisfies Meta<typeof CyclingProgressionEvidence>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ComparableRides: Story = {};
