import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClimbingDemonstratedGrade } from "./ClimbingDemonstratedGrade.tsx";
import { demonstratedGradeFixture } from "./climbing-demonstrated-grade-fixture.ts";

const meta = {
  title: "Training/ClimbingDemonstratedGrade",
  component: ClimbingDemonstratedGrade,
  args: { data: demonstratedGradeFixture },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ClimbingDemonstratedGrade>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const PartialCoverage: Story = {
  args: {
    data: {
      ...demonstratedGradeFixture,
      coverage: { fullWindow: false, startDate: "2026-10-01", endDate: "2026-11-21" },
    },
  },
};

export const InaccessibleWindow: Story = {
  args: {
    data: {
      ...demonstratedGradeFixture,
      coverage: { fullWindow: false, startDate: null, endDate: null },
    },
  },
};

export const NoEvidence: Story = {
  args: {
    data: {
      ...demonstratedGradeFixture,
      cells: demonstratedGradeFixture.cells.map((cell) => ({ ...cell, grades: [] })),
    },
  },
};

export const Loading: Story = { args: { data: undefined, loading: true } };

export const RefreshError: Story = {
  args: { data: demonstratedGradeFixture, error: new Error("Demonstrated grades unavailable") },
};
