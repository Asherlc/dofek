import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "storybook/test";
import { ClimbingStrengths } from "./ClimbingStrengths.tsx";
import {
  climbingStrengthsSparseTagsFixture,
  climbingStrengthsTagsFixture,
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
        coverage: { ...panel.coverage, missingTraits: 40 },
        rows: panel.rows.filter((row) => row.key === "slab"),
        gradeAdjustedStrengths: panel.gradeAdjustedStrengths.filter((row) => row.key === "slab"),
        allGrades: {
          ...panel.allGrades,
          rows: panel.allGrades.rows.filter((row) => row.key === "slab"),
        },
        progress: panel.progress.map((period) => ({
          ...period,
          rows: period.rows.filter((row) => row.key === "slab"),
        })),
      })),
    },
  },
};
export const MissingHoldTypes: Story = {
  args: {
    data: {
      ...fixture,
      panels: fixture.panels.map((panel) => ({
        ...panel,
        dimension: "hold_type",
        coverage: { ...panel.coverage, missingTraits: 63 },
        rows: [],
        allGrades: { ...panel.allGrades, rows: [] },
      })),
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
    await userEvent.click(canvas.getByText("Exact values"));
    await userEvent.click(canvas.getByRole("button", { name: /^Vertical · Sent/ }));
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

export const Progress: Story = {
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Progress" }));
  },
};

export const SourceCategories: Story = {
  args: { data: climbingStrengthsTagsFixture },
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Kaya · Movement" }));
  },
};
export const SparseUnknownSourceTags: Story = {
  args: { data: climbingStrengthsSparseTagsFixture },
};
