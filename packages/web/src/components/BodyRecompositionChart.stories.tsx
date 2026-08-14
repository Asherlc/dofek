import { formatDateYmd } from "@dofek/format/format";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { BodyRecompositionRow } from "../../../server/src/routers/body-analytics.ts";
import { UnitContext } from "../lib/unitContext.ts";
import { BodyRecompositionChart } from "./BodyRecompositionChart.tsx";

function generateRecompositionData(): BodyRecompositionRow[] {
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
      smoothedFatMass: Math.round((fatMassKg + Math.sin(index / 6) * 0.2) * 100) / 100,
      smoothedLeanMass: Math.round((leanMassKg + Math.cos(index / 8) * 0.2) * 100) / 100,
    };
  });
}

const meta = {
  title: "Body/BodyRecompositionChart",
  component: BodyRecompositionChart,
  tags: ["autodocs"],
  args: {
    data: generateRecompositionData(),
  },
} satisfies Meta<typeof BodyRecompositionChart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Imperial: Story = {
  decorators: [
    (Story) => (
      <UnitContext.Provider value={{ unitSystem: "imperial", setUnitSystem: () => {} }}>
        <Story />
      </UnitContext.Provider>
    ),
  ],
};

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
