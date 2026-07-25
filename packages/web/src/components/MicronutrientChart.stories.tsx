import type { Meta, StoryObj } from "@storybook/react-vite";
import type { MicronutrientAdequacyRow } from "../../../server/src/routers/nutrition-analytics.ts";
import { MicronutrientChart } from "./MicronutrientChart.tsx";

const data: MicronutrientAdequacyRow[] = [
  { nutrient: "Vitamin D", unit: "mcg", rda: 15, avgIntake: 6, percentRda: 40, daysTracked: 28 },
  { nutrient: "Magnesium", unit: "mg", rda: 420, avgIntake: 315, percentRda: 75, daysTracked: 28 },
  { nutrient: "Vitamin C", unit: "mg", rda: 90, avgIntake: 108, percentRda: 120, daysTracked: 28 },
];

const meta = {
  title: "Nutrition/MicronutrientChart",
  component: MicronutrientChart,
  args: { data },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MicronutrientChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { loading: true } };
export const Empty: Story = { args: { data: [] } };
