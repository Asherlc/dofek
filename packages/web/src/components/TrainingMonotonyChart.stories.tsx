import type { Meta, StoryObj } from "@storybook/react-vite";
import type { TrainingMonotonyWeek } from "dofek-server/types";
import { TrainingMonotonyChart } from "./TrainingMonotonyChart.tsx";

const weeks: TrainingMonotonyWeek[] = [
  { week: "2026-04-27", monotony: 1.1, strain: 1_120, weeklyLoad: 1_018 },
  { week: "2026-05-04", monotony: 1.35, strain: 1_420, weeklyLoad: 1_052 },
  { week: "2026-05-11", monotony: 2.18, strain: 2_460, weeklyLoad: 1_128 },
  { week: "2026-05-18", monotony: 1.52, strain: 1_760, weeklyLoad: 1_158 },
  { week: "2026-05-25", monotony: 1.28, strain: 1_510, weeklyLoad: 1_180 },
];

const meta = {
  title: "Training/TrainingMonotonyChart",
  component: TrainingMonotonyChart,
  tags: ["autodocs"],
  args: { data: weeks },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TrainingMonotonyChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
export const SustainedHighMonotony: Story = {
  args: {
    data: weeks.map((week, index) => ({
      ...week,
      monotony: 2.1 + index * 0.12,
      strain: 2_200 + index * 180,
    })),
  },
};
