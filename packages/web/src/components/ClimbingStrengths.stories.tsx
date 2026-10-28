import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "storybook/test";
import { ClimbingStrengths } from "./ClimbingStrengths.tsx";
import {
  climbingStrengthsUnknownResultsFixture,
  climbingStrengthsFixture as fixture,
} from "./climbing-strengths-fixtures.ts";

const meta = {
  title: "Training/ClimbingStrengths",
  component: ClimbingStrengths,
  args: { data: fixture },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-5xl p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ClimbingStrengths>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const UnknownOnly: Story = {
  args: {
    data: {
      ...fixture,
      panels: fixture.panels.map((panel) => ({
        ...panel,
        coverage: { ...panel.coverage, unknownOutcomes: 9 },
        grades: panel.grades.map((grade) => ({
          ...grade,
          unknownOutcomes: 0,
          sends: 0,
          climbs: 0,
          successRate: null,
        })),
        rows: panel.rows.map((row) => ({
          ...row,
          cells: row.cells.map((cell) => ({
            ...cell,
            unknownOutcomes: 0,
            sends: 0,
            climbs: 0,
            successRate: null,
            differencePercentagePoints: null,
            sampleStatus: "no_data" as const,
            examples: [],
          })),
        })),
        progress: panel.progress.map((period) => ({
          ...period,
          rows: period.rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell) => ({
              ...cell,
              unknownOutcomes: 0,
              sends: 0,
              climbs: 0,
              successRate: null,
              sampleStatus: "no_data" as const,
            })),
          })),
        })),
      })),
    },
  },
};
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
        progress: panel.progress.map((period) => ({
          ...period,
          rows: period.rows.map((row) => ({
            ...row,
            cells: row.cells.filter((cell) => cell.grade === "V6"),
          })),
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
          progress: panel.progress.map((period) => ({
            ...period,
            rows: period.rows
              .map((row) => (row.key === "overhang" ? { ...row, key: "outdoor" } : row))
              .filter((row) => row.key !== "slab"),
          })),
          rows: [
            ...panel.rows.slice(0, 1).map((row) => ({ ...row, label: "Indoor" })),
            {
              key: "outdoor",
              label: "Outdoor",
              cells: [
                {
                  grade: "V3",
                  unknownOutcomes: 0,
                  sends: 16,
                  climbs: 20,
                  successRate: 80,
                  differencePercentagePoints: 0,
                  sampleStatus: "available" as const,
                  examples: [],
                },
                {
                  grade: "V4",
                  unknownOutcomes: 0,
                  sends: 0,
                  climbs: 2,
                  successRate: 0,
                  differencePercentagePoints: -37.5,
                  sampleStatus: "limited" as const,
                  examples: [],
                },
                {
                  grade: "V5",
                  unknownOutcomes: 0,
                  sends: 4,
                  climbs: 15,
                  successRate: 26.7,
                  differencePercentagePoints: -3.3,
                  sampleStatus: "available" as const,
                  examples: [],
                },
                {
                  grade: "V6",
                  unknownOutcomes: 0,
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
          contextLabel: "Lead",
          progress: panel.progress.map((period) => ({
            ...period,
            rows: period.rows.map((row) => ({
              ...row,
              cells: row.cells.map((cell, index) => ({
                ...cell,
                grade: ["6a", "6b", "6c", "7a"][index] ?? cell.grade,
              })),
            })),
          })),
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

export const MissingDimension: Story = {
  args: {
    data: {
      ...fixture,
      panels: fixture.panels.filter((panel) => panel.dimension === "wall_angle"),
    },
  },
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Hold type" }));
  },
};

export const UnknownResults: Story = { args: { data: climbingStrengthsUnknownResultsFixture } };

export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};

export const SelectedPoint: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Grades" }));
    await userEvent.click(canvas.getByRole("button", { name: /Vertical · V4/ }));
  },
};

const holdTypes = [
  { key: "crimp", label: "Crimps" },
  { key: "sloper", label: "Slopers" },
  { key: "pinch", label: "Pinches" },
];
export const HoldTypes: Story = {
  args: {
    data: {
      ...fixture,
      panels: fixture.panels.map((panel) => ({
        ...panel,
        dimension: "hold_type",
        rows: panel.rows.map((row, index) => ({ ...row, ...holdTypes[index] })),
        gradeAdjustedStrengths: panel.gradeAdjustedStrengths.map((entry, index) => ({
          ...entry,
          key: holdTypes[index]?.key ?? entry.key,
        })),
        allGrades: {
          ...panel.allGrades,
          rows: panel.allGrades.rows.map((row, index) => ({ ...row, ...holdTypes[index] })),
          progress: panel.allGrades.progress.map((period) => ({
            ...period,
            rows: period.rows.map((row, index) => ({
              ...row,
              key: holdTypes[index]?.key ?? row.key,
            })),
          })),
        },
      })),
    },
  },
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Hold type" }));
  },
};

export const Grades: Story = {
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Grades" }));
  },
};
export const NarrowGrades: Story = {
  ...Narrow,
  play: Grades.play,
};
export const GradesByTypeAndSetting: Story = {
  args: {
    data: {
      ...fixture,
      panels: fixture.panels.flatMap((panel) => [
        panel,
        { ...panel, key: "boulder-outdoor", setting: "outdoor" as const },
        {
          ...panel,
          key: "top-rope-outdoor",
          contextKey: "top-rope",
          contextLabel: "Top rope",
          setting: "outdoor" as const,
          grades: panel.grades.map((grade, index) => ({
            ...grade,
            grade: ["5.8", "5.9", "5.10a", "5.10b"][index] ?? grade.grade,
          })),
          rows: panel.rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell, index) => ({
              ...cell,
              grade: ["5.8", "5.9", "5.10a", "5.10b"][index] ?? cell.grade,
              examples: [],
            })),
          })),
        },
      ]),
    },
  },
  play: Grades.play,
};
export const Progress: Story = {
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Progress" }));
  },
};
