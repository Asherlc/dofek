import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PolarizationWeek } from "dofek-server/types";
import { PolarizationTrendChart } from "./PolarizationTrendChart.tsx";

const method = {
  formula:
    "Polarization index = log10((easy-zone fraction / threshold-zone fraction) × high-zone fraction × 100).",
  zoneBasis:
    "Easy zone (Zone 1) is below 80%, threshold zone (Zone 2) is 80–<90%, and high zone (Zone 3) is at least 90% of maximum heart rate.",
  calculationChoice:
    "Dofek requires recorded time in all three zones and does not calculate the polarization index when high-zone time exceeds easy-zone time.",
  interpretation:
    "The >2.00 comparison is Treff's descriptive training-distribution heuristic, not a physiological or medical assessment.",
  source: {
    title: "Treff et al. (2019), The Polarization-Index",
    url: "https://doi.org/10.3389/fphys.2019.00707",
  },
};

const weeks: PolarizationWeek[] = [
  {
    week: "2026-04-27",
    z1Seconds: 18_600,
    z2Seconds: 4_200,
    z3Seconds: 2_400,
    polarizationIndex: 1.625,
    totalSeconds: 25_200,
    zonePercentages: { z1: 73.8, z2: 16.7, z3: 9.5 },
    status: "not_polarized",
    statusLabel: "Does not match polarized-pattern heuristic",
    explanation:
      "This week's recorded cycling distribution is at or below Treff's descriptive 2.00 heuristic. It is not a physiological or medical assessment.",
  },
  {
    week: "2026-05-04",
    z1Seconds: 16_800,
    z2Seconds: 5_400,
    z3Seconds: 2_100,
    polarizationIndex: 1.43,
    totalSeconds: 24_300,
    zonePercentages: { z1: 69.1, z2: 22.2, z3: 8.6 },
    status: "not_polarized",
    statusLabel: "Does not match polarized-pattern heuristic",
    explanation:
      "This week's recorded cycling distribution is at or below Treff's descriptive 2.00 heuristic. It is not a physiological or medical assessment.",
  },
  {
    week: "2026-05-11",
    z1Seconds: 21_600,
    z2Seconds: 3_600,
    z3Seconds: 2_700,
    polarizationIndex: 1.764,
    totalSeconds: 27_900,
    zonePercentages: { z1: 77.4, z2: 12.9, z3: 9.7 },
    status: "not_polarized",
    statusLabel: "Does not match polarized-pattern heuristic",
    explanation:
      "This week's recorded cycling distribution is at or below Treff's descriptive 2.00 heuristic. It is not a physiological or medical assessment.",
  },
  {
    week: "2026-05-18",
    z1Seconds: 19_200,
    z2Seconds: 4_500,
    z3Seconds: 2_400,
    polarizationIndex: 1.594,
    totalSeconds: 26_100,
    zonePercentages: { z1: 73.6, z2: 17.2, z3: 9.2 },
    status: "not_polarized",
    statusLabel: "Does not match polarized-pattern heuristic",
    explanation:
      "This week's recorded cycling distribution is at or below Treff's descriptive 2.00 heuristic. It is not a physiological or medical assessment.",
  },
  {
    week: "2026-05-25",
    z1Seconds: 22_500,
    z2Seconds: 3_300,
    z3Seconds: 3_000,
    polarizationIndex: 1.851,
    totalSeconds: 28_800,
    zonePercentages: { z1: 78.1, z2: 11.5, z3: 10.4 },
    status: "not_polarized",
    statusLabel: "Does not match polarized-pattern heuristic",
    explanation:
      "This week's recorded cycling distribution is at or below Treff's descriptive 2.00 heuristic. It is not a physiological or medical assessment.",
  },
];

const meta = {
  title: "Training/PolarizationTrendChart",
  component: PolarizationTrendChart,
  tags: ["autodocs"],
  args: { weeks, maxHr: 192, threshold: 2, method },
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
export const Loading: Story = { args: { weeks: [], maxHr: null, method, loading: true } };
export const Empty: Story = { args: { weeks: [], maxHr: null, method } };
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
        totalSeconds: 21_600,
        zonePercentages: { z1: 91.7, z2: 0, z3: 8.3 },
        status: "insufficient_data",
        statusLabel: "Not calculated",
        explanation:
          "The index is not calculated because Dofek requires recorded cycling time in all three Treff heart-rate zones.",
      },
      ...weeks.slice(3),
    ],
  },
};
