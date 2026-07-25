import type { Meta, StoryObj } from "@storybook/react-vite";
import { RecomputeStatusIndicator } from "./RecomputeStatusIndicator.tsx";

const meta = {
  title: "Processing/RecomputeStatusIndicator",
  component: RecomputeStatusIndicator,
  args: {
    label: "Recomputing sleep",
    progress: 60,
    status: "active",
  },
} satisfies Meta<typeof RecomputeStatusIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {};
export const Indeterminate: Story = { args: { progress: null } };
export const Ready: Story = { args: { label: "Sleep is ready", progress: 100, status: "ready" } };
export const Delayed: Story = {
  args: { label: "Sleep recompute delayed", progress: 35, status: "delayed" },
};
export const Failed: Story = {
  args: { label: "Sleep recompute failed", progress: null, status: "failed" },
};
