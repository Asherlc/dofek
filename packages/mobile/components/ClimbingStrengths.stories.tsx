import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
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
export const Narrow: Story = {
  args: {
    data: {
      ...climbingStrengthsComparisonFixture,
      panels: climbingStrengthsComparisonFixture.panels,
    },
  },
  decorators: [
    (Story) => (
      <View style={{ width: 340, alignSelf: "center" }}>
        <Story />
      </View>
    ),
  ],
};
export const Loading: Story = { args: { data: undefined, loading: true } };
export const Empty: Story = {
  args: {
    data: { panels: [], coverage: { unknownOutcomes: 0, missingGrades: 0, missingIdentity: 0 } },
  },
};
export const MissingObservations: Story = {
  args: {
    data: {
      ...climbingStrengthsFixture,
      panels: climbingStrengthsFixture.panels.map((panel) => ({ ...panel, rows: [] })),
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
    await userEvent.click(
      canvas.getByRole("button", { name: "View Strengths and weaknesses data" }),
    );
    await userEvent.click(canvas.getByRole("button", { name: /^Vertical · All grades:/ }));
    await expect(canvas.getByText(/V3 · .* · Result unknown/)).toBeVisible();
  },
};

const holdTypes = [
  { key: "crimp", label: "Crimps" },
  { key: "sloper", label: "Slopers" },
  { key: "pinch", label: "Pinches" },
];
export const HoldTypes: Story = {
  ...Narrow,
  args: {
    data: {
      ...climbingStrengthsComparisonFixture,
      panels: climbingStrengthsComparisonFixture.panels.map((panel) => ({
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
  ...Narrow,
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Progress" }));
  },
};
