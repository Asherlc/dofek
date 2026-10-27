import type { Meta, StoryObj } from "@storybook/react-vite";
import type { HrvVariabilityRow } from "dofek-server/types";
import { HrvVariabilityChart } from "./HrvVariabilityChart.tsx";

const variabilityData: HrvVariabilityRow[] = [
  { date: "2026-05-25", hrv: 58, rollingCoefficientOfVariation: 4.2, rollingMean: 56 },
  { date: "2026-05-26", hrv: 61, rollingCoefficientOfVariation: 4.8, rollingMean: 57 },
  { date: "2026-05-27", hrv: 54, rollingCoefficientOfVariation: 6.1, rollingMean: 57 },
  { date: "2026-05-28", hrv: 63, rollingCoefficientOfVariation: 7.4, rollingMean: 58 },
  { date: "2026-05-29", hrv: 49, rollingCoefficientOfVariation: 10.8, rollingMean: 57 },
  { date: "2026-05-30", hrv: 65, rollingCoefficientOfVariation: 11.6, rollingMean: 58 },
  { date: "2026-05-31", hrv: 60, rollingCoefficientOfVariation: 9.2, rollingMean: 59 },
];

const meta = {
  title: "Recovery/HrvVariabilityChart",
  component: HrvVariabilityChart,
  tags: ["autodocs"],
  args: { data: variabilityData },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HrvVariabilityChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
export const SparseReadings: Story = {
  args: {
    data: variabilityData.map((row, index) =>
      index % 2 === 0 ? row : { ...row, hrv: null, rollingCoefficientOfVariation: null },
    ),
  },
};
