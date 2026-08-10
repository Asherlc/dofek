import { formatDateYmd } from "@dofek/format/format";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { BodyRecompositionRow } from "../../../server/src/routers/body-analytics.ts";
import { UnitContext } from "../lib/unitContext.ts";
import { BodyFatPercentageChart } from "./BodyFatPercentageChart.tsx";

function generateBodyFatData(): BodyRecompositionRow[] {
  return Array.from({ length: 90 }, (_, index) => {
    const date = formatDateYmd(new Date(2026, 1, 1 + index));
    const weightKg = 82 - index * 0.02;
    const bodyFatPct = 24 - index * 0.035;
    const fatMassKg = weightKg * (bodyFatPct / 100);
    const leanMassKg = weightKg - fatMassKg;
    return {
      date,
      weightKg,
      bodyFatPct,
      fatMassKg,
      leanMassKg,
      smoothedFatMass: fatMassKg,
      smoothedLeanMass: leanMassKg,
    };
  });
}

const meta = {
  title: "Body/BodyFatPercentageChart",
  component: BodyFatPercentageChart,
  tags: ["autodocs"],
  args: {
    data: generateBodyFatData(),
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
