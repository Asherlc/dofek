import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PolarizationWeek } from "dofek-server/types";
import { PolarizationTrendChart } from "./PolarizationTrendChart.tsx";

const method = {
  formula:
    "Polarization index = log10((easy-zone fraction / threshold-zone fraction) × high-zone fraction × 100).",
  zoneBasis:
    "Dofek uses profile maximum heart rate as a proxy for intensity. The easy zone is below 80%, the middle zone is 80–<90%, and the high zone is at least 90% of that value.",
  calculationChoice:
    "Treff defines zero when there is coverage and no high-zone time. With zero middle-zone time, the high-zone share must exceed 1% for the adjustment.",
  interpretation: "The >2.00 comparison is Treff's descriptive training-distribution heuristic.",
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
      "This week's recorded cycling distribution is at or below Treff's descriptive 2.00 heuristic.",
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
      "This week's recorded cycling distribution is at or below Treff's descriptive 2.00 heuristic.",
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
      "This week's recorded cycling distribution is at or below Treff's descriptive 2.00 heuristic.",
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
      "This week's recorded cycling distribution is at or below Treff's descriptive 2.00 heuristic.",
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
      "This week's recorded cycling distribution is at or below Treff's descriptive 2.00 heuristic.",
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
        z1Seconds: 21_420,
        z2Seconds: 0,
        z3Seconds: 180,
        polarizationIndex: null,
        totalSeconds: 21_600,
        zonePercentages: { z1: 99.2, z2: 0, z3: 0.8 },
        status: "insufficient_data",
        statusLabel: "Not calculated",
        explanation:
          "With zero middle-zone time, Treff’s adjustment requires more than 1% high-zone time.",
      },
      ...weeks.slice(3),
    ],
  },
};
