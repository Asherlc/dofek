import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProviderDisconnectControl } from "./ProviderDisconnectControl";

const meta = {
  title: "Providers/ProviderDisconnectControl",
  component: ProviderDisconnectControl,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="card p-4 inline-flex items-center">
        <Story />
      </div>
    ),
  ],
  args: {
    canDisconnect: true,
    showConfirm: false,
    isPending: false,
    onOpenConfirm: () => {},
    onConfirm: () => {},
    onCancel: () => {},
  },
} satisfies Meta<typeof ProviderDisconnectControl>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Connected: Story = {};

export const Confirming: Story = {
  args: {
    showConfirm: true,
  },
};

export const Disconnecting: Story = {
  args: {
    showConfirm: true,
    isPending: true,
  },
};

export const NotConnected: Story = {
  args: {
    canDisconnect: false,
  },
};
