import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryStatePanel } from "./QueryStatePanel";

const meta = {
  title: "State/QueryStatePanel",
  component: QueryStatePanel,
  args: {
    variant: "error",
    message: "The server could not load this data right now.",
  },
} satisfies Meta<typeof QueryStatePanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: {
    variant: "loading",
    message: "Loading",
  },
};

export const Empty: Story = {
  name: "Empty data",
  tags: ["review-scenario", "review-scenario-empty-data"],
  args: {
    variant: "empty",
    message: "No data is available for this time range yet.",
  },
};

export const ErrorState: Story = {
  name: "Error",
  tags: ["review-scenario", "review-scenario-error"],
  args: {
    variant: "error",
    message: "The API returned a provider timeout.",
  },
};

export const Retryable: Story = {
  args: {
    variant: "error",
    message: "The API returned a provider timeout.",
    onRetry: () => {},
    retryLabel: "Retry provider",
  },
};
