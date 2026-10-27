import type { Meta, StoryObj } from "@storybook/react-vite";
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
export const Empty: Story = { args: { data: [] } };
