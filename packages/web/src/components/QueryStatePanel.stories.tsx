import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

const meta = {
  title: "State/QueryStatePanel",
  component: QueryStatePanel,
  args: {
    error: new Error("The server could not load this data right now."),
  },
} satisfies Meta<typeof QueryStatePanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Retryable: Story = {
  args: {
    onRetry: () => {},
    retryLabel: "Retry dashboard data",
  },
};

export const Retrying: Story = {
  args: {
    onRetry: () => {},
    retrying: true,
  },
};
