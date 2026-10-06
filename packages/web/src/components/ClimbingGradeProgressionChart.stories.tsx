import { gradeSortValue } from "@dofek/training/climbing-grades";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ClimbingGradeProgressionRow } from "dofek-server/types";
import { ClimbingGradeProgressionChart } from "./ClimbingGradeProgressionChart.tsx";

function progressionRow(
  date: string,
  climbType: ClimbingGradeProgressionRow["climbType"],
  grade: string,
): ClimbingGradeProgressionRow {
  const gradeSystem = climbType === "boulder" ? "v_scale" : "yds";
  const score = gradeSortValue(grade, gradeSystem);
  if (score === null) throw new Error(`Invalid fixture grade: ${grade}`);
  return { date, climbType, gradeSystem, grade, gradeSortValue: score };
}

const progressionRows = [
  progressionRow("2026-07-01", "boulder", "V2"),
  progressionRow("2026-07-08", "boulder", "V3"),
  progressionRow("2026-07-15", "boulder", "V4"),
  progressionRow("2026-07-22", "boulder", "V3"),
  progressionRow("2026-07-29", "boulder", "V5"),
  progressionRow("2026-07-01", "route", "5.9"),
  progressionRow("2026-07-08", "route", "5.10a"),
  progressionRow("2026-07-15", "route", "5.10c"),
  progressionRow("2026-07-22", "route", "5.10b"),
  progressionRow("2026-07-29", "route", "5.11a"),
];

const meta = {
  title: "Components/ClimbingGradeProgressionChart",
  component: ClimbingGradeProgressionChart,
  tags: ["autodocs"],
  args: { data: progressionRows, loading: false },
  decorators: [
    (Story) => (
      <div style={{ width: "min(640px, calc(100vw - 32px))", maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ClimbingGradeProgressionChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const BoulderOnly: Story = {
  args: { data: progressionRows.filter((row) => row.climbType === "boulder") },
};
export const RouteOnly: Story = {
  args: { data: progressionRows.filter((row) => row.climbType === "route") },
};
export const Sparse: Story = {
  args: {
    data: [
      progressionRow("2026-07-01", "boulder", "V4"),
      progressionRow("2026-07-29", "route", "5.10a"),
    ],
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
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
