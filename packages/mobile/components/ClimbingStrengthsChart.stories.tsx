import type { Meta, StoryObj } from "@storybook/react-native";
import { ClimbingStrengthsChart } from "./ClimbingStrengthsChart";
import {
  climbingStrengthsComparisonFixture,
  climbingStrengthsFixture,
} from "./climbing-strengths-fixtures";

const panel = climbingStrengthsComparisonFixture.panels[0];
const sparsePanel = climbingStrengthsFixture.panels[0];
if (!panel || !sparsePanel) throw new Error("Missing climbing strengths fixture");
const meta = {
  title: "Components/ClimbingStrengthsChart",
  component: ClimbingStrengthsChart,
  args: { panel, view: "gaps", grade: "V3", onSelect: () => {} },
} satisfies Meta<typeof ClimbingStrengthsChart>;
export default meta;
type Story = StoryObj<typeof meta>;
export const StyleGaps: Story = {};
export const SuccessCurves: Story = { args: { view: "curves" } };
export const ExposureMap: Story = { args: { view: "exposure" } };
export const GradePyramids: Story = { args: { view: "pyramids" } };
export const Progress: Story = { args: { view: "progress" } };
export const RadarProfile: Story = { args: { view: "radar" } };
export const RadarInsufficientGroups: Story = {
  args: { view: "radar", panel: sparsePanel, grade: "V4" },
};
export const SingleGradeAndMonth: Story = {
  args: {
    view: "progress",
    panel: {
      ...panel,
      grades: panel.grades.slice(0, 1),
      rows: panel.rows.map((row) => ({ ...row, cells: row.cells.slice(0, 1) })),
      progress: panel.progress.slice(-1).map((month) => ({
        ...month,
        rows: month.rows.map((row) => ({ ...row, cells: row.cells.slice(0, 1) })),
      })),
    },
  },
};
export const DenseAngles: Story = {
  args: {
    view: "radar",
    panel: {
      ...panel,
      rows: Array.from({ length: 20 }, (_, index) => ({
        ...sparsePanel.rows[0],
        key: `angle-${index}`,
        label: `${index * 5}°`,
      })),
    },
  },
};
