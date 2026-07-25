import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PolarizationWeek } from "dofek-server/types";
import { PolarizationTrendChart } from "./PolarizationTrendChart.tsx";

const weeks: PolarizationWeek[] = [
  {
    week: "2026-04-27",
    z1Seconds: 18_600,
    z2Seconds: 4_200,
    z3Seconds: 2_400,
    polarizationIndex: 2.34,
  },
  {
    week: "2026-05-04",
    z1Seconds: 16_800,
    z2Seconds: 5_400,
    z3Seconds: 2_100,
    polarizationIndex: 1.72,
  },
  {
    week: "2026-05-11",
    z1Seconds: 21_600,
    z2Seconds: 3_600,
    z3Seconds: 2_700,
    polarizationIndex: 2.61,
  },
  {
    week: "2026-05-18",
    z1Seconds: 19_200,
    z2Seconds: 4_500,
    z3Seconds: 2_400,
    polarizationIndex: 2.08,
  },
  {
    week: "2026-05-25",
    z1Seconds: 22_500,
    z2Seconds: 3_300,
    z3Seconds: 3_000,
    polarizationIndex: 2.82,
  },
];

const meta = {
  title: "Training/PolarizationTrendChart",
  component: PolarizationTrendChart,
  tags: ["autodocs"],
  args: { weeks, maxHr: 192 },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PolarizationTrendChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { weeks: [], maxHr: null, loading: true } };
export const Empty: Story = { args: { weeks: [], maxHr: null } };
export const IncompleteZoneCoverage: Story = {
  args: {
    weeks: [
      ...weeks.slice(0, 2),
      {
        week: "2026-05-11",
        z1Seconds: 19_800,
        z2Seconds: 0,
        z3Seconds: 1_800,
        polarizationIndex: null,
      },
      ...weeks.slice(3),
    ],
  },
};
