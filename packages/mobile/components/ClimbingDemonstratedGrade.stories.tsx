import type { Meta, StoryObj } from "@storybook/react-native";
import { ClimbingDemonstratedGrade } from "./ClimbingDemonstratedGrade";
import { demonstratedGradeFixture } from "./climbing-demonstrated-grade-fixture";

const meta = {
  title: "Components/ClimbingDemonstratedGrade",
  component: ClimbingDemonstratedGrade,
  args: { data: demonstratedGradeFixture },
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
