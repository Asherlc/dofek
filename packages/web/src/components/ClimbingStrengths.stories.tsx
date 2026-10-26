import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClimbingStrengths } from "./ClimbingStrengths.tsx";
import { climbingStrengthsFixture as fixture } from "./climbing-strengths-fixtures.ts";

const meta = {
  title: "Training/ClimbingStrengths",
  component: ClimbingStrengths,
  args: { data: fixture },
} satisfies Meta<typeof ClimbingStrengths>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = { args: { data: undefined, loading: true } };
export const Empty: Story = { args: { data: { ...fixture, panels: [] } } };
export const Sparse: Story = {
  args: {
    data: {
      ...fixture,
      panels: fixture.panels.map((panel) => ({
        ...panel,
        grades: panel.grades.filter((grade) => grade.grade === "V6"),
        rows: panel.rows.map((row) => ({
          ...row,
          cells: row.cells.filter((cell) => cell.grade === "V6"),
        })),
      })),
    },
  },
};
export const SettingsAndContexts: Story = {
  args: {
    data: {
      ...fixture,
      panels: fixture.panels.flatMap((panel) => [
        panel,
        {
          ...panel,
          key: "hold-indoor",
          dimension: "hold_type" as const,
          rows: panel.rows.map((row) => ({
            ...row,
            label: row.key === "vertical" ? "Crimp" : row.key === "overhang" ? "Sloper" : "Jug",
          })),
        },
        { ...panel, key: "angle-outdoor", setting: "outdoor" as const },
        {
          ...panel,
          key: "setting",
          dimension: "setting" as const,
          setting: null,
          rows: [
            ...panel.rows.slice(0, 1).map((row) => ({ ...row, label: "Indoor" })),
            {
              key: "outdoor",
              label: "Outdoor",
              cells: [
                {
                  grade: "V3",
                  sends: 16,
                  climbs: 20,
                  successRate: 80,
                  differencePercentagePoints: 0,
                  sampleStatus: "available" as const,
                  examples: [],
                },
                {
                  grade: "V4",
                  sends: 0,
                  climbs: 2,
                  successRate: 0,
                  differencePercentagePoints: -37.5,
                  sampleStatus: "limited" as const,
                  examples: [],
                },
                {
                  grade: "V5",
                  sends: 4,
                  climbs: 15,
                  successRate: 26.7,
                  differencePercentagePoints: -3.3,
                  sampleStatus: "available" as const,
                  examples: [],
                },
                {
                  grade: "V6",
                  sends: 1,
                  climbs: 5,
                  successRate: 20,
                  differencePercentagePoints: 0,
                  sampleStatus: "available" as const,
                  examples: [],
                },
              ],
            },
          ],
        },
        {
          ...panel,
          key: "routes",
          contextKey: "routes",
          contextLabel: "Routes · Lead · French",
          grades: panel.grades.map((grade, index) => ({
            ...grade,
            grade: ["6a", "6b", "6c", "7a"][index] ?? grade.grade,
          })),
          rows: panel.rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell, index) => ({
              ...cell,
              grade: ["6a", "6b", "6c", "7a"][index] ?? cell.grade,
              examples: cell.examples.map((example) => ({ ...example, grade: "6b" })),
            })),
          })),
        },
      ]),
    },
  },
};
