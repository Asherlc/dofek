import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ClimbingVolumeOverTimeChart } from "./ClimbingVolumeOverTimeChart.tsx";

const meta = {
  title: "Climbing/ClimbingVolumeOverTimeChart",
  component: ClimbingVolumeOverTimeChart,
  args: {
    data: [
      { week: "2026-10-05", attempts: 12, minutes: 120 },
      { week: "2026-10-12", attempts: null, minutes: 90 },
    ],
  },
} satisfies Meta<typeof ClimbingVolumeOverTimeChart>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const TimeSelected: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const metric = within(canvasElement).getByRole("combobox", { name: "Climbing volume metric" });
    await userEvent.selectOptions(metric, "time");
    await expect(metric).toHaveValue("time");
  },
};
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
