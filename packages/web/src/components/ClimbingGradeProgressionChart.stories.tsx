import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClimbingGradeProgressionChart } from "./ClimbingGradeProgressionChart.tsx";
import { climbingProgressionFixture } from "./climbing-progression-test-helpers.ts";

const progression = climbingProgressionFixture();
const meta = {
  title: "Components/ClimbingGradeProgressionChart",
  component: ClimbingGradeProgressionChart,
  tags: ["autodocs"],
  args: { data: progression, loading: false },
  decorators: [
    (Story) => (
      <div
        className="card p-4"
        style={{ width: "min(736px, calc(100vw - 32px))", maxWidth: "100%" }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ClimbingGradeProgressionChart>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const SinglePeriod: Story = {
  args: { data: { ...progression, periods: progression.periods.slice(0, 1) } },
};
export const Sparse: Story = {
  args: { data: { ...progression, periods: progression.periods.slice(1) } },
};
export const UnknownOutcomes: Story = {
  args: {
    data: {
      ...progression,
      periods: progression.periods.map((period) => ({ ...period, unknownOutcomes: 2 })),
    },
  },
};
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 320 }}>
        <Story />
      </div>
    ),
  ],
};
export const Loading: Story = { args: { data: null, loading: true } };
export const Empty: Story = { args: { data: null } };
