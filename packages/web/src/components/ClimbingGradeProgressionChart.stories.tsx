import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClimbingGradeProgressionChart } from "./ClimbingGradeProgressionChart.tsx";
import { climbingProgressionFixture } from "./climbing-progression-test-helpers.ts";

const progression = [
  climbingProgressionFixture(),
  climbingProgressionFixture("route", { ropeMethod: "top_rope" }),
  climbingProgressionFixture("route", { ropeMethod: "lead" }),
  climbingProgressionFixture("route"),
];
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
export const BoulderOnly: Story = { args: { data: progression.slice(0, 1) } };
export const RouteOnly: Story = { args: { data: progression.slice(1) } };
export const AidStyles: Story = {
  args: {
    data: [
      climbingProgressionFixture("route", { ropeMethod: "lead" }),
      climbingProgressionFixture("route", { ropeMethod: "lead", usedAid: true }),
      climbingProgressionFixture("route", { ropeMethod: "lead", usedAid: null }),
    ],
  },
};
export const UnknownCategories: Story = {
  args: {
    data: [
      {
        ...climbingProgressionFixture("route", { ropeMethod: "lead" }),
        settings: ["unknown"],
        periods: climbingProgressionFixture("route", { ropeMethod: "lead" }).periods.map(
          (period) => ({
            ...period,
            settings: period.settings
              .slice(0, 1)
              .map((setting) => ({ ...setting, setting: "unknown", unknownOutcomes: 2 })),
          }),
        ),
      },
    ],
  },
};
export const Sparse: Story = { args: { data: progression.slice(0, 1) } };
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 320 }}>
        <Story />
      </div>
    ),
  ],
};
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
