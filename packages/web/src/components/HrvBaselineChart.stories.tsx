import type { Meta, StoryObj } from "@storybook/react-vite";
import { HrvBaselineChart } from "./HrvBaselineChart.tsx";

const baselineData = [
  {
    date: "2026-05-27",
    hrv: 58,
    resting_hr: 54,
    mean_60d: 55,
    sd_60d: 7,
    mean_7d: 54,
    resting_hr_mean_7d: 55,
  },
  {
    date: "2026-05-28",
    hrv: 61,
    resting_hr: 53,
    mean_60d: 55,
    sd_60d: 7,
    mean_7d: 56,
    resting_hr_mean_7d: 54,
  },
  {
    date: "2026-05-29",
    hrv: 49,
    resting_hr: 57,
    mean_60d: 55,
    sd_60d: 7,
    mean_7d: 55,
    resting_hr_mean_7d: 55,
  },
  {
    date: "2026-05-30",
    hrv: 64,
    resting_hr: 52,
    mean_60d: 56,
    sd_60d: 7,
    mean_7d: 57,
    resting_hr_mean_7d: 54,
  },
  {
    date: "2026-05-31",
    hrv: 67,
    resting_hr: 51,
    mean_60d: 56,
    sd_60d: 7,
    mean_7d: 59,
    resting_hr_mean_7d: 53,
  },
];

const meta = {
  title: "Recovery/HrvBaselineChart",
  component: HrvBaselineChart,
  tags: ["autodocs"],
  args: { data: baselineData },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HrvBaselineChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
export const EstablishingBaseline: Story = {
  args: {
    data: baselineData.slice(0, 3).map((row) => ({
      ...row,
      mean_60d: null,
      sd_60d: null,
      mean_7d: null,
      resting_hr_mean_7d: null,
    })),
  },
};
