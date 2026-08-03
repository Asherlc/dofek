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

export const ErrorState: Story = {
  name: "Error",
  tags: ["review-scenario", "review-scenario-error"],
};

export const Retryable: Story = {
  args: {
    onRetry: () => {},
    retryLabel: "Retry dashboard data",
  },
};

export const Contextual: Story = {
  args: {
    contextLabel: "Sleep",
    error: new Error("Sleep performance is unavailable."),
  },
};

export const DomainTitle: Story = {
  args: {
    title: "Alert status is unavailable",
    error: new Error("The status service timed out."),
  },
};

export const Retrying: Story = {
  args: {
    onRetry: () => {},
    retrying: true,
  },
};
