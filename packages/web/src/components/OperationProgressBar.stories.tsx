import type { Meta, StoryObj } from "@storybook/react-vite";
import { OperationProgressBar, OperationProgressBars } from "./OperationProgressBar.tsx";

const meta = {
  title: "State/OperationProgressBar",
  component: OperationProgressBar,
  decorators: [
    (Story) => (
      <div style={{ width: 360 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    percentage: 45,
    message: "Syncing activities...",
  },
} satisfies Meta<typeof OperationProgressBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Indeterminate: Story = {
  args: {
    percentage: undefined,
    message: "Deleting provider records...",
  },
};

export const Complete: Story = {
  args: {
    percentage: 100,
    message: "Operation complete",
  },
};

export const MultipleOperations: Story = {
  render: () => (
    <OperationProgressBars
      operations={[
        { id: "sync", label: "Provider sync", percentage: 64, message: "Syncing activities..." },
        {
          id: "deletion",
          label: "Provider data deletion",
          message: "Deleting provider records...",
        },
      ]}
    />
  ),
};
