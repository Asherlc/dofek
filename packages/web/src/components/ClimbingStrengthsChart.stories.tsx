import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ClimbingStrengthsChart } from "./ClimbingStrengthsChart.tsx";
import {
  climbingStrengthsFixture,
  climbingStrengthsSingleClimbFixture,
} from "./climbing-strengths-fixtures.ts";

const panel = climbingStrengthsFixture.panels[0];
if (!panel) throw new Error("Missing fixture");
const meta = {
  title: "Training/ClimbingStrengthsChart",
  component: ClimbingStrengthsChart,
  args: { panel, grade: "V3", view: "gaps", selectedRow: null, onSelectCell: fn() },
} satisfies Meta<typeof ClimbingStrengthsChart>;
export default meta;
type Story = StoryObj<typeof meta>;
export const StyleGaps: Story = {};
export const SuccessCurves: Story = { args: { view: "curves" } };
export const ExposureMap: Story = { args: { view: "exposure" } };
export const GradePyramids: Story = { args: { view: "pyramids" } };
export const Progress: Story = { args: { view: "progress", grade: "V4" } };
export const RadarProfile: Story = { args: { view: "radar" } };
export const SparseRadar: Story = { args: { view: "radar", grade: "V4" } };
export const SingleClimb: Story = {
  args: {
    panel: climbingStrengthsSingleClimbFixture.panels[0],
    view: "radar",
    grade: "All grades",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("Exact values"));
    await expect(canvas.getByText("Sent 1 of 1 climb")).toBeVisible();
    await expect(canvas.getByText("Too few climbs to judge strengths yet")).toBeVisible();
  },
};
export const DenseLongLabels: Story = {
  args: {
    panel: {
      ...panel,
      rows: Array.from({ length: 24 }, (_, index) => ({
        key: `angle-${index}`,
        label: `Recorded wall-angle group with a long source label ${index + 1}`,
        cells: panel.rows[index % panel.rows.length]?.cells ?? [],
      })),
    },
  },
};
