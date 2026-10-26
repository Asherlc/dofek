import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ClimbingStrengths } from "./ClimbingStrengths.tsx";
import { climbingStrengthsFixture } from "./climbing-strengths-fixtures.ts";

const meta = {
  title: "Design explorations/Climbing all grades",
  component: ClimbingStrengths,
  args: { data: climbingStrengthsFixture },
  decorators: [
    (Story) => (
      <div className="w-full max-w-5xl p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ClimbingStrengths>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Combined: Story = {
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.selectOptions(within(canvasElement).getByLabelText("View"), "gaps");
  },
};
export const GradeSelection: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByLabelText("View"), "gaps");
    await expect(canvas.getByLabelText("Grade")).toHaveValue("All grades");
    await userEvent.click(canvas.getByText("Exact values"));
    await expect(canvas.getByRole("button", { name: /Vertical · All grades · 62%/ })).toBeVisible();
    await userEvent.selectOptions(canvas.getByLabelText("Grade"), "V4");
    await expect(canvas.getByRole("button", { name: /Vertical · V4 · 50%/ })).toBeVisible();
    await userEvent.selectOptions(canvas.getByLabelText("Grade"), "All grades");
    await userEvent.click(canvas.getByRole("button", { name: /Vertical · All grades · 62%/ }));
    await expect(canvas.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
      "13 sends / 21 climbs",
    );
  },
};
