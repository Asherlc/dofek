import type { Meta, StoryObj } from "@storybook/react-native";
import { RecomputeStatusIndicator } from "./RecomputeStatusIndicator";

const meta = {
  title: "State/RecomputeStatusIndicator",
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

export const Indeterminate: Story = {
  args: {
    progress: null,
    status: "waiting",
  },
};

export const Delayed: Story = {
  args: {
    progress: 40,
    status: "delayed",
  },
};

export const Failed: Story = {
  args: {
    progress: 40,
    status: "failed",
  },
};

export const Complete: Story = {
  args: {
    progress: 100,
    status: "ready",
  },
};
