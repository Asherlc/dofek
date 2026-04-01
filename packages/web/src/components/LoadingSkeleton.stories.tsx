import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChartLoadingSkeleton } from "./LoadingSkeleton";

const meta = {
  title: "Feedback/LoadingSkeleton",
  component: ChartLoadingSkeleton,
  tags: ["autodocs"],
  args: {
    height: 200,
  },
} satisfies Meta<typeof ChartLoadingSkeleton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Tall: Story = {
  args: {
    height: 400,
  },
};
