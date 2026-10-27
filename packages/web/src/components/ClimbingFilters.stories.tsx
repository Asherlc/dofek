import type { ClimbingFilters as Filters } from "@dofek/training/climbing-filters";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, within } from "storybook/test";
import { ClimbingFilters } from "./ClimbingFilters.tsx";

const meta = {
  title: "Training/ClimbingFilters",
  component: ClimbingFilters,
  args: { value: {}, onChange: () => {} },
  render: function Controlled(args) {
    const [value, onChange] = useState<Filters>(args.value);
    return (
      <div className="w-full max-w-3xl p-4">
        <ClimbingFilters value={value} onChange={onChange} />
      </div>
    );
  },
} satisfies Meta<typeof ClimbingFilters>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const OutdoorLead: Story = {
  args: { value: { climbKind: "route", ropeMethod: "lead", setting: "outdoor" } },
};
export const CustomSelection: Story = {
  args: { value: { climbKind: "route", ropeMethod: "follow", solo: false, setting: "unknown" } },
};
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div className="max-w-[340px]">
        <Story />
      </div>
    ),
  ],
};
export const ContextInteraction: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Bouldering" }));
    await userEvent.click(canvas.getByRole("button", { name: "Outdoor" }));
    await userEvent.click(canvas.getByRole("button", { name: "Lead" }));
    await expect(canvas.getByRole("button", { name: "Lead" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(canvas.getByRole("button", { name: "Outdoor" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};
