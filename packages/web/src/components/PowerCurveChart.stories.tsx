import type { Meta, StoryObj } from "@storybook/react-vite";
import { PowerCurveChart } from "./PowerCurveChart.tsx";

const currentCurve = [
  { durationSeconds: 5, label: "5 sec", bestPower: 980, activityDate: "2026-05-18" },
  { durationSeconds: 30, label: "30 sec", bestPower: 640, activityDate: "2026-05-18" },
  { durationSeconds: 60, label: "1 min", bestPower: 520, activityDate: "2026-05-25" },
  { durationSeconds: 300, label: "5 min", bestPower: 355, activityDate: "2026-05-25" },
  { durationSeconds: 1_200, label: "20 min", bestPower: 281, activityDate: "2026-06-01" },
  { durationSeconds: 3_600, label: "1 hour", bestPower: 246, activityDate: "2026-06-01" },
];

const previousCurve = [
  { durationSeconds: 5, label: "5 sec", bestPower: 921, activityDate: "2026-03-30" },
  { durationSeconds: 30, label: "30 sec", bestPower: 602, activityDate: "2026-03-30" },
  { durationSeconds: 60, label: "1 min", bestPower: 489, activityDate: "2026-03-30" },
  { durationSeconds: 300, label: "5 min", bestPower: 334, activityDate: "2026-03-30" },
  { durationSeconds: 1_200, label: "20 min", bestPower: 264, activityDate: "2026-03-30" },
  { durationSeconds: 3_600, label: "1 hour", bestPower: 231, activityDate: "2026-03-30" },
];

const meta = {
  title: "Training/PowerCurveChart",
  component: PowerCurveChart,
  tags: ["autodocs"],
  args: {
    data: currentCurve,
    comparisonData: previousCurve,
    model: { cp: 258, wPrime: 18_500, r2: 0.93 },
  },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PowerCurveChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [], comparisonData: [], model: null } };
export const BestPowerOnly: Story = {
  args: { comparisonData: [], model: null },
};
