import type { Meta, StoryObj } from "@storybook/react-vite";
import { HealthStatusBar } from "./HealthStatusBar";

const meta = {
  title: "Components/HealthStatusBar",
  component: HealthStatusBar,
  tags: ["autodocs"],
  args: {
    metrics: [
      {
        label: "HRV",
        value: 65,
        avg: 60,
        stddev: 8,
        unit: "ms",
      },
    ],
  },
} satisfies Meta<typeof HealthStatusBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Success: Story = {};

export const Warning: Story = {
  args: {
    metrics: [
      {
        label: "HRV",
        value: 48,
        avg: 60,
        stddev: 8,
        unit: "ms",
      },
    ],
  },
};

export const Destructive: Story = {
  args: {
    metrics: [
      {
        label: "HRV",
        value: 38,
        avg: 60,
        stddev: 8,
        unit: "ms",
      },
    ],
  },
};

export const Unknown: Story = {
  args: {
    metrics: [
      {
        label: "HRV",
        value: null,
        avg: 60,
        stddev: 8,
        unit: "ms",
      },
    ],
  },
};
