import type { Meta, StoryObj } from "@storybook/react-native";
import { expect, within } from "storybook/test";
import { ClimbingStrengths } from "./ClimbingStrengths";
import {
  climbingStrengthsComparisonFixture,
  climbingStrengthsFixture,
  climbingStrengthsUnknownResultsFixture,
} from "./climbing-strengths-fixtures";

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

export const VisualizationChoices: Story = { args: { data: climbingStrengthsComparisonFixture } };

export const MissingDimensions: Story = {
  args: {
    data: {
      ...climbingStrengthsFixture,
      panels: climbingStrengthsFixture.panels.filter((panel) => panel.dimension === "setting"),
    },
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Wall angle" }));
    await expect(canvas.getByRole("button", { name: "Wall angle" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      canvas.getAllByText("No recorded wall angle observations in this context.").length,
    ).toBeGreaterThan(0);
  },
};

export const UnknownResults: Story = {
  args: { data: climbingStrengthsUnknownResultsFixture },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "V3" }));
    await userEvent.click(canvas.getByRole("button", { name: /^Vertical · Result unknown/ }));
    await expect(canvas.getByText(/V3 · .* · Result unknown/)).toBeVisible();
  },
};
