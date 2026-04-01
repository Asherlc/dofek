import type { Meta, StoryObj } from "@storybook/react-vite";
import { HealthStatusBar } from "./HealthStatusBar";

const meta = {
  title: "Components/HealthStatusBar",
  component: HealthStatusBar,
  tags: ["autodocs"],
  args: {
    label: "HRV",
    value: "65 ms",
    percent: 75,
    color: "hsl(var(--success))",
  },
} satisfies Meta<typeof HealthStatusBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Success: Story = {};

export const Warning: Story = {
  args: {
    color: "hsl(var(--warning))",
    percent: 45,
  },
};

export const Destructive: Story = {
  args: {
    color: "hsl(var(--destructive))",
    percent: 15,
  },
};
