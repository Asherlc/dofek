import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

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
  args: {
    variant: "empty",
    message: "No data is available for this time range yet.",
  },
};

export const ErrorState: Story = {
  args: {
    variant: "error",
    message: "The API returned a provider timeout.",
  },
};
