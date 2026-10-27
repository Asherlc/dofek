import { formatDateYmd } from "@dofek/format/format";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SmoothedBodyFatRow } from "../../../server/src/routers/body-analytics.ts";
import { UnitContext } from "../lib/unitContext.ts";
import { BodyFatPercentageChart } from "./BodyFatPercentageChart.tsx";

function generateBodyFatData(): SmoothedBodyFatRow[] {
  return Array.from({ length: 90 }, (_, index) => {
    const date = formatDateYmd(new Date(2026, 1, 1 + index));
    const bodyFatPct = 24 - index * 0.035;
    return {
      date,
      rawBodyFatPct: bodyFatPct + Math.sin(index) * 0.3,
      rawBodyFatStatus: { kind: "observed", label: "Observed" },
      smoothedBodyFatPct: bodyFatPct,
      smoothedBodyFatStatus: { kind: "estimated", label: "Estimated" },
      weeklyChange: null,
      interpolated: false,
    };
  });
}

const meta = {
  title: "Body/BodyFatPercentageChart",
  component: BodyFatPercentageChart,
  tags: ["autodocs"],
  args: {
    data: generateBodyFatData(),
    prediction: {
      ratePerWeek: -0.25,
      rateConfidence: 0.9,
      periodDeltas: { days7: -0.25, days14: -0.5, days30: -1 },
      projectionLine: Array.from({ length: 14 }, (_, index) => ({
        date: formatDateYmd(new Date(2026, 4, 2 + index)),
        projectedBodyFatPct: 20.85 - index * 0.035,
      })),
    },
  },
  decorators: [
    (Story) => (
      <UnitContext.Provider value={{ unitSystem: "imperial", setUnitSystem: () => {} }}>
        <Story />
      </UnitContext.Provider>
    ),
  ],
} satisfies Meta<typeof BodyFatPercentageChart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: {
    loading: true,
  },
};

export const Empty: Story = {
  args: {
    data: [],
  },
};
