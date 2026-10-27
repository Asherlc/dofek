import type { ClimbingFilters as Filters } from "@dofek/training/climbing-filters";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, within } from "storybook/test";
import { ClimbingFilters } from "./ClimbingFilters.tsx";
import { ClimbingVolumeOverTimeChart } from "./ClimbingVolumeOverTimeChart.tsx";

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
  args: { value: { types: ["lead"], setting: ["outdoor"] } },
};
export const CustomSelection: Story = {
  args: { value: { climbKind: "route", ropeMethod: "follow", solo: false, setting: ["unknown"] } },
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
    await userEvent.click(canvas.getByRole("button", { name: "Filters" }));
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(page.getByRole("checkbox", { name: "Top rope" }));
    await userEvent.click(page.getByRole("checkbox", { name: "Unknown setting" }));
    await expect(page.getByRole("checkbox", { name: "All settings" })).toBePartiallyChecked();
    await userEvent.click(page.getByRole("button", { name: "Done" }));
    await expect(canvas.getByText("Bouldering + Lead · Indoor + Outdoor")).toBeVisible();
  },
};
export const OpenPopover: Story = {
  args: { value: { types: ["bouldering", "lead"], setting: ["indoor", "outdoor"] } },
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Filters" }));
  },
};
export const OverChart: Story = {
  render: function OverChart(args) {
    const [value, onChange] = useState<Filters>(args.value);
    return (
      <div className="w-full max-w-3xl space-y-4 p-4">
        <ClimbingFilters value={value} onChange={onChange} />
        <ClimbingVolumeOverTimeChart
          data={[
            { week: "2026-10-05", attempts: 12, minutes: 120 },
            { week: "2026-10-12", attempts: 24, minutes: 90 },
          ]}
        />
      </div>
    );
  },
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Filters" }));
    const page = within(canvasElement.ownerDocument.body);
    const panel = page.getByRole("dialog", { name: "Climbing filters" });
    await expect(panel).toBeVisible();
    await expect(getComputedStyle(panel).backgroundColor).toMatch(/^rgb\(/);
  },
};
