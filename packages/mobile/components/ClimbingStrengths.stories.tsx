import type { Meta, StoryObj } from "@storybook/react-native";
import { ClimbingStrengths } from "./ClimbingStrengths";
import { climbingStrengthsFixture } from "./climbing-strengths-fixtures";

const meta = {
  title: "Components/ClimbingStrengths",
  component: ClimbingStrengths,
  args: { data: climbingStrengthsFixture },
} satisfies Meta<typeof ClimbingStrengths>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = { args: { data: undefined, loading: true } };
export const Empty: Story = {
  args: {
    data: { panels: [], coverage: { unknownOutcomes: 0, missingGrades: 0, missingIdentity: 0 } },
  },
};
export const Sparse: Story = {
  args: {
    data: {
      ...climbingStrengthsFixture,
      panels: climbingStrengthsFixture.panels.map((panel) => ({
        ...panel,
        grades: panel.grades.filter((grade) => grade.grade === "V4"),
        rows: panel.rows.map((row) => ({
          ...row,
          cells: row.cells.filter((cell) => cell.grade === "V4"),
        })),
      })),
    },
  },
};
export const Setting: Story = {
  args: {
    data: {
      ...climbingStrengthsFixture,
      panels: climbingStrengthsFixture.panels.filter((panel) => panel.dimension === "setting"),
    },
  },
};

export const MixedUnknownOnlyContext: Story = {
  args: {
    data: {
      ...climbingStrengthsFixture,
      panels: climbingStrengthsFixture.panels.map((panel) =>
        panel.contextKey === "route-yds-lead"
          ? { ...panel, grades: [], rows: [], coverage: { missingTraits: 0, unknownOutcomes: 3 } }
          : panel,
      ),
    },
  },
};
