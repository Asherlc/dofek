import type { Meta, StoryObj } from "@storybook/react-vite";
import { CyclingDecouplingChart } from "./CyclingDecouplingChart.tsx";

const workoutName = "Endurance 60";
const rides = [
  { activityId: "ride-1", date: "2026-10-18", percent: 6.4, secondHalfWatts: 187.2 },
  { activityId: "ride-2", date: "2026-10-25", percent: 3.2, secondHalfWatts: 193.6 },
  { activityId: "ride-3", date: "2026-11-08", percent: -1.1, secondHalfWatts: 202.2 },
].map(({ secondHalfWatts, ...ride }) => ({
  ...ride,
  name: workoutName,
  elapsedSeconds: 3600,
  modality: null,
  method: "equal_elapsed_time_halves_power_to_heart_rate" as const,
  powerMeasurementKind: "direct" as const,
  heartRateMeasurementKind: "unknown" as const,
  firstHalf: { meanWatts: 200, meanBpm: 131, pairedSeconds: 1782, coveragePct: 99 },
  secondHalf: { meanWatts: secondHalfWatts, meanBpm: 131, pairedSeconds: 1746, coveragePct: 97 },
}));

const meta = {
  title: "Training/CyclingDecouplingChart",
  component: CyclingDecouplingChart,
  args: { data: { workoutName, rides } },
  decorators: [
    (Story) => (
      <div className="max-w-3xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CyclingDecouplingChart>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = { args: { data: undefined, loading: true } };
export const Empty: Story = { args: { data: { workoutName: null, rides: [] } } };
